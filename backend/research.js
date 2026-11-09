// =============================================================================
// Research expansion: keywords read out of papers and web pages
// =============================================================================
//
// Integrated from searchImprovement/newsearch (2026-10-29). backend/expansion.js
// finds related CONCEPTS from SemMedDB's relation graph. This goes one step
// further, as the prototype does: it reads TEXT about the question's condition
// and has a small model pull out the environmental / geospatial factors the
// text mentions, then searches the catalog for each one.
//
// Two sources, both OFF by default and both per-request switchable
// ({"research": ["pubmed", "web"]}), because both leave the machine:
//
//   pubmed  PubMed E-utilities. Only the linked seed concept's NAME is sent
//           ("Heart Diseases"), never the question. Fires only when the
//           question links a condition, like expansion.js.
//   web     SearXNG meta-search (deploy profile `research`). The QUESTION
//           ITSELF is sent to public search engines, and every result page is
//           fetched from this machine. That is a break with the local-only
//           design, which is why it is opt-in per request.
//
// Deliberate differences from the prototype, each for a reason in CLAUDE.md:
//
//  - PMIDs come from an E-utilities search on the seed name, not from
//    SemMedDB rows: semmed_relation stores paper COUNTS, not PMIDs, and the
//    prototype's per-query scan of the 3.3 GB gzip took minutes.
//  - Papers are ranked with the BGE embedder already running, not MiniLM, and
//    keywords come from LLM_MODEL (gemma3:4b), not qwen3:1.7b: a third model
//    on a 16 GB card is the VRAM stall in the traps table.
//  - Context is capped. The prototype sent up to 10 pages x 5,000 chars to a
//    model with a 4,096-token window; Ollama silently discards the head of the
//    prompt -- the instructions -- when that overflows (the num_ctx trap).
//  - Every keyword goes through the SAME catalog gate as expansion.js: a row
//    must clear EXPAND_MIN_SIM and be new, so a keyword like "statistical" or
//    "meta-analysis" adds nothing unless the catalog genuinely measures it.

const CONFIG = {
  sources: list(process.env.RESEARCH_SOURCES ?? ""),
  ncbiKey: process.env.NCBI_API_KEY || "",
  ncbiTool: "geoark",
  pubmedRetmax: Number(process.env.RESEARCH_PUBMED_RETMAX ?? 40),
  searxngUrl: process.env.SEARXNG_URL || "http://searxng:8080",
  webResults: Number(process.env.RESEARCH_WEB_RESULTS ?? 5),
  docs: Number(process.env.RESEARCH_DOCS ?? 5),          // texts given to the model
  charsPerDoc: Number(process.env.RESEARCH_CHARS_PER_DOC ?? 1500),
  httpTimeoutMs: Number(process.env.RESEARCH_HTTP_TIMEOUT_MS ?? 15000),
  maxKeywords: Number(process.env.RESEARCH_MAX_KEYWORDS ?? 8),
  resultsPerKeyword: Number(process.env.RESEARCH_RESULTS_PER_KEYWORD ?? 2),
  minSim: Number(process.env.RESEARCH_MIN_SIM ?? process.env.EXPAND_MIN_SIM ?? 0.61),
};

const KEYWORD_SCHEMA = {
  type: "object",
  properties: { keywords: { type: "array", items: { type: "string" } } },
  required: ["keywords"],
};

// The prototype's instruction, kept verbatim so the comparison is with IT.
const INSTRUCTIONS = {
  pubmed: "Extract any keywords related to geospatial or environmental factors from provided PubMed paper abstracts.",
  web: "Extract any keywords related to environmental factors from provided webpage results.",
};

function list(s) {
  return String(s).split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}

