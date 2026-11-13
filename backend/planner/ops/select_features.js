const {
  SAFE_DB_IDENT, CompileError, attributeFilterSql, MAX_FEATURES, FEATURE_LABELS, featureFrom,
} = require("./_sql");
const { toFipsPrefixes } = require("../../states");
const { featureAlgebra, overlayAlgebra, measureAlgebra } = require("../features");

// Every feature-algebra reading: distance (H1), overlay and amounts (H3).
const composable = (ctx) => featureAlgebra(ctx) || overlayAlgebra(ctx) || measureAlgebra(ctx);

/**
 * NOT a bridge: returns the features themselves.
 *
 * This is the second RESULT SHAPE. Everything else in the compiler produces
 * (fips, value) and composes -- normalize, per_area and rank all rely on that.
 * Features have their own geometry, their own labels, and no county key, so
 * they compose with none of it. The registry declares `produces: "features"`
 * and the validator enforces that only an `output` may consume such a step;
 * pretending otherwise would mean every downstream op needing an "unless it's
 * features" branch.
 */
module.exports = {
  name: "select_features",
  inputs: 0,
  needs: ["attr_id"],
  produces: "features",
  kind: "sql",

  grounds: [{ field: "attr_id", sourceKind: "feature" }],
  acceptsAttributeFilters: true,

  enumComment: "the individual locations themselves, mapped",
  // When the feature ops are on offer (planner/features.js) the line must not
  // say "use it ALONE", or the model is told two contradictory things. Every
  // other prompt keeps the original line byte for byte.
  promptLineFor: (ctx) => composable(ctx) ? COMPOSABLE_LINE : null,
  promptLine: `  select_features needs attr_id, optional states / city / attribute_filters / limit
                 -> the individual locations themselves, drawn on the map.
                 Use it ALONE: it returns places, not per-county numbers, so
                 nothing else can be chained onto it. Put any place restriction
                 in this step. City names repeat across the country, so when the
                 question names a city AND a state, always set both.`,
  choiceLine: `  "where are the X", "show me X locations", "list the X"   -> select_features`,

  // A different SHAPE of answer, so it appears only when the question is
  // actually asking where things are. Offering it to "how many hospitals per
  // county" invites the wrong one. Also the source of every feature-algebra
  // plan (within, summarize), so it is offered whenever they are.
  offered: (ctx) => (ctx.hasFeatureTables && ctx.wantsLocations) || composable(ctx),

  examples: [
    // Two examples, because the state form and the city form differ: `states`
    // is spatial (any layer), `city` matches the layer's own column and only
    // works where it has one.
    { text:
`QUESTION: where are the hospitals in Missouri
  (a4 = a hospitals dataset)
PLAN: {"intent":"Locations of hospitals in Missouri",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a4","inputs":[],"states":["Missouri"]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

    // Sets BOTH city and states. City names are not unique -- "Springfield"
    // alone returned 97 fire stations across 25 states, of which 21 were in
    // Missouri -- and an example showing city on its own is what taught that.
    { text:
`QUESTION: show me the fire stations in Springfield, Missouri
  (a7 = a fire stations dataset)
PLAN: {"intent":"Locations of fire stations in Springfield, Missouri",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a7","inputs":[],
           "city":"Springfield","states":["Missouri"]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },
  ],

  validate(step) {
    const errors = [];
    // `city` is the one free-text field in a plan, and constrained decoding has
    // been observed leaking JSON structure into it -- "Springfield','states':
    // ['Missouri']" -- which compiles fine and matches nothing. generatePlan
    // salvages the leading name before validation; this is the backstop for
    // anything that reaches here unrepaired.
    if (step.city && !/^[A-Za-z]([A-Za-z .'\-]*[A-Za-z])?$/.test(step.city)) {
      errors.push(
        `step "${step.id}": city ${JSON.stringify(step.city)} is not a place name. ` +
        `Give the city on its own, e.g. "Springfield", and put the state in "states".`);
    }
    return errors;
  },

  /**
   * The CTE form, for when another op reads this step (within, summarize,
   * rank): the features contract of ops/_sql.js, every row of the layer that
   * passes the step's restrictions, no LIMIT (the output applies one).
   *
   * NOT MATERIALIZED on purpose. A materialized CTE has no index, and within
   * probes the second layer once per feature of the first: inlined, that probe
   * is a GIST index scan of the base table; materialized, it is a sequential
   * scan of 52,184 fire stations per hospital. The state restriction is an
   * EXISTS rather than the standalone form's JOIN, so a point on a county line
   * is one row, not two.
   */
  compile(step, ctx) {
    const { src, from, geom, available } = layerOf(step, ctx);
    const cols = FEATURE_LABELS.map(c => available.has(c) ? `f.${c}::text AS ${c}` : `NULL::text AS ${c}`);
    // A state restriction keeps WHOLE features that touch the state, for a
    // parts read too. Testing each part instead (the first H3 build) dropped
    // the out-of-state parts of a large perimeter across the Oregon line
    // while keeping all of a small one: 551.7 km for 563.8 (H3 held-out).
    // A parts read tests the feature's own states, recorded once by
    // etl/ingest.py build_parts (`geoark_states`).
    const whereFor = (g, statesColumn = null) => {
      const where = [];
      if (Array.isArray(step.states) && step.states.length) {
        const { codes, unknown } = toFipsPrefixes(step.states);
        if (unknown.length) throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
        where.push(statesColumn
          ? `${statesColumn} && ARRAY[${codes.map(c => ctx.bind(c)).join(", ")}]::text[]`
          : `EXISTS (SELECT 1 FROM county_geom c WHERE c.geom && ${g} ` +
            `AND ST_Intersects(c.geom, ${g}) ` +
            `AND LEFT(c.fips, 2) IN (${codes.map(c => ctx.bind(c)).join(", ")}))`);
      }
      if (step.city) {
        if (!available.has("city")) {
          throw new CompileError(
            `this dataset has no city column, so it cannot be filtered to ` +
            `"${step.city}". Restrict by state instead.`);
        }
        where.push(`f.city ILIKE ${ctx.bind(step.city)}`);
      }
      where.push(...attributeFilterSql(step, "f", ctx.bind));
      return where;
    };
    const parts = step.geometry_only === true ? partsOf(src) : null;
    if (parts) {
      // Small features as they are, large ones as their subdivided parts
      // (etl/ingest.py build_parts). Two index-assisted branches; a probe
      // pushed into this CTE reaches both.
      const small = [`f.geoark_npts <= ${ctx.bind(parts.threshold)}`, ...whereFor(`f.${geom}`)];
      const large = whereFor("p.geom", "f.geoark_states");
      return `${ctx.name} AS NOT MATERIALIZED (` +
             `SELECT f.${geom} AS geom, NULL::double precision AS value, ${cols.join(", ")} FROM ${from} f ` +
             `WHERE ${small.join(" AND ")} UNION ALL ` +
             `SELECT p.geom AS geom, NULL::double precision AS value, ${cols.join(", ")} FROM ${parts.table} p ` +
             `JOIN ${from} f ON f.${parts.key} = p.fid` +
             (large.length ? ` WHERE ${large.join(" AND ")}` : "") + `)`;
    }
    const where = whereFor(`f.${geom}`);
    return `${ctx.name} AS NOT MATERIALIZED (SELECT f.${geom} AS geom, NULL::double precision AS value, ` +
           `${cols.join(", ")} FROM ${from} f` +
           (where.length ? ` WHERE ${where.join(" AND ")}` : "") + `)`;
  },

  /** The label columns this step's layer actually has, for the output. */
  labelsOf(step, ctx) {
    return FEATURE_LABELS.filter(c => layerOf(step, ctx).available.has(c));
  },

  /**
   * Compiles to a standalone SELECT rather than a CTE: it reads a layer
   * directly and has no (fips, value) shape to contribute to the chain.
   */
  compileStandalone(step, ctx) {
    const { src, from, geom } = layerOf(step, ctx);

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
      // Spatial rather than by the layer's own `state` column: only 54% of
      // layers have one, and a point's containing county is authoritative.
      joins.push(`JOIN county_geom c ON ST_Intersects(c.geom, f.${geom})`);
      where.push(`LEFT(c.fips, 2) IN (${codes.map(c => ctx.bind(c)).join(", ")})`);
    }

    if (step.city) {
      if (!available.has("city")) {
        throw new CompileError(
          `this dataset has no city column, so it cannot be filtered to ` +
          `"${step.city}". Restrict by state instead.`);
      }
      // Case-insensitive exact match: ILIKE with no wildcards, so "Springfield"
      // does not also return "Springfield Gardens".
      where.push(`f.city ILIKE ${ctx.bind(step.city)}`);
    }

    where.push(...attributeFilterSql(step, "f", ctx.bind));

    const limit = Number.isInteger(step.limit) && step.limit > 0
      ? Math.min(step.limit, MAX_FEATURES) : MAX_FEATURES;

    const sql =
      `SELECT ST_AsGeoJSON(f.${geom}) AS geometry` +
      (selected ? `, ${selected}` : "") + `\n` +
      `FROM ${from} f\n` +
      (joins.length ? joins.join("\n") + "\n" : "") +
      (where.length ? `WHERE ${where.join(" AND ")}\n` : "") +
      `LIMIT ${limit}`;

    return { sql, mode: "features", labels };
  },
};

/** The layer's registered parts, identifiers checked, or null. */
function partsOf(src) {
  const p = src && !src.user_layer ? src.parts : null;
  if (!p) return null;
  if (!SAFE_DB_IDENT.test(p.parts_table || "") || !SAFE_DB_IDENT.test(p.key_column || "") ||
      !Number.isInteger(Number(p.threshold))) return null;
  return { table: p.parts_table, key: p.key_column, threshold: Number(p.threshold) };
}

function layerOf(step, ctx) {
  const src = ctx.resolved.get(step.attr_id);
  if (!src) throw new CompileError(`unresolved attr_id ${step.attr_id}`);
  if (src.source_kind !== "feature_table") {
    throw new CompileError(`${step.attr_id} is a per-county value series, not mappable locations`);
  }
  // A catalog table, or a layer the user uploaded (backend/user_layers.js).
  const { from, geom } = featureFrom(src, ctx.bind, step.attr_id);
  const available = new Set((src.label_columns || []).filter(c => SAFE_DB_IDENT.test(c)));
  return { src, from, geom, available };
}

const COMPOSABLE_LINE = `  select_features needs attr_id, optional states / city / attribute_filters / limit
                 -> the individual locations themselves. Map them with output,
                 or feed them to within, summarize or rank. Put any place
                 restriction in this step. City names repeat across the country,
                 so when the question names a city AND a state, always set both.`;
