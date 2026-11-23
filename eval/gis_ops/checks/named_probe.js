// Probe of the named-data check alone (planner/named_data.js), 2026-11-22.
//
// WHY. method_words_dev and thresholds_dev passed on HEAD through the full
// pipeline (base-*.log): end to end, the check only fires when the model
// happens to list a method name or a comparison as data, and which wording
// does that is not visible from four questions. This calls the check's model
// ONCE per wording (qwen3:14b, reasoning off, temperature 0, exactly the
// production call) with real catalog rows as the plan's attributes, then
// scores that one reply under two versions of the code: HEAD's named_data
// and the working tree's. Any difference is the code's, never the model's.
//
// Cases are DEV wordings written for this probe. `refuse: true` cases are
// controls the check must still refuse (the data is not loaded): a fix that
// only opens the gate fails them.
//
// Run inside the API container (it needs the Ollama network):
//   bash eval/gis_ops/checks/run_named_probe.sh <label>
"use strict";
const path = require("path");
const fs = require("fs");
const dir = process.argv[2] || __dirname;
const NEW = require(path.join(dir, "planner/named_data.js"));
const OLD = require(path.join(dir, "planner/named_data_head.js"));

const A = {
  income: { attr_id: "MEDHHINC", attr_desc: "Median household income in dollars (Census SAIPE estimate)", dataset_clean: "USDA ERS" },
  poverty: { attr_id: "PCTPOVALL", attr_desc: "Percent of people of all ages in poverty (poverty rate, Census SAIPE estimate)", dataset_clean: "USDA ERS" },
  unemp: { attr_id: "UNEMPLOYMENT_RATE", attr_desc: "Unemployment rate, percent of the civilian labor force unemployed, annual average (BLS LAUS)", dataset_clean: "USDA ERS" },
  diabetes: { attr_id: "PLACES_DIABETES_CrdPrv", attr_desc: "Diagnosed diabetes among adults (crude prevalence) (covers 2,957 counties)", dataset_clean: "CDC PLACES" },
  obesity: { attr_id: "PLACES_OBESITY_CrdPrv", attr_desc: "Obesity among adults (crude prevalence) (covers 2,957 counties)", dataset_clean: "CDC PLACES" },
  uninsured: { attr_id: "PLACES_ACCESS2_CrdPrv", attr_desc: "Current lack of health insurance among adults aged 18-64 years (crude prevalence) (covers 2,957 counties)", dataset_clean: "CDC PLACES" },
  pop: { attr_id: "POP_ESTIMATE", attr_desc: "Total population (resident population estimate, July 1)", dataset_clean: "USDA ERS" },
  hospitals: { attr_id: "443ff20b_01_01_01", attr_desc: "Objectid", dataset_clean: "Hospitals" },
  nursing: { attr_id: "5c91101d_01_01_01", attr_desc: "Objectid", dataset_clean: "Nursing Homes" },
  fire: { attr_id: "964c8e3d_01_01_01", attr_desc: "Objectid", dataset_clean: "Fire Stations" },
};

