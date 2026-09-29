const {
  SAFE_DB_IDENT, CompileError, attributeFilterSql, MAX_FEATURES,
} = require("./_sql");
const { toFipsPrefixes } = require("../../states");

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
  promptLine: `  select_features needs attr_id, optional states / city / attribute_filters / limit
                 -> the individual locations themselves, drawn on the map.
                 Use it ALONE: it returns places, not per-county numbers, so
                 nothing else can be chained onto it. Put any place restriction
                 in this step. City names repeat across the country, so when the
                 question names a city AND a state, always set both.`,
  choiceLine: `  "where are the X", "show me X locations", "list the X"   -> select_features`,

  // A different SHAPE of answer, so it appears only when the question is
  // actually asking where things are. Offering it to "how many hospitals per
  // county" invites the wrong one.
  offered: (ctx) => ctx.hasFeatureTables && ctx.wantsLocations,

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
   * Compiles to a standalone SELECT rather than a CTE: it reads a layer
   * directly and has no (fips, value) shape to contribute to the chain.
   */
  compileStandalone(step, ctx) {
    const src = ctx.resolved.get(step.attr_id);
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
      `FROM ${src.table_name} f\n` +
      (joins.length ? joins.join("\n") + "\n" : "") +
      (where.length ? `WHERE ${where.join(" AND ")}\n` : "") +
      `LIMIT ${limit}`;

    return { sql, mode: "features", labels };
  },
};
