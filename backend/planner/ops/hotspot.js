/**
 * Getis-Ord Gi*: where high and low values CLUSTER in space.
 *
 * The output is a z-score per county. Strongly positive means this county and
 * its neighbours are all high (a hot spot); strongly negative means they are
 * all low (a cold spot); near zero means the neighbourhood looks like the
 * country as a whole. The usual reading is |z| > 1.96 for 95% confidence,
 * though that ignores multiple comparisons across 3,233 counties, so treat it
 * as a strength ordering rather than a significance test.
 *
 * WHY THIS IS SQL AND NOT PYSAL. Gi* with binary contiguity weights is a join
 * against an adjacency table plus two aggregates. Running it here keeps it
 * inside the read-only transaction, inside the (fips, value) contract, and off
 * the dependency list: no sidecar, no serialization round trip, no second place
 * for the data to be wrong. PySAL earns its keep for weights schemes this does
 * not implement -- distance bands, kernels, k-nearest -- not for this.
 *
 * Composes like anything else: `load -> hotspot -> rank` gives the strongest
 * hot spots, `load -> hotspot -> filter_area` restricts them to one state.
 */
module.exports = {
  name: "hotspot",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",

  /**
   * Signed output, so the frontend must diverge around zero rather than use the
   * sequential ramp. A hot spot and a cold spot rendered as two shades of the
   * same blue would be actively misleading.
   */
  diverging: true,
  valueLabel: "Gi* z-score",

  enumComment: "spatial clustering of high and low values (Getis-Ord Gi*)",
  promptLine: `  hotspot      1 input                             -> Gi* z-score per county:
                 high positive = a cluster of high values, negative = low`,
  choiceLine: `  "hot spots", "cold spots", "clusters of", "clustered"    -> hotspot`,

  // Needs the adjacency table, and needs the question to actually be about
  // clustering. Offered unconditionally it would be one more choice on every
  // query, which is the cost this project has measured directly.
  // Shape, not a word list -- see the longer note on outlier's gate. "Are there
  // parts of the country where diabetes is unusually common" is how the
  // question actually gets asked, and it contains no cluster word at all.
  offered: (ctx) => {
    if (ctx.hasNeighbors !== true) return false;
    const q = String(ctx.query || "");
    return /\b(hot\s?spots?|cold\s?spots?|cluster(s|ed|ing)?|spatial\s+pattern|autocorrelation)\b/i.test(q)
      // "parts of the country where", "regions of the US where"
      || /\b(parts?|regions?|areas?|pockets?|corners?)\s+of\s+the\s+(country|us|usa|nation|state)\b/i.test(q)
      // "where is X concentrated", "which areas clump together"
      || /\b(where|which\s+(parts?|areas?|regions?))\b[^.?]*\b(concentrat\w+|clump\w*|bunch\w*)\b/i.test(q)
      // "pockets of poverty", "belts of unemployment"
      || /\b(pockets?|bands?|belts?|corridors?)\s+of\b/i.test(q);
  },

  examples: [{ text:
`QUESTION: where are the hot spots of poverty
  (a3 = poverty rate)
PLAN: {"intent":"Spatial clusters of high and low poverty rate, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s2","op":"hotspot","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  compile(step, ctx) {
    // Binary weights with the county itself included, which is what the star in
    // Gi* means: a county is part of its own neighbourhood.
    //
    //   Gi* = (SUM(w*x) - xbar*W) / (S * sqrt((n*W - W^2) / (n-1)))
    //
    // LEFT JOIN on the adjacency, because 20 of 3,233 counties have no
    // neighbours at all -- island counties in Hawaii and Massachusetts. An
    // inner join would drop them silently; this way they score against
    // themselves alone, which is the honest answer for an island.
    //
    // stddev_pop, not stddev_samp: Gi* is defined over the whole set of
    // observations, not a sample drawn from it.
    return `${ctx.name} AS (` +
      `WITH v AS (SELECT fips, value FROM ${ctx.ins[0]} WHERE value IS NOT NULL), ` +
      `g AS (SELECT avg(value) AS xbar, stddev_pop(value) AS sd, ` +
            `count(*)::double precision AS n FROM v), ` +
      `nb AS (SELECT a.fips, ` +
             `a.value + COALESCE(sum(b.value), 0) AS wsum, ` +
             `1::double precision + COALESCE(count(b.fips), 0) AS wn ` +
             `FROM v a ` +
             `LEFT JOIN county_neighbors cn ON cn.fips = a.fips ` +
             `LEFT JOIN v b ON b.fips = cn.neighbor_fips ` +
             `GROUP BY a.fips, a.value) ` +
      `SELECT nb.fips, (nb.wsum - g.xbar * nb.wn) / ` +
             `NULLIF(g.sd * sqrt(GREATEST(g.n * nb.wn - nb.wn * nb.wn, 0) / ` +
                    `NULLIF(g.n - 1, 0)), 0) AS value ` +
      `FROM nb CROSS JOIN g)`;
  },
};