// [id, ops in the plan, attributes used, question, refuse?]
const CASES = [
  // ---- method words
  ["m-oh-autocorr", ["load", "filter_area", "moran"], ["income"], "Test for spatial autocorrelation in median household income across Ohio counties."],
  ["m-tn-queen", ["load", "filter_area", "moran"], ["diabetes"], "Using Moran's I with queen contiguity weights, is diagnosed diabetes significantly clustered among Tennessee counties?"],
  ["m-nc-lisa-name", ["load", "filter_area", "moran"], ["unemp"], "Run a local indicators of spatial association analysis of the unemployment rate across North Carolina counties."],
  ["m-al-significant", ["load", "filter_area", "moran"], ["poverty"], "Is there statistically significant spatial autocorrelation in the poverty rate among Alabama counties?"],
  ["m-ia-matrix", ["load", "filter_area", "moran"], ["obesity"], "Compute the global Moran's I statistic for adult obesity in Iowa counties using a contiguity-based spatial weights matrix."],
  ["m-fl-lisa-outliers", ["load", "filter_area", "moran"], ["uninsured"], "Map the LISA clusters and spatial outliers of the uninsured rate for Florida counties."],
  ["m-mi-positive", ["load", "filter_area", "moran"], ["unemp"], "Does the unemployment rate show positive spatial autocorrelation across Michigan counties?"],
  ["m-va-permutation", ["load", "filter_area", "moran"], ["income"], "Measure spatial clustering of median household income in Virginia with a Moran's I permutation test."],
  ["c-mo-spearman", ["load", "load", "filter_area", "correlate"], ["income", "obesity"], "What is the Spearman rank correlation coefficient between median household income and adult obesity across Missouri counties?"],
  ["c-tx-pearson", ["load", "load", "filter_area", "correlate"], ["poverty", "diabetes"], "Report the Pearson correlation and its significance between the poverty rate and diagnosed diabetes in Texas counties."],
  ["c-oh-association", ["load", "load", "filter_area", "correlate"], ["unemp", "obesity"], "Is there a statistically significant association between unemployment and obesity across Ohio counties?"],
  ["h-ms-getis", ["load", "filter_area", "hotspot"], ["poverty"], "Run a Getis-Ord Gi* hot spot analysis of the poverty rate across Mississippi counties."],
  ["h-us-hot-cold", ["load", "hotspot"], ["diabetes"], "Where are the statistically significant hot spots and cold spots of diagnosed diabetes?"],
  ["o-us-tukey", ["load", "outlier"], ["income"], "Which counties are outliers in median household income by the Tukey IQR fence?"],
  ["x-ar-composite", ["load", "load", "filter_area", "composite"], ["poverty", "unemp"], "Build an equally weighted composite index of the poverty rate and the unemployment rate for Arkansas counties."],
  ["r-us-residuals", ["load", "load", "residual"], ["obesity", "income"], "Which counties have the largest residuals when adult obesity is regressed on median household income?"],
  // ---- thresholds
  ["t-access-gap", ["load", "filter_attr", "count_features", "nearest_distance", "filter_attr", "intersect"], ["poverty", "hospitals"], "Which counties with above-median poverty rates are more than 30 miles from the nearest hospital?"],
  ["t-ks-15mi", ["count_features", "filter_area", "nearest_distance", "filter_attr"], ["hospitals"], "Which Kansas counties are more than 15 miles from the nearest hospital?"],
  ["t-tx-over30", ["count_features", "filter_area", "nearest_distance", "filter_attr"], ["hospitals"], "List the Texas counties where the nearest hospital is over 30 miles away."],
  ["t-ia-lt4", ["count_features", "filter_attr", "filter_area"], ["nursing"], "Which Iowa counties have fewer than 4 nursing homes?"],
  ["t-mt-fire-40", ["nearest_distance", "filter_area", "filter_attr"], ["fire"], "Which Montana counties are farther than 40 miles from a fire station?"],
  ["t-or-3within25", ["count_near", "filter_area", "filter_attr"], ["hospitals"], "Which counties in Oregon have at least 3 hospitals within 25 miles?"],
  ["t-mo-pov20", ["load", "filter_area", "filter_attr"], ["poverty"], "Which Missouri counties have a poverty rate above 20 percent?"],
  ["t-us-fire-per10k", ["count_features", "load", "normalize", "filter_attr"], ["fire", "pop"], "Which counties have fewer than 2 fire stations per 10,000 residents?"],
  ["t-wy-no-nursing-50", ["nearest_distance", "filter_area", "filter_attr"], ["nursing"], "Which Wyoming counties have no nursing home within 50 miles?"],
  // ---- controls: must still be refused (nothing used measures it)
  ["X-oh-snowfall", ["load", "filter_area", "moran"], ["unemp"], "Test for spatial autocorrelation in average annual snowfall across Ohio counties.", true],
  ["X-mo-rainfall", ["load", "load", "filter_area", "correlate"], ["income", "obesity"], "What is the Spearman correlation between annual rainfall and median household income in Missouri counties?", true],
  ["X-pa-lyme", ["load", "filter_area", "moran"], ["obesity"], "Is the rate of Lyme disease spatially clustered among Pennsylvania counties?", true],
  ["X-ks-airport", ["count_features", "filter_area", "nearest_distance", "filter_attr"], ["hospitals"], "Which Kansas counties are more than 15 miles from the nearest airport?", true],
  ["X-ia-libraries", ["count_features", "filter_attr", "filter_area"], ["nursing"], "Which Iowa counties have fewer than 4 public libraries?", true],
  ["X-us-trauma", ["nearest_distance", "filter_attr"], ["hospitals"], "Which counties are more than 50 miles from a Level I trauma center?", true],
  ["X-us-hotspot-crime", ["load", "hotspot"], ["poverty"], "Run a Getis-Ord Gi* hot spot analysis of violent crime rates across US counties.", true],
];

async function ollama(system, user, schema) {
  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.PLAN_MODEL || "qwen3:14b", stream: false, think: false, format: schema,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      options: { temperature: 0, num_ctx: 8192, num_predict: 3000 },
    }),
  });
  const j = await res.json();
  return j.message?.content || "";
}

(async () => {
  const rows = [];
  for (const [id, ops, attrs, query, refuse = false] of CASES) {
    const cands = attrs.map(a => A[a]);
    const refs = new Map(cands.map((c, i) => [`a${i + 1}`, c.attr_id]));
    const used = cands.map(c => ({ attr_id: c.attr_id, op: "load", feeds: [] }));
    const plan = { steps: ops.map((op, i) => ({ id: `s${i + 1}`, op })) };
    let reply = null;
    const replay = async (s, u, t, schema) => (reply ??= await ollama(s, u, schema));
    const quiet = () => {};
    const o = await OLD.checkNamedData({ query, used, candidates: cands, refs, callLLM: replay, log: quiet, plan });
    const n = await NEW.checkNamedData({ query, used, candidates: cands, refs, callLLM: replay, log: quiet, plan });
    const row = { id, refuse, query, reply: JSON.parse(reply || "{}"),
                  old_uncovered: o.uncovered, new_uncovered: n.uncovered,
                  old_ok: refuse ? o.uncovered.length > 0 : o.uncovered.length === 0,
                  new_ok: refuse ? n.uncovered.length > 0 : n.uncovered.length === 0 };
    rows.push(row);
    const tag = (ok) => (ok ? "ok  " : "FAIL");
    console.log(`${tag(row.old_ok)} -> ${tag(row.new_ok)}  ${id.padEnd(20)} ${refuse ? "[must refuse] " : ""}` +
      `old: ${JSON.stringify(o.uncovered)}  new: ${JSON.stringify(n.uncovered)}`);
  }
  const part = (f) => rows.filter(f);
  const ans = part(r => !r.refuse), ctl = part(r => r.refuse);
  const cnt = (rs, k) => rs.filter(r => r[k]).length;
  console.log(`\nanswerable not refused: HEAD ${cnt(ans, "old_ok")}/${ans.length}, new ${cnt(ans, "new_ok")}/${ans.length}`);
  console.log(`controls still refused: HEAD ${cnt(ctl, "old_ok")}/${ctl.length}, new ${cnt(ctl, "new_ok")}/${ctl.length}`);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(rows, null, 2));
})();
