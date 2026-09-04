/**
 * Plan -> SQL compiler.
 *
 * The model writes a plan. This writes the SQL. That separation is the whole
 * design: a validated plan is compiled deterministically, so the same plan
 * always produces the same query, plans are cacheable and diffable, and there
 * is no path by which model output becomes executable code.
 *
 * SAFETY
 * ------
 * No model-produced string is ever interpolated into SQL.
 *   - `census_code` comes from attribute_source, looked up by attr_id during
 *     validation. It is not the model's string.
 *   - every literal (value, limit, scale) is a bound parameter.
 *   - operators and aggregate functions are mapped through closed allow-lists,
 *     never concatenated.
 *   - step ids become CTE names, so they are checked against a strict pattern.
 *
 * SHAPE
 * -----
 * Each step becomes one CTE over a common (fips, value) contract, which is what
 * keeps composition simple. The final SELECT joins to county_geom for names and
 * geometry.
 */

// Closed allow-lists. Membership is checked; the value is never taken from the
// model's text directly.
// Upper bound on returned rows. Must exceed the 3,233 US counties so a
// county-level map is complete; 5,000 leaves room without being unbounded.
// Values-only payload for a full county result is ~230 KB.
const MAX_RESULT_ROWS = Number(process.env.MAX_RESULT_ROWS ?? 5000);

const { toFipsPrefixes } = require("../states");

const OPERATORS = { "<": "<", "<=": "<=", ">": ">", ">=": ">=", "=": "=", "!=": "<>" };
const AGGREGATES = { mean: "AVG", sum: "SUM", count: "COUNT", min: "MIN", max: "MAX" };
// Step ids are ours to constrain, and short by convention.
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;

// Database identifiers are NOT ours to constrain: the geospatial ETL derives
// table names from source filenames, e.g.
//   c862525677cf485a84b2ba86a78e277d_histtornadotracks   (50 chars)
// A 31-char cap rejected legitimate tables as "unsafe". Postgres' own limit is
// NAMEDATALEN-1 = 63, which is the right bound -- still a strict allow-list,
// just not an arbitrarily tighter one than the database itself uses.
const SAFE_DB_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

class CompileError extends Error {}

function cte(id) {
  if (!SAFE_ID.test(id)) throw new CompileError(`unsafe step id: ${JSON.stringify(id)}`);
  return `step_${id}`;
}

/** Cap on individual features returned by select_features. */
const MAX_FEATURES = Number(process.env.MAX_FEATURES ?? 3000);

/** Columns an attribute filter may name. Mirrors FILTERABLE_COLUMNS server-side. */
const FILTERABLE_COLUMNS = ["type", "status", "owner"];

/** Boundary kinds held in place_geom. Mirrors the schema enum. */
const PLACE_KINDS = ["place", "zcta", "cbsa", "urban"];

/**
 * Minimum share of the smaller geometry that must overlap for a county to count
 * as "in" a named boundary. See the filter_place case for the measurements.
 */
const PLACE_OVERLAP_MIN = Number(process.env.PLACE_OVERLAP_MIN ?? 0.01);

/**
 * SQL predicates for a step's attribute_filters, as `alias.col = $n` fragments.
 *
 * Column names come from a fixed allow-list, never from the model's string --
 * `f.${col}` is only ever interpolated after membership is confirmed. Values
 * are bound, and the validator has already normalized them to the layer's own
 * spelling, so an exact `=` is correct here and cheaper than ILIKE.
 */
function attributeFilterSql(step, alias, bind) {
  const out = [];
  for (const f of step.attribute_filters || []) {
    if (!FILTERABLE_COLUMNS.includes(f.column)) {
      throw new CompileError(`unsupported filter column ${f.column}`);
    }
    out.push(`${alias}.${f.column} = ${bind(f.value)}`);
  }
  return out;
}

/**
 * Compile a `select_features` plan: the individual locations, not a per-county
 * number.
 *
 * This is a SECOND RESULT SHAPE and it is deliberately kept separate rather
 * than bolted onto the CTE chain. Everything else in this compiler produces
 * (fips, value) and composes -- normalize, rank, per_area all rely on that.
 * Features have their own geometry, their own labels, and no county key, so
 * they compose with none of it. Pretending otherwise would mean every
 * downstream op needing a "unless it's features" branch.
 *
 * The validator enforces the corresponding rule: a select_features plan is
 * exactly that step followed by output.
 */
