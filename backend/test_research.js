// Tests for backend/research.js with fake search / LLM / embedder. No network.
//   node test_research.js
const assert = require("assert");
const { researchExpand, resolveSources, _test } = require("./research");
const ex = require("./planner/ops/explain");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const fakeSearch = (table) => async (term) =>
  (table[term] || []).map(([attr_id, semantic_score]) => ({ attr_id, semantic_score, search_purpose: "expanded" }));

(async () => {
  await test("resolveSources: request values, unknown sources dropped", () => {
    assert.deepStrictEqual(resolveSources(["PubMed", "web", "google"]), ["pubmed", "web"]);
    assert.deepStrictEqual(resolveSources("web"), ["web"]);
    assert.deepStrictEqual(resolveSources(true), ["pubmed", "web"]);
    assert.deepStrictEqual(resolveSources(false), []);
    assert.deepStrictEqual(resolveSources(""), []);
  });

  await test("pageText drops script/style/nav and tags", () => {
    const t = _test.pageText("<nav>menu</nav><p>Air &amp; water</p><script>x()</script><footer>f</footer>");
    assert.strictEqual(t, "Air & water");
  });

  await test("pubmed without a linked condition sends nothing", async () => {
    const r = await researchExpand({ query: "median income", sources: ["pubmed"], seeds: [],
      search: fakeSearch({}), embed: async () => [], callLLM: async () => { throw new Error("called"); } });
    assert.match(r.errors.pubmed, /no condition/);
    assert.strictEqual(r.results_by_query.length, 0);
  });

  await test("keywords pass the same catalog gate as expansion: new rows above min sim only", async () => {
    // Stub the network: monkeypatch global fetch for SearXNG + two pages.
    const realFetch = global.fetch;
    global.fetch = async (url) => ({
      ok: true,
      text: async () => String(url).includes("/search?")
        ? JSON.stringify({ results: [{ url: "http://a", title: "A" }, { url: "http://b", title: "B" }] })
        : "<p>air pollution and smoking raise heart disease</p>",
    });
    try {
      const r = await researchExpand({
        query: "heart disease by county", sources: ["web"],
        search: fakeSearch({
          "air pollution": [["PM25", 0.70], ["OZONE", 0.65]],
          "statistical": [["JUNK", 0.40]],
          "Smoking": [["SMOK", 0.66]],
        }),
        embed: async (texts) => texts.map(() => [1, 0]),
        callLLM: async () => JSON.stringify({ keywords: ["air pollution", "statistical", "Smoking", "smoking", "heart disease"] }),
        alreadyRetrieved: new Set(["SMOK"]),
      });
      const kept = r.keywords.filter(k => k.kept).map(k => k.keyword);
      assert.deepStrictEqual(kept, ["air pollution"]);
      assert.deepStrictEqual(r.results_by_query[0].results.map(x => x.attr_id), ["PM25", "OZONE"]);
      const why = Object.fromEntries(r.keywords.map(k => [k.keyword, k.reason]));
      assert.match(why["statistical"], /< 0.61/);
      assert.strictEqual(why["Smoking"], "no new attribute");          // already retrieved
      assert.strictEqual(why["heart disease"], "same words as the question");
      assert.strictEqual(r.keywords.length, 4, "duplicate keyword collapsed");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("explain labels a research keyword as research, not literature", () => {
    const candidates = [{ attr_id: "DIAB" }, { attr_id: "PM25", attr_desc: "PM2.5" }];
    const f = ex.chooseFactors({
      outcomeAttrId: "DIAB", candidates,
      resultsByQuery: [{ query: "air pollution", purpose: "expanded",
                         research: { keyword: "air pollution", source: "pubmed" },
                         results: [{ attr_id: "PM25" }] }],
    }).filter(x => x.role === "factor");
    assert.strictEqual(f[0].source, "research");
    assert.deepStrictEqual(f[0].research, { keyword: "air pollution", source: "pubmed" });
    assert.ok(!f[0].literature);
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
