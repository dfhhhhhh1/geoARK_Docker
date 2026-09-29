const { SAFE_DB_IDENT, CompileError, attributeFilterSql } = require("./_sql");

/**
 * Facility datasets are point/polygon features with no fips key. This op is the
 * bridge that turns them into the (fips, value) series everything else composes
 * over: count features per county.
 */
module.exports = {
  name: "count_features",
  inputs: 0,
  needs: ["attr_id"],
  produces: "series",
  kind: "sql",

  grounds: [{ field: "attr_id", sourceKind: "feature" }],
  /** Reads one layer directly, so it can be narrowed by that layer's columns. */
  acceptsAttributeFilters: true,

  enumComment: "count a facility dataset's features per county",
  promptLine: `  count_features needs attr_id (a facility dataset) -> features per county.
                 Accepts attribute_filters to count only some of them.`,
  choiceLine: `  "how many X in each county", X being a facility dataset  -> count_features`,

  offered: (ctx) => ctx.hasFeatureTables,

  examples: [
    { text:
`QUESTION: how many hospitals are in each county
  (a5 = a hospitals facility dataset)
PLAN: {"intent":"Number of hospital features in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"count_features","attr_id":"a5","inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

    // The same op, narrowed by a value taken from the dataset's own filter list.
    // `usesFilters` holds it back when no dataset on offer has any.
    { usesFilters: true, text:
`QUESTION: how many critical access hospitals are in each county
  (a5 = a hospitals facility dataset, listing filter type: "CRITICAL ACCESS")
PLAN: {"intent":"Number of critical access hospitals in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"count_features","attr_id":"a5","inputs":[],
           "attribute_filters":[{"column":"type","value":"CRITICAL ACCESS"}]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },
  ],

  compile(step, ctx) {
    const src = ctx.resolved.get(step.attr_id);
    if (!src) throw new CompileError(`unresolved attr_id ${step.attr_id}`);
    if (src.source_kind !== "feature_table") {
      throw new CompileError(`${step.attr_id} is not a feature table`);
    }
    if (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(src.geom_column || "geom")) {
      throw new CompileError(`unsafe identifier in attribute_source for ${step.attr_id}`);
    }
    const geom = src.geom_column || "geom";
    const srid = Number(src.srid) || 4326;

    // Never wrap the FACILITY geometry in ST_Transform. Doing so makes the
    // predicate non-sargable and the table's GIST index unusable, turning this
    // into a sequential scan over every feature -- measured at minutes per
    // query. Transform the county side instead: it is 3,233 rows, and the
    // facility index stays usable. When the SRIDs already match (they do for
    // every table the ETL loads), emit neither.
    const countyGeom = srid === 4326 ? "c.geom" : `ST_Transform(c.geom, ${srid})`;

    // LEFT JOIN so counties with zero features yield 0 rather than vanishing --
    // "no refineries here" is an answer, not a missing row.
    //
    // Attribute filters go in the ON clause for the same reason. Moved to WHERE
    // they would delete every county with no MATCHING feature, so "critical
    // access hospitals per county" would silently drop every county that has
    // only general hospitals, rather than showing it as 0.
    const filters = attributeFilterSql(step, "f", ctx.bind);
    return `${ctx.name} AS (SELECT c.fips, COUNT(f.*)::double precision AS value ` +
           `FROM county_geom c LEFT JOIN ${src.table_name} f ` +
           `ON ST_Intersects(${countyGeom}, f.${geom})` +
           (filters.length ? ` AND ${filters.join(" AND ")}` : "") + ` ` +
           `GROUP BY c.fips)`;
  },
};
