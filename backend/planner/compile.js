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
const OPERATORS = { "<": "<", "<=": "<=", ">": ">", ">=": ">=", "=": "=", "!=": "<>" };
const AGGREGATES = { mean: "AVG", sum: "SUM", count: "COUNT", min: "MIN", max: "MAX" };
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;

class CompileError extends Error {}

function cte(id) {
  if (!SAFE_ID.test(id)) throw new CompileError(`unsafe step id: ${JSON.stringify(id)}`);
  return `step_${id}`;
}

/**
 * @param plan      validated plan
 * @param resolved  Map<attr_id, {census_code, source_kind, table_name, value_column}>
 * @returns {{sql: string, params: any[], finalStep: string}}
 */
function compilePlan(plan, resolved) {
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const parts = [];
  let last = null;

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
          if (!SAFE_ID.test(src.table_name) || !SAFE_ID.test(src.value_column)) {
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
        if (!SAFE_ID.test(src.table_name) || !SAFE_ID.test(src.geom_column || "geom")) {
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
        parts.push(
          `${name} AS (SELECT c.fips, COUNT(f.*)::double precision AS value ` +
          `FROM county_geom c LEFT JOIN ${src.table_name} f ` +
          `ON ST_Intersects(${countyGeom}, f.${geom}) ` +
          `GROUP BY c.fips)`);
        break;
      }

      case "filter_attr": {
        const op = OPERATORS[st.operator];
        if (!op) throw new CompileError(`unsupported operator ${st.operator}`);
        parts.push(
          `${name} AS (SELECT fips, value FROM ${ins[0]} WHERE value ${op} ${bind(st.value)})`);
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
  const sql =
    `WITH ${parts.join(",\n     ")}\n` +
    `SELECT r.fips, g.name, g.state_fp, r.value,\n` +
    `       CASE WHEN g.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(g.geom) END AS geometry\n` +
    `FROM ${last} r\n` +
    `LEFT JOIN county_geom g USING (fips)\n` +
    `ORDER BY r.value DESC NULLS LAST\n` +
    `LIMIT 1000`;

  return { sql, params, finalStep: last };
}

module.exports = { compilePlan, CompileError, OPERATORS, AGGREGATES };