function compileFeatureSelect(step, resolved) {
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };

  const src = resolved.get(step.attr_id);
  if (!src) throw new CompileError(`unresolved attr_id ${step.attr_id}`);
  if (src.source_kind !== "feature_table") {
    throw new CompileError(
      `${step.attr_id} is a per-county value series, not mappable locations`);
  }
  const geom = src.geom_column || "geom";
  if (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(geom)) {
    throw new CompileError(`unsafe identifier in attribute_source for ${step.attr_id}`);
  }

  // Only select label columns this layer actually has. Coverage is patchy --
  // `name` exists on 49% of layers, `city` on 41% -- so a fixed SELECT list
  // would fail on half of them.
  const available = new Set(
    (src.label_columns || []).filter(c => SAFE_DB_IDENT.test(c)));
  const labels = ["name", "city", "state", "county", "address", "type", "status"]
    .filter(c => available.has(c));

  const selected = labels.map(c => `f.${c}::text AS ${c}`).join(", ");
  const where = [];
  const joins = [];

  if (Array.isArray(step.states) && step.states.length) {
    const { codes, unknown } = toFipsPrefixes(step.states);
    if (unknown.length) throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
    // Spatial rather than by the layer's own `state` column: only 54% of layers
    // have one, and a point's containing county is authoritative regardless.
    joins.push(`JOIN county_geom c ON ST_Intersects(c.geom, f.${geom})`);
    where.push(`LEFT(c.fips, 2) IN (${codes.map(c => bind(c)).join(", ")})`);
  }

  if (step.city) {
    if (!available.has("city")) {
      throw new CompileError(
        `this dataset has no city column, so it cannot be filtered to ` +
        `"${step.city}". Restrict by state instead.`);
    }
    // Case-insensitive exact match: ILIKE with no wildcards, so "Springfield"
    // does not also return "Springfield Gardens".
    where.push(`f.city ILIKE ${bind(step.city)}`);
  }

  where.push(...attributeFilterSql(step, "f", bind));

  const limit = Number.isInteger(step.limit) && step.limit > 0
    ? Math.min(step.limit, MAX_FEATURES) : MAX_FEATURES;

  const sql =
    `SELECT ST_AsGeoJSON(f.${geom}) AS geometry` +
    (selected ? `, ${selected}` : "") + `\n` +
    `FROM ${src.table_name} f\n` +
    (joins.length ? joins.join("\n") + "\n" : "") +
    (where.length ? `WHERE ${where.join(" AND ")}\n` : "") +
    `LIMIT ${limit}`;

  return { sql, params, finalStep: step.id, mode: "features", labels };
}

/**
 * @param plan      validated plan
 * @param resolved  Map<attr_id, {census_code, source_kind, table_name, value_column}>
 * @returns {{sql: string, params: any[], finalStep: string, mode: string}}
 */
