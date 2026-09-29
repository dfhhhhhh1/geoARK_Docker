const { SAFE_DB_IDENT, CompileError } = require("./_sql");

/** Pull one attribute's per-county values. The base of every value series. */
module.exports = {
  name: "load",
  inputs: 0,
  needs: ["attr_id"],
  produces: "series",
  kind: "sql",

  // Grounding: which fields name an attribute the SQL will read, and what shape
  // that attribute must be. The validator reads this rather than keeping its own
  // list, which is what let FEATURE_OPS and the schema drift apart before.
  grounds: [{ field: "attr_id", sourceKind: "value" }],

  enumComment: "pull one attribute's values by attr_id",
  promptLine: `  load         needs attr_id                       -> values for one attribute`,
  choiceLine: `  "show X", "map X", plain retrieval of one attribute      -> load, then output`,

  // Always available: without it there is no series to operate on.
  offered: () => true,

  validate(step) {
    // The schema types this as an integer but not its range, and a plan can
    // reach the validator unconstrained (a repair, a non-decoding caller). A
    // year outside the plausible range is not a narrower query, it is an empty
    // result that looks like a real answer -- the failure this project keeps
    // finding. Checked here rather than in the compiler so the model is told.
    if (step.year === undefined || step.year === null) return [];
    const y = Number(step.year);
    if (!Number.isInteger(y) || y < 1900 || y > 2100) {
      return [
        `step "${step.id}" (load): year ${JSON.stringify(step.year)} is not a ` +
        `four-digit year. Leave it out for the most recent figure.`,
      ];
    }
    return [];
  },

  examples: [{ text:
`QUESTION: show total population by county
  (a8 = total population)
PLAN: {"intent":"Total population in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` }],

  compile(step, ctx) {
    const src = ctx.resolved.get(step.attr_id);
    if (!src) throw new CompileError(`unresolved attr_id ${step.attr_id}`);

    if (src.source_kind === "acs_long") {
      const code = ctx.bind(src.census_code);
      // WHICH YEAR. Asking for one explicitly is the trend case; saying nothing
      // means "the current figure", which is the latest vintage this measure
      // actually has -- not a hardcoded year, because coverage differs per
      // measure (unemployment runs 2000-2023, poverty 2013-2024).
      //
      // The subquery is correlated on nothing and Postgres evaluates it once
      // against idx_acs_values_code_year, so this is an index probe rather than
      // a scan. Written as a filter rather than a window function so every
      // downstream op still sees exactly (fips, value).
      const yearFilter = Number.isInteger(step.year)
        ? `year = ${ctx.bind(step.year)}`
        : `year = (SELECT max(year) FROM acs_county_values WHERE census_code = ${code})`;
      return `${ctx.name} AS (SELECT fips, value FROM acs_county_values ` +
             `WHERE census_code = ${code} AND ${yearFilter})`;
    }
    if (src.source_kind === "table_column") {
      // Identifiers here come from attribute_source, a table only the ETL
      // writes -- never from the model. Still pattern-checked.
      if (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(src.value_column)) {
        throw new CompileError(`unsafe identifier in attribute_source for ${step.attr_id}`);
      }
      return `${ctx.name} AS (SELECT fips, ${src.value_column}::double precision AS value ` +
             `FROM ${src.table_name})`;
    }
    throw new CompileError(`unknown source_kind ${src.source_kind}`);
  },
};
