// Tests for backend/expansion.js against a fake pool. No database needed.
//   node test_expansion.js
const assert = require("assert");
process.env.EXPAND_MIN_SIM = "0.72";
const { expandQuery, _test } = require("./expansion");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const ALIASES = {
  "diabetes": { cui: "C0011849", name: "Diabetes Mellitus", semtype: "dsyn", n_rel: 900 },
  "heart disease": { cui: "C0018799", name: "Heart Diseases", semtype: "dsyn", n_rel: 800 },
  "coronary heart disease": { cui: "C0010068", name: "Coronary heart disease", semtype: "dsyn", n_rel: 700 },
  "hot spots": { cui: "C0263214", name: "Pyotraumatic dermatitis", semtype: "dsyn", n_rel: 21, source: "umls" },
  "transmission": { cui: "C0242781", name: "disease transmission", semtype: "patf", n_rel: 18, source: "umls" },
  "educational attainment": { cui: "C0700132", name: "Academic achievement", semtype: "inbe", n_rel: 35, source: "umls" },
  "smoking": { cui: "C0037369", name: "Smoking", semtype: "inbe", n_rel: 357, source: "semmed" },
};
const NEIGHBORS = [
  { cui: "C0028754", name: "Obesity", semtype: "dsyn", support: 180, predicates: ["PREDISPOSES"], roles: ["cause"], seed: "C0011849" },
  { cui: "C0021368", name: "Inflammation", semtype: "dsyn", support: 150, predicates: ["ASSOCIATED_WITH"], roles: ["effect"], seed: "C0011849" },
  { cui: "C0037369", name: "Smoking", semtype: "inbe", support: 90, predicates: ["CAUSES"], roles: ["cause"], seed: "C0011849" },
  { cui: "C0011847", name: "Diabetes", semtype: "dsyn", support: 80, predicates: ["ASSOCIATED_WITH"], roles: ["cause"], seed: "C0011849" },
];

function fakePool({ loaded = true, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql);
      if (fail) throw new Error("connection refused");
      if (/FROM semmed_meta/.test(sql)) return { rows: loaded ? [{ key: "source", value: "semmedVER43.gz" }] : [] };
      if (/FROM semmed_alias/.test(sql)) {
        // Mirrors the SQL's seed-type rules, so the test exercises the params.
        return { rows: params[0].filter(a => ALIASES[a])
          .map(a => ({ alias_norm: a, source: "semmed", ...ALIASES[a] }))
          .filter(r => !params[1].includes(r.semtype))
          .filter(r => !(params[2].includes(r.semtype) && r.source !== "semmed")) };
      }
      if (/FROM semmed_relation/.test(sql)) return { rows: NEIGHBORS };
      throw new Error("unexpected SQL " + sql);
    },
  };
}

// Obesity and Smoking are reachable; Inflammation matches nothing well.
const CATALOG = {
  "Obesity": [{ attr_id: "ob1", semantic_score: 0.86 }, { attr_id: "ob2", semantic_score: 0.84 }],
  "Inflammation": [{ attr_id: "x1", semantic_score: 0.61 }],
  "Smoking": [{ attr_id: "prim1", semantic_score: 0.9 }, { attr_id: "sm1", semantic_score: 0.88 },
              { attr_id: "weak", semantic_score: 0.5 }],
};
const search = async (term) => (CATALOG[term] || []).map(r => ({ ...r }));

(async () => {
  // The module caches index status for a minute; reset between cases.
  const fresh = () => { delete require.cache[require.resolve("./expansion")]; return require("./expansion"); };

  await test("spans are longest first", () => {
    const s = _test.spans("Coronary heart disease rates");
    assert.strictEqual(s[0].text, "coronary heart disease rates");
    assert.ok(s.findIndex(x => x.text === "coronary heart disease") < s.findIndex(x => x.text === "heart disease"));
  });

  await test("longest alias wins and does not double-link the inner span", async () => {
    const { expandQuery } = fresh();
    const out = await expandQuery({ pool: fakePool(), query: "coronary heart disease by county",
      decomposition: { search_queries: [] }, search });
    assert.deepStrictEqual(out.seeds.map(s => s.cui), ["C0010068"]);
  });

  await test("keeps reachable concepts, drops unreachable, redundant and self-similar ones", async () => {
    const { expandQuery } = fresh();
    const out = await expandQuery({ pool: fakePool(), query: "diabetes rates in the South",
      decomposition: { search_queries: [{ query: "diabetes rate", purpose: "primary" }] },
      search, alreadyRetrieved: new Set(["prim1"]) });
    const kept = out.results_by_query.map(q => q.query);
    assert.deepStrictEqual(kept, ["Obesity", "Smoking"]);
    const why = Object.fromEntries(out.concepts.map(c => [c.name, c.reason || "kept"]));
    assert.match(why.Inflammation, /best catalog match/);
    assert.match(why.Diabetes, /same concept/);
    // Smoking's first hit was already retrieved and its third is below the
    // cutoff; only the new, strong row is added.
    assert.deepStrictEqual(out.results_by_query[1].results.map(r => r.attr_id), ["sm1"]);
    assert.match(out.results_by_query[0].results[0].expanded_via, /Obesity -> Diabetes Mellitus/);
  });

  await test("seed rules: no process types, no behavior synonyms, no homonyms", async () => {
    const { expandQuery } = fresh();
    // Fake embedder: the homonym is dissimilar to its mention, all else identical.
    const embed = async (texts) => texts.map(t => /dermatitis/i.test(t) ? [0, 1] : [1, 0]);
    const run = async (query) => expandQuery({ pool: fakePool(), embed, search, query,
                                                decomposition: { search_queries: [] } });
    assert.deepStrictEqual((await run("hospitals near power transmission lines")).seeds, []);
    assert.deepStrictEqual((await run("income against educational attainment")).seeds, []);
    const hot = await run("where are the hot spots of poverty");
    assert.deepStrictEqual(hot.seeds, []);
    assert.deepStrictEqual(hot.rejected_seeds.map(s => s.name), ["Pyotraumatic dermatitis"]);
    // A behavior still links by its own name.
    assert.deepStrictEqual((await run("smoking rates by county")).seeds.map(s => s.name), ["Smoking"]);
  });

  await test("a question with no condition does nothing and runs no neighbor query", async () => {
    const { expandQuery } = fresh();
    const pool = fakePool();
    const out = await expandQuery({ pool, query: "median household income by county",
      decomposition: { search_queries: [{ query: "median income", purpose: "primary" }] }, search });
    assert.strictEqual(out.results_by_query.length, 0);
    assert.ok(!pool.calls.some(s => /semmed_relation/.test(s)));
  });

  await test("missing index degrades to no expansion", async () => {
    const { expandQuery } = fresh();
    const out = await expandQuery({ pool: fakePool({ loaded: false }), query: "diabetes",
      decomposition: {}, search });
    assert.match(out.skipped, /not loaded/);
    assert.strictEqual(out.results_by_query.length, 0);
  });

  await test("a database error never throws", async () => {
    const { expandQuery } = fresh();
    const out = await expandQuery({ pool: fakePool({ fail: true }), query: "diabetes",
      decomposition: {}, search });
    assert.strictEqual(out.results_by_query.length, 0);
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