function compilePlan(plan, resolved) {
  const featureStep = (plan.steps || []).find(s => s.op === "select_features");
  if (featureStep) return compileFeatureSelect(featureStep, resolved);

  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const parts = [];
  let last = null;

  /**
   * Resolve a label to a feature table, with the same identifier checks the
   * count_features case applies. Identifiers come from attribute_source, which
   * only the ETL writes -- never from the model -- and are pattern-checked
   * anyway before they are interpolated.
   */
  const featureSource = (attrId, field = "attr_id") => {
    const src = resolved.get(attrId);
    if (!src) throw new CompileError(`unresolved ${field} ${attrId}`);
    if (src.source_kind !== "feature_table") {
      throw new CompileError(`${attrId} is not a feature table`);
    }
    const geom = src.geom_column || "geom";
    if (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(geom)) {
      throw new CompileError(`unsafe identifier in attribute_source for ${attrId}`);
    }
    return { table: src.table_name, geom };
  };

  for (const st of plan.steps) {
    const name = cte(st.id);
    const ins = (st.inputs || []).map(cte);

    switch (st.op) {
      case "load": {
        const src = resolved.get(st.attr_id);
        if (!src) throw new CompileError(`unresolved attr_id ${st.attr_id}`);
        if (src.source_kind === "acs_long") {
          parts.push(
            `${name} AS (SELECT fips, value FROM acs_county_values ` +
            `WHERE census_code = ${bind(src.census_code)})`);
        } else if (src.source_kind === "table_column") {
          // Identifiers here come from attribute_source, a table only the ETL
          // writes -- never from the model. Still pattern-checked.
          if (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(src.value_column)) {
            throw new CompileError(`unsafe identifier in attribute_source for ${st.attr_id}`);
          }
          parts.push(
            `${name} AS (SELECT fips, ${src.value_column}::double precision AS value ` +
            `FROM ${src.table_name})`);
        } else {
          throw new CompileError(`unknown source_kind ${src.source_kind}`);
        }
        break;
      }

      case "count_features": {
        const src = resolved.get(st.attr_id);
        if (!src) throw new CompileError(`unresolved attr_id ${st.attr_id}`);
        if (src.source_kind !== "feature_table") {
          throw new CompileError(`${st.attr_id} is not a feature table`);
        }
        // Identifiers come from attribute_source (ETL-written, never model
        // output), and are still pattern-checked before interpolation.
        if (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(src.geom_column || "geom")) {
          throw new CompileError(`unsafe identifier in attribute_source for ${st.attr_id}`);
        }
        const geom = src.geom_column || "geom";
        const srid = Number(src.srid) || 4326;

        // Never wrap the FACILITY geometry in ST_Transform. Doing so makes the
        // predicate non-sargable and the table's GIST index unusable, turning
        // this into a sequential scan over every feature -- measured at minutes
        // per query. Transform the county side instead: it is 3,233 rows, and
        // the facility index stays usable. When the SRIDs already match (they
        // do for every table the ETL loads), emit neither.
        const countyGeom = srid === 4326 ? "c.geom" : `ST_Transform(c.geom, ${srid})`;

        // LEFT JOIN so counties with zero features yield 0 rather than
        // vanishing -- "no refineries here" is an answer, not a missing row.
        //
        // Attribute filters go in the ON clause for the same reason. Moved to
        // WHERE they would delete every county with no MATCHING feature, so
        // "critical access hospitals per county" would silently drop every
        // county that has only general hospitals, rather than showing it as 0.
        const countFilters = attributeFilterSql(st, "f", bind);
        parts.push(
          `${name} AS (SELECT c.fips, COUNT(f.*)::double precision AS value ` +
          `FROM county_geom c LEFT JOIN ${src.table_name} f ` +
          `ON ST_Intersects(${countyGeom}, f.${geom})` +
          (countFilters.length ? ` AND ${countFilters.join(" AND ")}` : "") + ` ` +
          `GROUP BY c.fips)`);
        break;
      }

      case "count_near": {
        // "X within N miles of Y", counted per county.
        //
        // The distance test runs on geography so "miles" means miles, but a
        // geography cast cannot use the GIST index built on the geometry
        // column, and the reference layers are large (transmission lines is
        // 89,744 rows). The && bounding-box prefilter IS index-assisted and
        // cheap, and it is a strict superset of the geography answer, so the
        // exact ST_DWithin only ever runs on survivors. Measured: 1.2s for
        // hospitals-near-transmission-lines nationally; without the prefilter
        // the same query is a sequential scan.
        //
        // ST_Expand takes degrees, so the radius is converted at the equator
        // (111.32 km/deg). That over-expands away from the equator, which is
        // the safe direction for a prefilter -- it can only admit extra
        // candidates, never discard real ones.
        const subject = featureSource(st.attr_id);
        const near = featureSource(st.near_attr_id, "near_attr_id");
        const miles = Number(st.miles);
        if (!Number.isFinite(miles) || miles <= 0) {
          throw new CompileError(`count_near needs a positive "miles", got ${st.miles}`);
        }
        const meters = miles * 1609.344;
        const degrees = meters / 111320;
        // LEFT JOIN with the proximity test in the ON clause, not WHERE: a
        // county with no qualifying feature must yield 0, and a WHERE would
        // delete the row instead.
        parts.push(
          `${name} AS (SELECT c.fips, COUNT(f.*)::double precision AS value ` +
          `FROM county_geom c LEFT JOIN ${subject.table} f ` +
          `ON ST_Intersects(c.geom, f.${subject.geom}) ` +
          `AND EXISTS (SELECT 1 FROM ${near.table} n ` +
          `WHERE n.${near.geom} && ST_Expand(f.${subject.geom}, ${bind(degrees)}) ` +
          `AND ST_DWithin(f.${subject.geom}::geography, n.${near.geom}::geography, ${bind(meters)})) ` +
          `GROUP BY c.fips)`);
        break;
      }

      case "nearest_distance": {
        // Miles from each county's centroid to the nearest feature. The <->
        // operator is an index-assisted KNN scan, so this is one indexed lookup
        // per county rather than a cross join: 187ms for all 3,233 counties.
        const target = featureSource(st.attr_id);
        parts.push(
          `${name} AS (SELECT c.fips, (` +
          `SELECT ST_Distance(ST_Centroid(c.geom)::geography, f.${target.geom}::geography) / 1609.344 ` +
          `FROM ${target.table} f ORDER BY f.${target.geom} <-> ST_Centroid(c.geom) LIMIT 1` +
          `) AS value FROM county_geom c)`);
        break;
      }

      case "filter_attr": {
        const op = OPERATORS[st.operator];
        if (!op) throw new CompileError(`unsupported operator ${st.operator}`);
        parts.push(
          `${name} AS (SELECT fips, value FROM ${ins[0]} WHERE value ${op} ${bind(st.value)})`);
        break;
      }

      case "filter_area": {
        // Restrict to states/regions. The predicate is on the first two digits
        // of fips, which is exactly county_geom.state_fp, so this stays a plain
        // indexed comparison rather than anything spatial.
        const { codes, unknown } = toFipsPrefixes(st.states);
        if (unknown.length) {
          throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
        }
        if (!codes.length) throw new CompileError("filter_area needs at least one state");
        const list = codes.map(c => bind(c)).join(", ");
        parts.push(
          `${name} AS (SELECT fips, value FROM ${ins[0]} ` +
          `WHERE LEFT(fips, 2) IN (${list}))`);
        break;
      }

      case "filter_place": {
        // Keep only counties that intersect a named boundary: a city, a ZIP
        // code, a metro. Until place_geom existed, county_geom was the only
        // administrative geometry and this could not be expressed at all.
        //
        // EXISTS rather than a join: a city can span several counties
        // (Springfield MO covers Greene and Christian), and a join would emit a
        // county once per intersecting polygon, silently duplicating its value
        // into every downstream aggregate.
        const kind = String(st.place_kind || "");
        if (!PLACE_KINDS.includes(kind)) {
          throw new CompileError(`unsupported place_kind ${st.place_kind}`);
        }
        // Metro and urban-area names are compound: the Chicago CBSA is stored
        // as "Chicago-Naperville-Elgin, IL-IN" and the urban area as
        // "Chicago, IL--IN", so an equality test on "Chicago" matched nothing
        // and the answer came back empty rather than wrong -- which at least
        // failed visibly, but failed.
        //
        // So: exact, or the name followed by a separator. "Chicago" matches
        // both of those; "Springfield" still does NOT match "Springfield
        // Gardens", because a space is not a separator here. The validator has
        // already restricted place_name to letters, digits, space, dot,
        // apostrophe and hyphen, so it cannot carry a LIKE wildcard.
        const nameParam = bind(String(st.place_name || ""));
        const conds = [
          `p.kind = ${bind(kind)}`,
          `(lower(p.name) = lower(${nameParam})` +
          ` OR lower(p.name) LIKE lower(${nameParam}) || '-%'` +
          ` OR lower(p.name) LIKE lower(${nameParam}) || ', %')`,
        ];
        // A state narrows an ambiguous name. 22 places are called Springfield,
        // and without this the filter keeps counties in all 22.
        if (Array.isArray(st.states) && st.states.length) {
          const { codes, unknown } = toFipsPrefixes(st.states);
          if (unknown.length) {
            throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
          }
          conds.push(`p.state_fp IN (${codes.map(c => bind(c)).join(", ")})`);
        }
        // A REAL overlap, not a shared edge or a generalization sliver.
        //
        // Plain ST_Intersects gave 27 counties for the Chicago metro, which is
        // defined as 13 whole counties: the CBSA and county layers are drawn at
        // different generalizations, so every neighbour clips a few metres in.
        // ST_Touches does not help, because those slivers have area.
        //
        // Measured: Springfield MO is 99.9914% inside Greene and 0.0086% inside
        // Christian, and that 0.0086% is an artifact rather than a municipal
        // extension. One percent of the SMALLER geometry separates the two
        // cases cleanly and is size-agnostic: for a metro the smaller side is
        // the county (so a sliver county is excluded), for a city it is the
        // city (so a county genuinely containing part of it is kept).
        //
        // The && prefilter stays first so the GIST index is used before the
        // expensive ST_Intersection runs.
        parts.push(
          `${name} AS (SELECT r.fips, r.value FROM ${ins[0]} r ` +
          `WHERE EXISTS (SELECT 1 FROM place_geom p JOIN county_geom c ` +
          `ON c.geom && p.geom AND ST_Intersects(c.geom, p.geom) ` +
          `AND ST_Area(ST_Intersection(c.geom, p.geom)) > ` +
          `${PLACE_OVERLAP_MIN} * LEAST(ST_Area(c.geom), ST_Area(p.geom)) ` +
          `WHERE c.fips = r.fips AND ${conds.join(" AND ")}))`);
        break;
      }

      case "per_area": {
        // Per square mile of LAND area. aland is square metres; awater is
        // deliberately excluded, because dividing by total area makes coastal
        // and Great Lakes counties look artificially sparse.
        parts.push(
          `${name} AS (SELECT r.fips, ` +
          `r.value / NULLIF(g.aland, 0) * 2589988.110336 AS value ` +
          `FROM ${ins[0]} r JOIN county_geom g USING (fips))`);
        break;
      }

      case "normalize": {
        // NULLIF guards division by zero, which is common: many ACS
        // denominators are legitimately 0 for small counties.
        const scale = st.scale ?? 1;
        parts.push(
          `${name} AS (SELECT n.fips, n.value / NULLIF(d.value, 0) * ${bind(scale)} AS value ` +
          `FROM ${ins[0]} n JOIN ${ins[1]} d USING (fips))`);
        break;
      }

      case "aggregate": {
        const fn = AGGREGATES[st.function];
        if (!fn) throw new CompileError(`unsupported aggregate ${st.function}`);
        if (st.group_by === "state") {
          // Group by state FIPS, the first two digits of the county code.
          parts.push(
            `${name} AS (SELECT LEFT(fips, 2) AS fips, ${fn}(value) AS value ` +
            `FROM ${ins[0]} GROUP BY LEFT(fips, 2))`);
        } else {
          parts.push(
            `${name} AS (SELECT NULL::char(5) AS fips, ${fn}(value) AS value FROM ${ins[0]})`);
        }
        break;
      }

      case "rank": {
        const dir = st.direction === "asc" ? "ASC" : "DESC";
        const limit = Number.isInteger(st.limit) && st.limit > 0
          ? Math.min(st.limit, 1000) : 20;
        parts.push(
          `${name} AS (SELECT fips, value FROM ${ins[0]} ` +
          `WHERE value IS NOT NULL ORDER BY value ${dir} LIMIT ${bind(limit)})`);
        break;
      }

      case "join": {
        parts.push(
          `${name} AS (SELECT a.fips, a.value AS value, b.value AS value_b ` +
          `FROM ${ins[0]} a JOIN ${ins[1]} b USING (fips))`);
        break;
      }

      case "output":
        last = ins[0];
        break;

      default:
        throw new CompileError(`unknown op ${st.op}`);
    }
    if (st.op !== "output") last = name;
  }

  if (!last) throw new CompileError("plan produced no output");

  // Aggregates with group_by=none yield a single NULL-fips row, so join to
  // geometry with LEFT JOIN rather than dropping it.
  //
  // The cap must clear the number of counties, or a national choropleth is
  // structurally incomplete. At the previous LIMIT 1000 a county map rendered
  // 1,000 of 3,233 counties and the other 69% drew as "no data" -- which looks
  // exactly like missing coverage rather than a truncated result. `rank`
  // applies its own LIMIT upstream, so "top 10" is unaffected by this.
  const sql =
    `WITH ${parts.join(",\n     ")}\n` +
    `SELECT r.fips, g.name, g.state_fp, r.value,\n` +
    `       CASE WHEN g.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(g.geom) END AS geometry\n` +
    `FROM ${last} r\n` +
    `LEFT JOIN county_geom g USING (fips)\n` +
    `ORDER BY r.value DESC NULLS LAST\n` +
    `LIMIT ${MAX_RESULT_ROWS}`;

  return { sql, params, finalStep: last, mode: "values" };
}

module.exports = {
  compilePlan, compileFeatureSelect, CompileError,
  OPERATORS, AGGREGATES, MAX_FEATURES,
};