/** Request value -> source list. Accepts ["pubmed","web"], "pubmed,web", true, false. */
function resolveSources(value) {
  if (value === undefined || value === null) return CONFIG.sources;
  if (value === true) return ["pubmed", "web"];
  if (value === false) return [];
  const out = Array.isArray(value) ? value.map(v => String(v).toLowerCase()) : list(value);
  return out.filter(s => s === "pubmed" || s === "web");
}

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y || 1);
}

async function fetchText(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CONFIG.httpTimeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (GeoARK research expansion)", ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// --- PubMed -----------------------------------------------------------------

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

function eutilsParams(extra) {
  const p = new URLSearchParams({ tool: CONFIG.ncbiTool, ...extra });
  if (CONFIG.ncbiKey) p.set("api_key", CONFIG.ncbiKey);
  return p;
}

/** Papers about a seed concept's causes / risk factors: [{pmid, title, abstract}]. */
async function pubmedPapers(seedName) {
  // The prototype keeps papers whose SemMedDB relation to the seed is causal;
  // the closest search equivalent is the seed AND a risk-factor vocabulary.
  const term = `("${seedName}"[tiab] OR "${seedName}"[MeSH Terms]) AND ` +
    `("risk factors"[MeSH Terms] OR "environmental exposure"[MeSH Terms] OR risk[tiab] OR exposure[tiab])`;
  const search = JSON.parse(await fetchText(`${EUTILS}/esearch.fcgi?` +
    eutilsParams({ db: "pubmed", term, retmax: String(CONFIG.pubmedRetmax), retmode: "json", sort: "relevance" })));
  const ids = search?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const xml = await fetchText(`${EUTILS}/efetch.fcgi?` +
    eutilsParams({ db: "pubmed", id: ids.join(","), retmode: "xml" }));
  const papers = [];
  for (const block of xml.split("<PubmedArticle>").slice(1)) {
    const pmid = (block.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1];
    const title = stripTags((block.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || [])[1] || "");
    const abstract = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map(m => {
        const label = (m[1].match(/Label="([^"]+)"/) || [])[1];
        return (label ? `${label}: ` : "") + stripTags(m[2]);
      }).join("\n");
    if (pmid && (title || abstract)) papers.push({ id: pmid, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, title, text: abstract });
  }
  return papers;
}

// --- Web (SearXNG) ----------------------------------------------------------

function pageText(html) {
  // The prototype's BeautifulSoup pass: drop script/style/nav/footer, keep text.
  return stripTags(html
    .replace(/<(script|style|nav|footer|noscript|svg|header)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " "));
}

async function webPages(query, log) {
  const body = JSON.parse(await fetchText(`${CONFIG.searxngUrl}/search?` +
    new URLSearchParams({ q: `${query} environmental factors`, format: "json" })));
  const results = (body.results || []).slice(0, CONFIG.webResults * 2);
  const pages = [];
  for (const r of results) {
    if (pages.length >= CONFIG.webResults) break;
    try {
      pages.push({ id: r.url, url: r.url, title: r.title || "", text: pageText(await fetchText(r.url)) });
    } catch (err) {
      log(`   research web: skipped ${r.url} (${err.message})`);
    }
  }
  return pages;
}

// --- shared: rank texts, extract keywords, gate against the catalog ----------

/** The prototype's screening step: rank docs against an environmental-factors question. */
async function screen(docs, question, embed) {
  if (docs.length <= CONFIG.docs) return docs;
  const prompt = `Research question: ${question}\n\nResearch investigating environmental exposures ` +
    `or external conditions and geospatial or contextual factors associated with this health ` +
    `outcome. Exclude papers focused exclusively on clinical treatment or molecular mechanisms.`;
  const vecs = await embed([prompt, ...docs.map(d => `${d.title}\n${d.text}`.slice(0, 2000))]);
  return docs.map((d, i) => ({ ...d, relevance: cosine(vecs[0], vecs[i + 1]) }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, CONFIG.docs);
}

async function extractKeywords(source, question, docs, callLLM) {
  const body = docs.map(d => `TITLE: ${d.title}\n${source === "web" ? `URL: ${d.url}\nTEXT` : "ABSTRACT"}: ` +
    d.text.slice(0, CONFIG.charsPerDoc)).join("\n\n");
  const raw = await callLLM(INSTRUCTIONS[source], `RESEARCH QUESTION: ${question}\n\n${body}`, 0, KEYWORD_SCHEMA);
  if (!raw) return [];
  try {
    const first = new Map();   // first spelling wins
    for (const k of JSON.parse(raw).keywords || []) {
      const n = normalize(k);
      if (n.length >= 3 && !first.has(n)) first.set(n, String(k).trim());
    }
    return [...first.values()];
  } catch {
    return [];
  }
}

/**
 * Run the requested sources and gate their keywords against the catalog.
 *
 * `seeds` are expansion.js's linked conditions (PubMed needs one). Results come
 * back as purpose "expanded" sub-queries, so the planner path treats them like
 * literature expansion: appended last, own quota, own prompt heading.
 * Never throws.
 */
async function researchExpand({ query, sources, seeds = [], search, embed, callLLM,
                                alreadyRetrieved = new Set(), log = () => {} }) {
  const out = { sources, keywords: [], documents: [], results_by_query: [], errors: {} };
  const seen = new Set(alreadyRetrieved);
  const qWords = new Set(normalize(query).split(" "));

  for (const source of sources) {
    const started = Date.now();
    try {
      let docs = [];
      if (source === "pubmed") {
        if (!seeds.length) { out.errors.pubmed = "no condition linked in the question"; continue; }
        for (const s of seeds) docs.push(...await pubmedPapers(s.name));
      } else if (source === "web") {
        docs = await webPages(query, log);
      }
      const ranked = await screen(docs, query, embed);
      const keywords = ranked.length ? await extractKeywords(source, query, ranked, callLLM) : [];
      out.documents.push(...ranked.map(d => ({ source, id: d.id, url: d.url, title: d.title,
                                               relevance: d.relevance ?? null })));
      log(`   research ${source}: ${docs.length} docs, ${ranked.length} read, ` +
          `${keywords.length} keywords in ${Date.now() - started}ms: ${keywords.join("; ")}`);

      let used = 0;
      for (const kw of keywords) {
        const rec = { source, keyword: kw };
        out.keywords.push(rec);
        if (used >= CONFIG.maxKeywords) { rec.kept = false; rec.reason = "keyword cap"; continue; }
        // Same-concept rule from expansion.js: a keyword made only of the
        // question's own words re-finds what decomposition already found.
        if (normalize(kw).split(" ").every(w => qWords.has(w))) {
          rec.kept = false; rec.reason = "same words as the question"; continue;
        }
        used++;
        const results = await search(kw, CONFIG.resultsPerKeyword * 3, "expanded");
        rec.top_similarity = Math.max(0, ...results.map(r => r.semantic_score ?? 0));
        const fresh = results
          .filter(r => !seen.has(r.attr_id) && (r.semantic_score ?? 0) >= CONFIG.minSim)
          .slice(0, CONFIG.resultsPerKeyword);
        if (!fresh.length) {
          rec.kept = false;
          rec.reason = rec.top_similarity < CONFIG.minSim
            ? `best catalog match ${rec.top_similarity} < ${CONFIG.minSim}` : "no new attribute";
          continue;
        }
        rec.kept = true;
        for (const r of fresh) { seen.add(r.attr_id); r.expanded_via = `${kw} (${source})`; }
        out.results_by_query.push({ query: kw, purpose: "expanded", research: rec, results: fresh });
      }
    } catch (err) {
      out.errors[source] = err.message;
      log(`   research ${source} failed, continuing without it: ${err.message}`);
    }
  }
  return out;
}

module.exports = { researchExpand, resolveSources, RESEARCH_CONFIG: CONFIG,
                   _test: { pageText, stripTags, resolveSources } };
