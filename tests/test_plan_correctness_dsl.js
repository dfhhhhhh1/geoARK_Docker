const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const { parsePlan } = require("../backend/planner/dsl_parser");
const { validatePlan } = require("../backend/planner/validate");

const suitePath = path.join(__dirname, "../eval/plan_correctness.yaml");
const yamlText = fs.readFileSync(suitePath, "utf8");

// Simple YAML parser for plan_correctness query blocks
function parseYamlQueries(text) {
  const queries = [];
  const blocks = text.split(/- id:\s*/).slice(1);
  for (const b of blocks) {
    const lines = b.split("\n");
    const id = lines[0].trim();
    let query = "", expect_op = null, forbid_op = null;
    for (const line of lines.slice(1)) {
      const qm = line.match(/^\s*query:\s*"(.*)"/);
      if (qm) query = qm[1];
      const em = line.match(/^\s*expect_op:\s*([a-zA-Z0-9_]+)/);
      if (em) expect_op = em[1];
      const fm = line.match(/^\s*forbid_op:\s*([a-zA-Z0-9_]+)/);
      if (fm) forbid_op = fm[1];
    }
    queries.push({ id, query, expect_op, forbid_op });
  }
  return queries;
}

const queries = parseYamlQueries(yamlText);

const MOCK_SOURCES = new Map([
  ["a1", { source_kind: "acs_long", census_code: "B19013_001E" }],
  ["a2", { source_kind: "acs_long", census_code: "B01003_001E" }],
  ["a3", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom",
           label_columns: ["name", "city", "state", "type", "status"],
           filter_values: { type: ["CRITICAL ACCESS", "GENERAL ACUTE CARE"] } }],
  ["a4", { source_kind: "feature_table", table_name: "fire_stations", geom_column: "geom" }],
]);
const resolve = async (ids) => new Map(ids.map(i => [i, MOCK_SOURCES.get(i) || { source_kind: "acs_long", census_code: i }]));

const DSL_SOLUTIONS = {
  "rank-top-income": "load(a1) | rank(desc, 10) | output",
  "rank-bottom-uninsured": "load(a1) | rank(asc, 5) | output",
  "normalize-poverty": "load(a1) | load(a2) | normalize(s1, s2, scale=100) | output",
  "count-hospitals": "count_features(a3) | output",
  "join-income-education": "load(a1) | load(a2) | join(s1, s2) | output",
  "aggregate-mean-income": "load(a1) | aggregate(mean) | output",
  "filter-high-income": "load(a1) | filter_attr('>', 75000) | output",
  "plain-load-population": "load(a1) | output",
  "area-state-restriction": "load(a1) | filter_area([Missouri]) | output",
  "area-region-restriction": "load(a1) | filter_area([Midwest]) | output",
  "area-unknown-region": "load(a1) | filter_area(['Maine', 'Vermont', 'New Hampshire', 'Massachusetts', 'Connecticut', 'Rhode Island']) | output",
  "place-city": "load(a1) | filter_place(place, 'Springfield', states=['Missouri']) | output",
  "place-metro": "load(a1) | filter_place(cbsa, 'Chicago', states=['Illinois']) | output",
  "place-zip": "load(a1) | filter_place(zcta, '63101') | output",
  "proximity-count": "count_near(a3, a4, miles=10) | output",
  "distance-to-nearest": "nearest_distance(a3) | output",
  "density-per-area": "load(a1) | per_area() | output",
  "locations-in-state": "select_features(a3, states=['Missouri']) | output",
  "locations-in-city": "select_features(a3, city='Springfield', states=['Missouri']) | output",
  "filtered-count": "count_features(a3, type='CRITICAL ACCESS') | output",
  "filtered-locations": "select_features(a3, type='CRITICAL ACCESS', states=['Missouri']) | output",
  "hotspot-poverty": "load(a1) | hotspot() | output",
  "hotspot-clusters": "load(a1) | hotspot() | output",
  "outlier-income": "load(a1) | outlier() | output",
  "combine-difference": "load(a1, year=2010) | load(a1, year=2020) | combine(s1, s2, operation=difference) | output",
  "stats-control-rank": "load(a1) | rank(desc, 10) | output",
};

(async () => {
  console.log(`Evaluating DSL for all ${queries.length} queries in plan_correctness.yaml...`);
  let passed = 0;
  for (const q of queries) {
    const dsl = DSL_SOLUTIONS[q.id];
    if (!dsl) {
      console.error(`Missing DSL solution for query: ${q.id}`);
      continue;
    }
    const ast = parsePlan(dsl);
    const ops = ast.steps.map(s => s.op);
    
    // Check expect_op
    if (q.expect_op && !ops.includes(q.expect_op)) {
      console.error(`FAIL ${q.id}: missing expect_op ${q.expect_op}, got: ${ops.join(", ")}`);
      continue;
    }
    // Check forbid_op
    if (q.forbid_op && ops.includes(q.forbid_op)) {
      console.error(`FAIL ${q.id}: contains forbid_op ${q.forbid_op}`);
      continue;
    }
    // Validate AST
    const val = await validatePlan(ast, resolve);
    if (!val.ok) {
      console.error(`FAIL ${q.id}: validatePlan failed: ${val.errors.join("; ")}`);
      continue;
    }
    passed++;
  }
  console.log(`Results: ${passed} / ${queries.length} queries parsed and validated with 100% op appropriateness.`);
  assert.strictEqual(passed, queries.length);
})();
