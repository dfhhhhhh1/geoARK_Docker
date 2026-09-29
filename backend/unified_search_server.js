/**
 * Unified Geospatial Search Server
 * =================================
 * 
 * This module unifies three search approaches:
 * 1. Query Decomposition (from enhanced_search_server.js)
 *    - Decomposes natural language queries into primary, normalization, and filter concepts
 * 2. CSV-Based Semantic Search (from multi_search_server.js)
 *    - Uses BAAI/bge-base-en-v1.5 embeddings for semantic similarity
 *    - Performs hybrid search (semantic + keyword) against geoark_attributes.csv
 * 3. LLM Verification (from multi_search_server.js)
 *    - Filters and ranks results to ensure relevance to original query
 * 
 * Pipeline: Decompose Query → Search CSV for each Concept → Verify with LLM → Return Results
 * 
 * Author: Claude (based on Sam Spell's geospatial servers)
 * Date: 2025
 */

const express = require("express");
const cors = require("cors");
const csv = require("csv-parser");
const fs = require("fs");
const { Pool } = require("pg");
const { DECOMPOSITION_SCHEMA, VERIFICATION_SCHEMA } = require("./schemas");
const { generatePlan, executePlan } = require("./planner");
const planOps = require("./planner/ops");
const { callGoogle, googleConfigured } = require("./llm_google");
const {
  buildSuggestions, unavailableDatasets, cityAmbiguity, shortLabel,
} = require("./suggestions");

console.log("  Starting Unified Geospatial Search Server...");

const auth = require("./auth");
const { createLimiter, rateLimit } = require("./ratelimit");
const { createQueue, QueueFullError } = require("./queue");
const { expandQuery, EXPANSION_CONFIG, indexLoaded: expansionIndexLoaded } = require("./expansion");

const app = express();

// nginx is the only thing in front of this, and it sets X-Forwarded-For.
// Without this, req.ip is the proxy's address and every anonymous client shares
// a single rate-limit bucket.
app.set("trust proxy", 1);

// Same-origin in normal operation (nginx serves the SPA and proxies /api), so
// credentials are not sent cross-origin. CORS_ORIGIN exists for running the
// Vite dev server against a container; without it, no cross-origin request may
// carry the session cookie.
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin
  ? { origin: corsOrigin.split(",").map(s => s.trim()), credentials: true }
  : {}));
// Bounded: the analyze body is a short question, and an unbounded parser is a
// free memory-exhaustion primitive on an unauthenticated endpoint.
app.use(express.json({ limit: "256kb" }));

// --- rate limits -------------------------------------------------------------
// Two tiers, because the costs differ by three orders of magnitude: retrieval is
// ~30ms of CPU, an analysis is ~19s of a GPU that can only do one at a time.
const analyzeLimiter = createLimiter({
  name: "analyze",
  capacity: Number(process.env.RATE_ANALYZE_BURST ?? 5),
  perMinute: Number(process.env.RATE_ANALYZE_PER_MIN ?? 6),
});
const searchLimiter = createLimiter({
  name: "search",
  capacity: Number(process.env.RATE_SEARCH_BURST ?? 30),
  perMinute: Number(process.env.RATE_SEARCH_PER_MIN ?? 60),
});
const loginLimiter = createLimiter({
  name: "login",
  capacity: Number(process.env.RATE_LOGIN_BURST ?? 5),
  perMinute: Number(process.env.RATE_LOGIN_PER_MIN ?? 5),
});

const limitAnalyze = rateLimit(analyzeLimiter, auth.identify);
const limitSearch = rateLimit(searchLimiter, auth.identify);
const limitLogin = rateLimit(loginLimiter, auth.identify);

// --- work queue --------------------------------------------------------------
const analysisQueue = createQueue({
  name: "analyze",
  concurrency: Number(process.env.ANALYZE_CONCURRENCY ?? 1),
  maxDepth: Number(process.env.ANALYZE_QUEUE_DEPTH ?? 20),
});

// =============================================================================
// Configuration
// =============================================================================

// Everything addressable is env-driven: inside Docker these resolve to compose
// service names, and outside it they fall back to localhost for `npm run dev`.
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434";
const EMBEDDER_URL = process.env.EMBEDDER_URL || "http://localhost:8000";

const CONFIG = {
  llm: {
    endpoint: `${OLLAMA_URL}/api/chat`,
    model: process.env.LLM_MODEL || "gemma3:4b",
    // Planning is a harder task than decomposition and deserves a bigger model.
    // Observed with gemma3:4b: plans are well-formed, grounded and executable,
    // but semantically mediocre -- given a correctly labelled NORMALIZATION
    // section containing "Estimate|Total|Total population" it still divided one
    // poverty percentage by another. Point PLAN_MODEL at a larger model (e.g.
    // qwen3:14b) where there is RAM for it; it defaults to LLM_MODEL so a
    // single-model deployment still works.
    planModel: process.env.PLAN_MODEL || process.env.LLM_MODEL || "gemma3:4b",
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
    // A local LLM that has been OOM-killed accepts the connection and then
    // never answers. Without a deadline the request hangs until nginx gives
    // up at 300s -- observed wedging an evaluation run for 20+ minutes.
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 90000),
    // Context window per call. Ollama defaults to 4,096, and the planner prompt
    // alone is ~3,600 tokens: once qwen3 reasons past the window, Ollama does a
    // "context shift" that silently DISCARDS the first half of the prompt --
    // the system instructions -- and keeps generating. Seen in the ollama log
    // for "what causes lung cancer in the south". 8,192 fits on a 16 GB card
    // only with an 8-bit KV cache (OLLAMA_KV_CACHE_TYPE=q8_0 on the ollama
    // service).
    //
    // Per MODEL, not global: at 8,192 for both, Ollama's scheduler would no
    // longer keep qwen3:14b and gemma3:4b resident together on 16 GB and
    // evicted one on every switch (logged "predicted to exceed available
    // memory, evicting" with gemma at 4.4 GiB vs 5.5 free). The decomposer's
    // prompts are a few hundred tokens and never needed the larger window.
    // A model always gets the same num_ctx, so no call forces a reload.
    numCtx: Number(process.env.LLM_NUM_CTX ?? 8192),
    smallNumCtx: Number(process.env.LLM_SMALL_NUM_CTX ?? 4096)
  },
  embedder: {
    url: EMBEDDER_URL,
    model: process.env.EMBED_MODEL || "BAAI/bge-base-en-v1.5"
  },
  database: {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "mygisdb",
    user: process.env.PGUSER || "geoark",
    password: process.env.PGPASSWORD || ""
  },
  search: {
    // Semantic and lexical rankings are fused with RRF (see rrfFuse), which
    // needs no relative weighting -- so the old semanticWeight/keywordWeight
    // knobs are gone. RRF_K, BM25_K1, BM25_B and MOE_PENALTY are the tunables.
    topK: Number(process.env.TOP_K ?? 10),
    csvPath: process.env.CSV_PATH || "geoark_attributes.csv"
  },
  server: {
    port: Number(process.env.PORT || 4000)
  }
};

// Database pool for PostGIS queries
const pool = new Pool(CONFIG.database);

// Test connection
pool.query("SELECT 1")
  .then(() => console.log("  PostGIS connection established"))
  .catch(err => console.warn("   PostGIS connection failed:", err.message));

// In-memory storage
let variables = [];
let embeddings = [];
let processedVariablesText = [];
let isEmbeddingsReady = false;
let resolvableCount = null;   // attribute_source rows; null until first checked
let corpusCacheKey = null;    // the embedder cache key these vectors came from

// =============================================================================
// Step 1: Query Decomposition (from enhanced_search_server.js)
// =============================================================================

const DECOMPOSITION_PROMPT = `Extract search terms from this query about geographic/demographic data.

Query: {QUERY}

Return JSON with this exact structure:
{
  "primary_concepts": ["main data variables user wants"],
  "normalization_concepts": ["variables for ratios like population"],
  "filter_concepts": ["filters like rural, urban, high, low"],
  "geographic_level": "county or state or tract or null",
  "search_queries": [
    {"query": "search term", "purpose": "primary"},
    {"query": "another term", "purpose": "normalization"}
  ]
}

Rules:
- Split compound queries into separate search terms
- If user wants "per capita" or "rate", add population to normalization
- Keep search terms short (1-3 words each)
- Return ONLY the JSON object, nothing else`;

/**
 * Call the local LLM for query decomposition
 */
/**
 * POST to the LLM with a hard deadline. Ollama accepts connections even when
 * its model runner is dead, so "no response" is a real and silent failure mode.
 */
/** The planner model gets the large window; everything else the small one. */
function numCtxFor(model) {
  return model === CONFIG.llm.planModel && CONFIG.llm.planModel !== CONFIG.llm.model
    ? CONFIG.llm.numCtx : CONFIG.llm.smallNumCtx;
}

async function llmFetch(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.llm.timeoutMs);
  try {
    return await fetch(CONFIG.llm.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `LLM did not respond within ${CONFIG.llm.timeoutMs}ms. An OOM-killed ` +
        `model runner still accepts connections but never answers -- check ` +
        `the ollama container's State.OOMKilled, and docs/DEPLOYMENT.md #7.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param schema  optional JSON Schema. When given, Ollama constrains sampling
 *                to it, so the response is valid JSON matching the shape --
 *                no fence-stripping, no regex extraction, no repair.
 */
async function callLLM(systemPrompt, userPrompt, temperature = 0.2, schema = null,
                       model = CONFIG.llm.model, extra = {}) {
  try {
    console.log(`   Calling LLM (${model})...`);
    
    // BOTH messages must be sent. This previously read
    //     messages: [{ role: "user", content: systemPrompt }]
    // which silently discarded userPrompt -- the second parameter was accepted
    // and never referenced.
    //
    // Decomposition survived that because it interpolates the query into its
    // FIRST argument (DECOMPOSITION_PROMPT.replace("{QUERY}", query)), so the
    // dropped argument was redundant there. Planning did not: generatePlan puts
    // the question and the whole AVAILABLE ATTRIBUTES list in userPrompt, so
    // the planner never saw either one. It was working from the system prompt
    // alone -- rules and worked examples -- which is why it emitted the example
    // labels (a3, a8, a5) verbatim. Those always dereference to SOME candidate,
    // so grounding passed and every plan validated on the first attempt while
    // being unrelated to the question: "how many hospitals are in each county"
    // planned a count over Oil And Natural Gas Wells.
    //
    // Measured before the fix (eval/plan_probe.py, PLAN_MODEL=qwen3:14b):
    // op appropriateness 50.0%, and 8 of 8 intents describing something the
    // user had not asked about.
    const response = await llmFetch({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...(userPrompt ? [{ role: "user", content: userPrompt }] : []),
      ],
      stream: false,
      ...(schema ? { format: schema } : {}),
      // Sampling settings MUST be inside `options`. This used to send
      // `temperature` at the top level, which Ollama ignores without error, so
      // every call ran at the model's own default: 0.6 for qwen3:14b and 1.0
      // for gemma3:4b -- not the 0.1-0.2 every measurement in CLAUDE.md
      // assumed. Verified: top-level temperature 0 logged "temp = 1.000",
      // options.temperature 0 logged "temp = 0.000".
      options: { temperature, num_ctx: numCtxFor(model), ...(extra.options || {}) },
      ...(extra.think !== undefined ? { think: extra.think } : {}),
    });
    
    if (!response.ok) {
      throw new Error(`LLM returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    const content = data.message?.content || data.response || "";
    
    console.log(`   LLM response: ${content.length} chars`);
    
    return content;
  } catch (error) {
    console.error(`   LLM call failed: ${error.message}`);
    return null;
  }
}

/**
 * Decompose a query into multiple search concepts
 */
async function decomposeQuery(query) {
  console.log(`\nDecomposing query: "${query}"`);
  
  try {
    const prompt = DECOMPOSITION_PROMPT.replace("{QUERY}", query);
    // Constrained decoding: the response is guaranteed to parse and to match
    // DECOMPOSITION_SCHEMA, so the old ladder of ```json fence-stripping and
    // /\{[\s\S]*\}/ extraction is gone.
    const response = await callLLM(prompt, query, CONFIG.llm.temperature,
                                   DECOMPOSITION_SCHEMA);

    if (!response || response.length < 10) {
      console.log(`   Empty response, using smart fallback`);
      return createSmartFallback(query);
    }

    let result;
    try {
      result = JSON.parse(response);

      // The schema guarantees shape, not usefulness: a model can still return
      // an empty search_queries array.
      if (!Array.isArray(result.search_queries) || result.search_queries.length === 0) {
        console.log(`   No search queries produced, using smart fallback`);
        return createSmartFallback(query);
      }

    } catch (parseError) {
      console.log(`   JSON parse failed: ${parseError.message}`);
      return createSmartFallback(query);
    }
    
    console.log(`   Decomposed into ${result.search_queries?.length || 0} search queries`);
    return result;
    
  } catch (error) {
    console.error(`   Decomposition failed: ${error.message}`);
    return createSmartFallback(query);
  }
}

/**
 * Create a smart fallback decomposition without LLM
 */
function createSmartFallback(query) {
  console.log(`   Creating smart fallback decomposition`);
  
  const lowerQuery = query.toLowerCase();
  const searchQueries = [];
  const primaryConcepts = [];
  const normalizationConcepts = [];
  const filterConcepts = [];
  
  // Common normalization keywords
  const normalizationKeywords = [
    'per capita', 'per person', 'normalized', 'per 100', 'per 1000',
    'rate', 'percentage', 'percent', 'ratio', 'by population'
  ];
  
  // Common filter keywords
  const filterKeywords = [
    'rural', 'urban', 'suburban', 'metro', 'high', 'low', 
    'above', 'below', 'greater', 'less', 'over', 'under'
  ];
  
  // Common geographic keywords
  const geoKeywords = ['county', 'state', 'tract', 'block', 'zip', 'city', 'region'];
  
  // Check for normalization patterns
  let needsNormalization = false;
  for (const keyword of normalizationKeywords) {
    if (lowerQuery.includes(keyword)) {
      needsNormalization = true;
      break;
    }
  }
  
  // Split query by common delimiters
  const parts = query
    .split(/[,;]|\band\b|\bor\b|\bwith\b|\bfor\b|\bby\b|\bin\b/i)
    .map(p => p.trim())
    .filter(p => p.length > 2);
  
  // Process each part
  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    
    // Check if it's a filter
    let isFilter = false;
    for (const keyword of filterKeywords) {
      if (lowerPart.includes(keyword)) {
        isFilter = true;
        filterConcepts.push(part);
        searchQueries.push({ query: part, purpose: 'filter' });
        break;
      }
    }
    
    // Check if it's geographic
    let isGeo = false;
    for (const keyword of geoKeywords) {
      if (lowerPart.includes(keyword)) {
        isGeo = true;
        break;
      }
    }
    
    // If not a filter or geo term, it's probably a primary concept
    if (!isFilter && !isGeo && part.length > 3) {
      primaryConcepts.push(part);
      searchQueries.push({ query: part, purpose: 'primary' });
    }
  }
  
  // If we need normalization, add population search
  if (needsNormalization) {
    normalizationConcepts.push('population');
    searchQueries.push({ query: 'total population', purpose: 'normalization' });
  }
  
  // If no concepts found, use the whole query
  if (searchQueries.length === 0) {
    searchQueries.push({ query: query, purpose: 'primary' });
    primaryConcepts.push(query);
  }
  
  // Detect geographic level
  let geographicLevel = null;
  for (const keyword of geoKeywords) {
    if (lowerQuery.includes(keyword)) {
      geographicLevel = keyword;
      break;
    }
  }
  
  return {
    primary_concepts: primaryConcepts,
    normalization_concepts: normalizationConcepts,
    filter_concepts: filterConcepts,
    geographic_level: geographicLevel,
    search_queries: searchQueries,
    fallback_used: true
  };
}

// =============================================================================
// Step 2: CSV Loading and BGE Embeddings (from multi_search_server.js)
// =============================================================================

/**
 * Create embedding text from CSV row
 */
function createEmbeddingText(row) {
  const parts = [];
  
  // Include dataset context
  if (row.dataset_clean) parts.push(row.dataset_clean.trim());
  if (row.source_folder) parts.push(row.source_folder.trim());
  
  // Include attribute info
  if (row.attr_desc) parts.push(row.attr_desc.trim());
  // The generated one-sentence description, for rows whose attr_desc is a bare
  // column name. 392 facility rows have an attr_desc of "Name" or "Objectid",
  // and about a third of the county-measure rows are two words; those carry
  // almost no text for retrieval to match on. The generator has existed in
  // etl/ingest.py all along and its output was discarded -- see
  // etl/backfill_gen_desc.py. Placed next to attr_desc because it is the same
  // KIND of signal, and only present where the real description was thin, so
  // rows with a good attr_desc are unaffected.
  // The lead-in is stripped. Every generated sentence opens "This column
  // contains the ..." -- identical across all 2,642 of them -- and including it
  // adds the same tokens to thousands of rows, which makes them LESS
  // distinguishable rather than more. Measured: with the boilerplate in,
  // known-item MRR fell 0.958 -> 0.944 while recall@1 held, which is the
  // signature of a diluted vector space rather than a wrong one.
  if (row.gen_desc) {
    const cleaned = row.gen_desc
      .replace(/^\s*(this|the)\s+(column|field|attribute)\s+(contains|holds|represents|stores|indicates|provides)\s+(the|a|an)?\s*/i, '')
      .trim();
    if (cleaned) parts.push(cleaned);
  }
  if (row.attr_orig) parts.push(row.attr_orig.replace(/_/g, ' ').trim());
  
  // Include tags (most important for search)
  if (row.tags) {
    try {
      const cleanTags = row.tags
        .replace(/[\[\]'\"]/g, '')
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);
      parts.push(...cleanTags);
    } catch (e) {
      parts.push(row.tags.trim());
    }
  }
  
  // Include entity type
  if (row.entity_type) parts.push(row.entity_type.trim());

  // Include the temporal range in words. Users routinely ask for "2015" or
  // "recent" data, and without this the years are invisible to both the
  // embedding and BM25.
  const start = (row.start_date || '').trim();
  const end = (row.end_date || '').trim();
  if (start && end && start !== end) parts.push(`${start} to ${end}`);
  else if (start) parts.push(start);

  return parts.join(' ').toLowerCase();
}

/**
 * Load variables from CSV (compatible with attr_gen_copy.py format)
 */
async function loadVariablesFromCSV(csvFilePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        const embeddingText = createEmbeddingText(row);
        
        results.push({
          // IDs for database lookup
          dataset_id: row.dataset_id || '',
          table_name: row.table_name || '',
          attr_id: row.attr_label || '',
          attr_orig: row.attr_orig || '',
          
          // Display info
          dataset_clean: row.dataset_clean || '',
          attr_desc: row.attr_desc || '',
          source_folder: row.source_folder || '',
          
          // Metadata
          tags: row.tags || '',
          entity_type: row.entity_type || '',
          spatial_rep: row.spatial_rep || '',
          start_date: row.start_date || '',
          end_date: row.end_date || '',
          
          // For embedding
          embeddingText: embeddingText
        });
      })
      .on('end', () => {
        console.log(`  Loaded ${results.length} variables from CSV`);
        resolve(results);
      })
      .on('error', reject);
  });
}

// =============================================================================
// Embeddings (delegated to the `embedder` service)
// =============================================================================
//
// This used to write a temp .py file, spawn python3, and construct a
// SentenceTransformer -- per call. Every single search query paid a full model
// load (2-6s), and startup re-embedded the whole catalog from scratch.
//
// The embedder service loads the model once at ITS start and caches the corpus
// matrix to a volume, so this is now just an HTTP round trip (~20ms).

/**
 * Fetch with a timeout, so a wedged embedder surfaces as an error instead of
 * hanging the request forever.
 */
async function fetchJSON(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed texts. `isQuery` applies the BGE query prefix on the embedder side.
 * Returns { embeddings, processed_texts, dimension }.
 */
async function generateEmbeddings(texts, isQuery = false) {
  return fetchJSON(`${CONFIG.embedder.url}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, is_query: isQuery })
  });
}

/**
 * Wait for the embedder to come up. Compose start order is not start *readiness*
 * -- on a cold volume the embedder spends minutes downloading the model, and the
 * API must not crash-loop through that.
 */
async function waitForEmbedder(maxWaitMs = 900000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < maxWaitMs) {
    try {
      const health = await fetchJSON(`${CONFIG.embedder.url}/health`, {}, 5000);
      if (health.status === "ok") return health;
    } catch (err) {
      lastError = err.message;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    console.log(`   waiting for embedder at ${CONFIG.embedder.url} (${waited}s)...`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`embedder never became ready (last error: ${lastError})`);
}

// =============================================================================
// Step 3: Hybrid Search (Semantic + Keyword)
// =============================================================================

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must be the same length');
  }
  
  let dotProduct = 0, normA = 0, normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  
  if (normA === 0 || normB === 0) {
    return 0;
  }
  
  return dotProduct / (normA * normB);
}

/**
 * Simple keyword match score
 */
// -----------------------------------------------------------------------------
// Lexical scoring: BM25
// -----------------------------------------------------------------------------
//
// This replaces a substring-overlap counter that scored:
//
//     query "people who cannot afford medical coverage"
//     row   "Households not receiving food stamps/SNAP"      -> 0.833
//
// It matched `tWord.includes(qWord) || qWord.includes(tWord)` against
// UNFILTERED row tokens, so short stopword-ish tokens matched almost anything.
// Nearly every row scored 0.6-0.85, which means the "keyword" term was not
// ranking signal at all -- it was noise reshuffling the semantic ranking.
//
// BM25 fixes both halves: exact token matching, and IDF weighting so a rare
// term like "refinery" counts for far more than "total".

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "are", "was", "were", "has",
  "have", "had", "not", "but", "all", "any", "can", "who", "how", "what",
  "where", "which", "there", "their", "them", "they", "from", "into", "than",
  "then", "some", "such", "only", "own", "same", "very", "one", "many", "much",
  "lot", "lots", "get", "got", "you", "your", "our", "its", "his", "her",
  "people", "place", "places", "area", "areas", "show", "give", "find", "want",
  "data", "dataset", "datasets", "variable", "variables", "level", "levels"
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

// Standard BM25 constants: k1 controls term-frequency saturation, b controls
// length normalization.
const BM25_K1 = Number(process.env.BM25_K1 ?? 1.2);
const BM25_B = Number(process.env.BM25_B ?? 0.75);

let bm25 = null;   // { docs, df, idf, avgdl, N }, built once at startup

/**
 * Build the inverted-index statistics BM25 needs. O(corpus), done once.
 */
function buildLexicalIndex(processedTexts) {
  const docs = processedTexts.map(t => {
    const tf = new Map();
    const tokens = tokenize(t);
    for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
    return { tf, len: tokens.length };
  });

  const df = new Map();
  for (const d of docs) for (const tok of d.tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);

  const N = docs.length;
  const idf = new Map();
  for (const [tok, n] of df) {
    // BM25 IDF with the +1 smoothing that keeps it non-negative for common terms.
    idf.set(tok, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const avgdl = docs.reduce((a, d) => a + d.len, 0) / (N || 1);
  bm25 = { docs, idf, avgdl, N };
  console.log(`  Lexical index: ${N} docs, ${idf.size} terms, avg length ${avgdl.toFixed(1)}`);
}

function bm25Score(queryTokens, index) {
  const doc = bm25.docs[index];
  if (!doc || doc.len === 0) return 0;
  let score = 0;
  for (const tok of queryTokens) {
    const f = doc.tf.get(tok);
    if (!f) continue;
    const idf = bm25.idf.get(tok) || 0;
    score += idf * (f * (BM25_K1 + 1)) /
             (f + BM25_K1 * (1 - BM25_B + BM25_B * doc.len / bm25.avgdl));
  }
  return score;
}

// -----------------------------------------------------------------------------
// Margin-of-error demotion
// -----------------------------------------------------------------------------
//
// ~900 catalog rows are ACS margin-of-error companions ("Margin of Error|Total
// MOE|..."). They are legitimate data, but they are near-duplicates of the
// estimate rows they accompany, so they crowd real answers out of the top 20.
// Someone searching "poverty rate" wants the estimate, not its error bar.
//
// Demote rather than filter: they stay reachable, they just stop dominating.
// Set MOE_PENALTY=1 to disable.
const MOE_PENALTY = Number(process.env.MOE_PENALTY ?? 0.5);
const MOE_RE = /margin of error|\bMOE\b/i;

function isMarginOfError(v) {
  return MOE_RE.test(v.attr_desc || "") || MOE_RE.test(v.tags || "");
}

// -----------------------------------------------------------------------------
// Reciprocal Rank Fusion
// -----------------------------------------------------------------------------
//
// The previous blend was `0.7 * cosine + 0.3 * keywordScore`, which compares a
// bounded 0-1 similarity against an unbounded, differently-distributed lexical
// score -- so the weights never meant what they looked like, and re-tuning them
// on a new corpus was guesswork.
//
// RRF fuses RANKS instead of scores: score = sum over rankings of 1/(k + rank).
// It needs no score normalization and no per-corpus tuning. k=60 is the value
// from the original paper and is what most implementations use.
const RRF_K = Number(process.env.RRF_K ?? 60);

function rrfFuse(rankings) {
  const fused = new Map();
  for (const ranking of rankings) {
    ranking.forEach((index, i) => {
      fused.set(index, (fused.get(index) || 0) + 1 / (RRF_K + i + 1));
    });
  }
  return fused;
}

async function performHybridSearch(query, topK = 20, searchPurpose = 'primary') {
  if (!isEmbeddingsReady) {
    throw new Error("Embeddings not ready");
  }

  console.log(`   Hybrid search for: "${query}" (${searchPurpose})`);

  const queryEmbeddingResult = await generateEmbeddings([query], true);
  const queryEmbedding = queryEmbeddingResult.embeddings[0];
  const processedQuery = queryEmbeddingResult.processed_texts[0];
  const queryTokens = tokenize(processedQuery);

  // Score every row on both axes independently. They are never added together;
  // each produces its own ranking, and the ranks are what get fused.
  const semantic = new Array(embeddings.length);
  const lexical = new Array(embeddings.length);
  for (let i = 0; i < embeddings.length; i++) {
    semantic[i] = cosineSimilarity(queryEmbedding, embeddings[i]);
    lexical[i] = bm25 ? bm25Score(queryTokens, i) : 0;
  }

  // Fusing full rankings would let a row ranked 4000th by BM25 contribute
  // noise. Only the plausible head of each list takes part, which is also what
  // makes this cheap.
  const CANDIDATE_DEPTH = Math.max(topK * 5, 100);

  // `minScore` matters for the lexical list. BM25 is 0 for any row sharing no
  // query term, and most rows do share none -- so without this filter the tail
  // of the candidate slice would be zero-scoring rows receiving RRF credit as
  // though they were lexical matches, which is exactly the kind of noise this
  // change set out to remove.
  const byScore = (arr, minScore = -Infinity) =>
    Array.from(arr.keys())
      .filter(i => arr[i] > minScore)
      .sort((a, b) => arr[b] - arr[a])
      .slice(0, CANDIDATE_DEPTH);

  const semanticRanking = byScore(semantic);
  const lexicalRanking = queryTokens.length ? byScore(lexical, 0) : [];

  const fused = rrfFuse(lexicalRanking.length ? [semanticRanking, lexicalRanking]
                                              : [semanticRanking]);

  const ranked = Array.from(fused.entries())
    .map(([index, score]) => ({
      index,
      fused_score: score * (isMarginOfError(variables[index]) ? MOE_PENALTY : 1)
    }))
    .sort((a, b) => b.fused_score - a.fused_score)
    .slice(0, topK);

  const topResults = ranked.map(({ index, fused_score }) => {
    const v = variables[index];
    return {
      dataset_id: v.dataset_id,
      table_name: v.table_name,
      attr_id: v.attr_id,
      attr_orig: v.attr_orig,
      dataset_clean: v.dataset_clean,
      attr_desc: v.attr_desc,
      tags: v.tags,
      entity_type: v.entity_type,
      spatial_rep: v.spatial_rep,
      source_folder: v.source_folder,
      // These were loaded from the CSV but never returned, so neither the UI
      // nor any consumer could see a variable's time coverage.
      start_date: v.start_date,
      end_date: v.end_date,
      semantic_score: Math.round(semantic[index] * 1000) / 1000,
      keyword_score: Math.round(lexical[index] * 1000) / 1000,   // BM25, unbounded
      hybrid_score: Math.round(fused_score * 100000) / 100000,   // RRF, ~0-0.033
      search_purpose: searchPurpose
    };
  });

  console.log(`   Found ${topResults.length} results (top RRF: ${topResults[0]?.hybrid_score ?? 'N/A'})`);

  return topResults;
}

// =============================================================================
// Step 4: LLM Verification and Filtering
// =============================================================================

/**
 * Use LLM to filter and verify search results
 */
async function verifyResultsWithLLM(originalQuery, decomposition, allResults) {
  console.log(`\n  Verifying results with LLM...`);
  
  const systemPrompt = `You are a geospatial data expert. 
  Compare the user query to the search results. 
  Return a JSON object with two keys:
  "reasoning": a brief explanation of why these match and/or why some of them were pruned.
  "keep_ids": an array of attr_id strings that directly answer the query.
  
  Return ONLY valid JSON.`;

  const userPrompt = `Query: "${originalQuery}"
  Concepts: ${JSON.stringify(decomposition.primary_concepts)}
  Results: ${JSON.stringify(allResults.map(r => ({ id: r.attr_id, desc: r.attr_desc })))}
  
  JSON format: {"reasoning": "...", "keep_ids": ["id1", "id2"]}
  
  Instructions:
    1. Match the 'results' against the 'primary_concepts'.
    2. If a result is just a 'Margin of Error' and an 'Estimate' exists for the same data, prioritize the 'Estimate'.
    3. Double-check: Does your list of keep_ids cover all primary_concepts? If not, add the next best match for the missing concept.
  `;

  try {
    const responseRaw = await llmFetch({
      model: CONFIG.llm.model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      format: VERIFICATION_SCHEMA,   // constrained to {reasoning, keep_ids}
      stream: false,
      options: { temperature: 0.1, num_ctx: numCtxFor(CONFIG.llm.model) }
    });
    
    
    const data = await responseRaw.json();
    const content = data.message?.content || "";

    // VERIFICATION_SCHEMA constrains this response, so it parses or the model
    // returned nothing at all. No extraction fallback needed.
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.warn(`     Verification response did not parse: ${e.message}`);
      parsed = null;
    }

    const keepIds = parsed?.keep_ids || [];
    console.log(`    Reasoning: ${parsed?.reasoning || "None provided"}`);
    const reasoning = parsed?.reasoning || "No reasoning provided by LLM.";
    const filtered = allResults.filter(r => keepIds.includes(r.attr_id));
    
    if (filtered.length === 0) {
      console.log(`     LLM returned 0 results. Falling back to top 5 hybrid matches.`);
      return { 
        results: allResults.slice(0, 5), 
        reasoning: "LLM filtered out all results. Showing top 5 hybrid matches as fallback." 
      };
    }

    console.log(`     LLM filtered: ${allResults.length} → ${filtered.length} results`);
    return { results: filtered, reasoning: reasoning };

  } catch (error) {
    console.error(`     Verification Error: ${error.message}`);
    return { results: allResults.slice(0, 5), reasoning: "Verification failed due to error." };
  }
}

// =============================================================================
// Main Pipeline: Unified Enhanced Search
// =============================================================================

/**
 * Main search pipeline combining all three approaches
 */
async function unifiedSearch(query, options = {}) {
  const {
    useLLMFilter = true,
    topKPerConcept = CONFIG.search.topK,
    // Literature expansion (backend/expansion.js). Defaults to EXPAND_ENABLED;
    // requests may override it, so an A/B needs no container recreate.
    expand = EXPANSION_CONFIG.enabled
  } = options;
  
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  UNIFIED SEARCH PIPELINE`);
  console.log(`Query: "${query}"`);
  console.log(`Total Budget (K): ${topKPerConcept}`);
  console.log(`${'='.repeat(80)}`);
  
  // STEP 1: Decompose Query
  console.log(`\n[STEP 1] Query Decomposition`);
  const decomposition = await decomposeQuery(query);
  const queryCount = decomposition.search_queries.length; //# of queries

  const calculatedLimit = Math.max(1, Math.floor(topKPerConcept / queryCount));
  console.log(`   Primary: ${decomposition.primary_concepts.length} concepts`);
  console.log(`   Normalization: ${decomposition.normalization_concepts.length} concepts`);
  console.log(`   Filter: ${decomposition.filter_concepts.length} concepts`);
  console.log(`   Search queries: ${queryCount}`);
  console.log(`   Results per query: ${calculatedLimit}`);
  
  // STEP 2: Search CSV for each concept
  console.log(`\n[STEP 2] CSV-Based Hybrid Search`);
  
  const allResults = [];
  const resultsByQuery = [];
  
  for (const searchQuery of decomposition.search_queries) {
    console.log(`\n   → Searching: "${searchQuery.query}" (${searchQuery.purpose})`);
    
    const results = await performHybridSearch(
      searchQuery.query,
      calculatedLimit,
      searchQuery.purpose
    );
    
    resultsByQuery.push({
      query: searchQuery.query,
      purpose: searchQuery.purpose,
      results: results
    });
    
    allResults.push(...results);
  }

  // STEP 2b: Literature expansion. Appended AFTER every decomposed sub-query,
  // so it cannot change the rank of anything the decomposer asked for; it can
  // only add attributes the question never named.
  let expansion = null;
  if (expand) {
    console.log(`
[STEP 2b] Literature expansion`);
    expansion = await expandQuery({
      pool, query, decomposition,
      search: performHybridSearch,
      embed: async (texts) => (await generateEmbeddings(texts, false)).embeddings,
      // The same phrasing test that offers `explain` to the planner, so the
      // expansion and the op agree about what kind of question this is.
      causesFirst: planOps.byName("explain").offered({ query, hasNeighbors: true }),
      alreadyRetrieved: new Set(allResults.map(r => r.attr_id)),
      log: (m) => console.log(m),
    });
    for (const rq of expansion.results_by_query) {
      resultsByQuery.push(rq);
      allResults.push(...rq.results);
    }
  }
  
  // Remove duplicates based on attr_id
  const uniqueResults = [];
  const seenAttrIds = new Set();
  
  for (const result of allResults) {
    if (!seenAttrIds.has(result.attr_id)) {
      seenAttrIds.add(result.attr_id);
      uniqueResults.push(result);
    }
  }
  
  console.log(`\n   Total results: ${allResults.length}`);
  console.log(`   Unique results: ${uniqueResults.length}`);
  
  // STEP 3: LLM Verification (optional)
  let finalResults = uniqueResults;
  let llmReasoning = null;
  
  if (useLLMFilter && uniqueResults.length > 0) {
    const verification = await verifyResultsWithLLM(query, decomposition, uniqueResults);
    finalResults = verification.results;
    llmReasoning = verification.reasoning;
  } else {
    console.log(`\n[STEP 3] Skipping LLM verification`);
  }
  
  // Organize results by purpose
  const resultsByPurpose = {
    primary: finalResults.filter(r => r.search_purpose === 'primary'),
    normalization: finalResults.filter(r => r.search_purpose === 'normalization'),
    filter: finalResults.filter(r => r.search_purpose === 'filter'),
    related: finalResults.filter(r => r.search_purpose === 'related'),
    expanded: finalResults.filter(r => r.search_purpose === 'expanded')
  };
  
  const elapsed = Date.now() - startTime;
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`   UNIFIED SEARCH COMPLETE (${elapsed}ms)`);
  console.log(`   Primary: ${resultsByPurpose.primary.length}`);
  console.log(`   Normalization: ${resultsByPurpose.normalization.length}`);
  console.log(`   Filter: ${resultsByPurpose.filter.length}`);
  console.log(`   Total: ${finalResults.length}`);
  console.log(`${'='.repeat(80)}\n`);
  
  return {
    query,
    decomposition,
    // Which concepts were linked, what was related to them, and why each
    // related concept was kept or skipped. null when expansion was off.
    expansion,
    llm_reasoning: llmReasoning,
    results_by_query: resultsByQuery,
    results_by_purpose: resultsByPurpose,
    all_results: finalResults,
    stats: {
      total_results: finalResults.length,
      unique_results: uniqueResults.length,
      primary_count: resultsByPurpose.primary.length,
      normalization_count: resultsByPurpose.normalization.length,
      filter_count: resultsByPurpose.filter.length,
      processing_time_ms: elapsed,
      llm_filtered: useLLMFilter,
      fallback_used: decomposition.fallback_used || false
    }
  };
}

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * GET /api/session, whether this instance needs a code, and whether we have one.
 * Unauthenticated by necessity: the UI calls it to decide whether to show a
 * login screen at all.
 */
app.get("/api/session", (req, res) => {
  const claims = auth.verifyToken(auth.readCookie(req, auth.COOKIE_NAME));
  res.json({
    auth_required: auth.AUTH_ENABLED,
    signed_in: Boolean(claims) || !auth.AUTH_ENABLED,
    expires_at: claims?.exp ?? null,
  });
});

/** POST /api/login, exchange an access code for a session cookie. */
app.post("/api/login", limitLogin, (req, res) => {
  if (!auth.AUTH_ENABLED) {
    return res.json({ signed_in: true, auth_required: false });
  }
  const { code } = req.body || {};
  if (!auth.checkCode(code)) {
    // Deliberately vague, and rate limited above: distinguishing "no such code"
    // from "wrong code" would turn this into an oracle.
    return res.status(401).json({ error: "invalid access code" });
  }
  // The subject is a fingerprint of the code, never the code itself -- it ends
  // up in a cookie the client can read the length of, and in rate-limit keys.
  const subject = require("crypto").createHash("sha256")
    .update(String(code)).digest("hex").slice(0, 16);
  auth.setSessionCookie(req, res, auth.issueToken(subject));
  res.json({ signed_in: true, auth_required: true });
});

/** POST /api/logout */
app.post("/api/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ signed_in: false, auth_required: auth.AUTH_ENABLED });
});

/**
 * POST /api/unified-search
 * Main unified search endpoint
 */
app.post("/api/unified-search", auth.requireAuth, limitSearch, async (req, res) => {
  try {
    if (!isEmbeddingsReady) {
      return res.status(503).json({ error: "Embeddings not ready" });
    }
    
    // use_llm_filter now defaults to FALSE. Measured over 32 eval queries,
    // enabling it costs 10pp of concept recall (97.5% -> 87.5%) and 12.5pp of
    // query success, and adds ~7.7s per request. It does improve MRR
    // (0.726 -> 0.874), which is the tell: it ranks well but deletes far too
    // much -- on one sample query it cut 18 retrieved rows to 3. That is a
    // reranker's job, and a cross-encoder should replace it (docs/AI-PIPELINE.md
    // section 4). Until then, opt in explicitly if you want the ranking.
    const { q: query, use_llm_filter = false, top_k = 10, expand } = req.body;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: "Query 'q' is required" });
    }
    
    const results = await unifiedSearch(query, {
      useLLMFilter: use_llm_filter,
      topKPerConcept: top_k,
      ...(typeof expand === "boolean" ? { expand } : {})
    });
    
    res.json(results);
    
  } catch (error) {
    console.error("Unified search error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/decompose-query
 * Just decompose a query (for testing)
 */
app.post("/api/decompose-query", auth.requireAuth, limitSearch, async (req, res) => {
  try {
    const { q: query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: "Query 'q' is required" });
    }
    
    const decomposition = await decomposeQuery(query);
    res.json(decomposition);
    
  } catch (error) {
    console.error("Decomposition error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/search
 * Simple hybrid search (backward compatible)
 */
app.get("/api/search", auth.requireAuth, limitSearch, async (req, res) => {
  try {
    if (!isEmbeddingsReady) {
      return res.status(503).json({ error: "Embeddings not ready" });
    }
    
    const query = req.query.q;
    if (!query) {
      return res.json([]);
    }
    
    const results = await performHybridSearch(query, 20);
    res.json(results);
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/health
 */
// =============================================================================
// Step 5: Analysis, plan generation and execution
// =============================================================================

/**
 * Has the embedder's corpus changed since we cached it?
 *
 * The API pulls all 6,860 vectors once at startup and holds them for its whole
 * life. If the embedder is rebuilt -- new model, changed preprocessing, edited
 * catalog -- this process keeps serving the OLD vectors while the embedder
 * embeds queries with the NEW model. Document and query vectors then live in
 * different spaces and every result is quietly wrong.
 *
 * This cost real time: an entire tag-ablation experiment was measured against a
 * stale cache and produced a confident, completely wrong conclusion, because
 * `docker compose up -d api` does not recreate a container whose image is
 * unchanged. Nothing anywhere reported the mismatch.
 */
async function checkCorpusFreshness() {
  try {
    const health = await fetchJSON(`${CONFIG.embedder.url}/health`, {}, 5000);
    const current = health.cache_key;
    if (current && corpusCacheKey && current !== corpusCacheKey) {
      return { stale: true, held: corpusCacheKey, available: current };
    }
    return { stale: false, held: corpusCacheKey, available: current || corpusCacheKey };
  } catch (err) {
    return { stale: null, error: err.message, held: corpusCacheKey };
  }
}

/**
 * Refetch the corpus without restarting. Cheap enough to be the obvious fix
 * once staleness is detected.
 */
async function reloadCorpus() {
  const corpus = await fetchJSON(`${CONFIG.embedder.url}/corpus/vectors`, {}, 600000);
  if (corpus.count !== variables.length) {
    throw new Error(
      `corpus/CSV row mismatch on reload: embedder has ${corpus.count}, this ` +
      `process loaded ${variables.length}. Restart the API so both re-read the CSV.`);
  }
  embeddings = corpus.embeddings;
  processedVariablesText = corpus.processed_texts;
  corpusCacheKey = corpus.cache_key;
  buildLexicalIndex(processedVariablesText);
  return { rows: corpus.count, cache_key: corpus.cache_key };
}

app.post("/api/reload-corpus", auth.requireAuth, limitAnalyze, async (req, res) => {
  try {
    const before = corpusCacheKey;
    const result = await reloadCorpus();
    console.log(`  Corpus reloaded: ${before} -> ${result.cache_key}`);
    res.json({ reloaded: true, previous_cache_key: before, ...result });
  } catch (err) {
    res.status(500).json({ error: "reload failed", details: err.message });
  }
});

/**
 * Resolve catalog attr_ids to their physical location.
 *
 * This is the grounding check. An attr_id absent from attribute_source cannot
 * be executed, so a plan referencing one is rejected before any SQL is built.
 */
/**
 * Label columns a feature layer may carry. Coverage across the 69 layers,
 * measured: county/state 54%, name 49%, status 43%, city 41%, type 38%,
 * address 35%. Nothing is universal, so anything selecting them has to ask
 * which exist rather than assume.
 *
 * `city` earns its place here because there is no city boundary layer in the
 * database -- county_geom is the only administrative geometry -- so "hospitals
 * in Springfield" can only be answered from the layer's own attributes.
 */
const FEATURE_LABEL_COLUMNS =
  ["name", "city", "state", "county", "address", "type", "status", "zip", "owner"];

/**
 * Columns worth enumerating the values of.
 *
 * Deliberately not all of FEATURE_LABEL_COLUMNS: `name` and `address` are
 * near-unique, `city` and `zip` run to thousands. Enumerating those would be a
 * large query returning something no model could use. These three are the
 * categorical ones -- hospital `type` is CRITICAL ACCESS / GENERAL ACUTE CARE /
 * PSYCHIATRIC, `status` is OPEN / CLOSED.
 */
const FILTERABLE_COLUMNS = ["type", "status", "owner"];

/** Above this many distinct values a column is not a filter, it is free text. */
const MAX_FILTER_VALUES = 25;

/**
 * The values each filterable column actually holds, per layer.
 *
 * THIS IS WHAT MAKES ATTRIBUTE FILTERS GROUNDED. Without it the planner would
 * be guessing strings -- "Critical Access", "critical_access", "CriticalAccess"
 * -- and every near-miss returns zero rows while looking like a valid answer.
 * Offering the real values turns the filter into a choice from a list, which is
 * the same discipline attr_ids already follow.
 *
 * Lazy and cached per table: computed only for layers that actually reach the
 * planner, and only once. The first request touching a large layer pays a
 * GROUP BY over it; every later one pays nothing.
 */
const filterValuesCache = new Map();
async function featureFilterValues(tableName, availableColumns) {
  if (filterValuesCache.has(tableName)) return filterValuesCache.get(tableName);

  const cols = FILTERABLE_COLUMNS.filter(c => (availableColumns || []).includes(c));
  if (!cols.length) {
    filterValuesCache.set(tableName, {});
    return {};
  }
  // Identifiers come from information_schema and a fixed allow-list, never from
  // the model, and are pattern-checked before interpolation regardless.
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(tableName)) return {};

  const sql = cols
    .map(c => `SELECT '${c}' AS col, ${c}::text AS val, count(*)::int AS n ` +
              `FROM ${tableName} WHERE ${c} IS NOT NULL AND ${c}::text <> '' GROUP BY 2`)
    .join(" UNION ALL ");

  let out = {};
  try {
    const { rows } = await pool.query(sql);
    const grouped = new Map();
    for (const r of rows) {
      if (!grouped.has(r.col)) grouped.set(r.col, []);
      grouped.get(r.col).push({ value: r.val, count: r.n });
    }
    for (const [col, vals] of grouped) {
      // A column with hundreds of values is free text, not a category.
      if (vals.length > MAX_FILTER_VALUES) continue;
      out[col] = vals.sort((a, b) => b.count - a.count).map(v => v.value);
    }
  } catch (err) {
    // A layer with an odd column type should degrade to "no filters offered",
    // never take down the request.
    console.warn(`   filter values unavailable for ${tableName}: ${err.message}`);
    out = {};
  }

  filterValuesCache.set(tableName, out);
  return out;
}

// One information_schema query, cached: the layers do not change at runtime.
let featureColumnsCache = null;
async function featureLabelColumns() {
  if (featureColumnsCache) return featureColumnsCache;
  const { rows } = await pool.query(
    `SELECT table_name, array_agg(column_name::text) AS cols
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = ANY($1)
      GROUP BY table_name`,
    [FEATURE_LABEL_COLUMNS]
  );
  featureColumnsCache = new Map(rows.map(r => [r.table_name, r.cols]));
  return featureColumnsCache;
}

/**
 * A sample of things this database can definitely answer, for when retrieval
 * came back with nothing usable at all.
 *
 * At that point there are no resolved candidates to build suggestions from, so
 * the alternative would be hardcoding example questions -- which goes stale the
 * moment the loaded data changes, and would confidently offer queries about
 * datasets that are not present. This reads what IS in attribute_source
 * instead, so the offer is true by construction.
 *
 * Cached: the loaded layers do not change at runtime.
 */
let answerableSampleCache = null;
async function answerableSample() {
  if (answerableSampleCache) return answerableSampleCache;
  const byId = new Map(variables.map(v => [v.attr_id, v]));

  const { rows } = await pool.query(
    `(SELECT DISTINCT ON (table_name) attr_id, source_kind
        FROM attribute_source WHERE source_kind = 'feature_table'
       ORDER BY table_name, attr_id)
     UNION ALL
     (SELECT attr_id, source_kind
        FROM attribute_source WHERE source_kind = 'acs_long' LIMIT 500)`
  );

  const features = [];
  const values = [];
  for (const r of rows) {
    const v = byId.get(r.attr_id);
    if (!v) continue;
    if (r.source_kind === "feature_table") {
      // Skip the datasets whose catalog name is an opaque ETL hash -- they
      // are real, but "table_2545cd7a... locations" is not a useful offer.
      if (!v.dataset_clean || /^[0-9a-f]{8}|^table_/i.test(v.dataset_clean)) continue;
      features.push({ attr_id: r.attr_id, dataset_clean: v.dataset_clean, is_feature_table: true });
    } else {
      const desc = v.attr_desc || "";
      // Estimates only: the MOE/PMOE/PCT_EST variants are margins of error and
      // percentage duplicates, which make for confusing example questions.
      if (!/^estimate/i.test(desc)) continue;
      const label = shortLabel(desc);
      if (!label || label.length > 45) continue;
      values.push({ attr_id: r.attr_id, attr_desc: desc });
    }
  }

  answerableSampleCache = [...values.slice(0, 6), ...features.slice(0, 6)];
  return answerableSampleCache;
}

/**
 * Are named boundaries loaded?
 *
 * Cached after the first answer: place_geom is populated by an ETL run, not at
 * runtime, so this cannot change while the process lives. A false result is not
 * cached, so starting the API before loading boundaries and loading them after
 * does not require a restart.
 */
let placeBoundariesCache = null;
async function placeBoundariesLoaded() {
  if (placeBoundariesCache) return true;
  try {
    const { rows } = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM place_geom LIMIT 1) AS present");
    placeBoundariesCache = rows[0]?.present === true;
    return placeBoundariesCache;
  } catch {
    // The table does not exist on an install that has never run the loader.
    return false;
  }
}

/**
 * Whether county adjacency has been built (`make neighbors`).
 *
 * Cached the same way, and for the same reason: `hotspot` needs a weights
 * matrix, and offering an op that can only fail costs a repair round on a plan
 * the data could never support.
 */
let neighborsCache = null;
async function countyNeighborsLoaded() {
  if (neighborsCache) return true;
  try {
    const { rows } = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM county_neighbors LIMIT 1) AS present");
    neighborsCache = rows[0]?.present === true;
    return neighborsCache;
  } catch {
    return false;
  }
}

async function resolveAttributes(attrIds) {
  const out = new Map();
  if (!attrIds.length) return out;
  const { rows } = await pool.query(
    // geom_column and srid were previously omitted, and the compiler only kept
    // working because it falls back to "geom"/4326 -- true for every layer the
    // ETL currently loads, and silently wrong for the first one that isn't.
    `SELECT attr_id, dataset_id, description, source_kind, table_name,
            value_column, census_code, entity_type, geom_table, geom_column, srid
       FROM attribute_source
      WHERE attr_id = ANY($1)`,
    [attrIds]
  );
  const labels = rows.some(r => r.source_kind === "feature_table")
    ? await featureLabelColumns()
    : null;
  for (const r of rows) {
    if (r.source_kind === "feature_table" && labels) {
      r.label_columns = labels.get(r.table_name) || [];
      // Carried on the resolved row so the validator can check a filter against
      // real values and the compiler can bind them -- same path attr_ids take.
      r.filter_values = await featureFilterValues(r.table_name, r.label_columns);
    }
    out.set(r.attr_id, r);
  }
  return out;
}

/**
 * POST /api/analyze
 *
 * The Phase 3 endpoint: natural language in, executed results out.
 *
 * Body: { q, top_k?, execute?, entity_type? }
 * Returns the retrieved candidates, the plan, the compiled SQL, and the rows.
 */
/**
 * An analyze failure that already knows its HTTP status and its response body.
 * This is what lets runAnalysis stay transport-agnostic: POST turns these into
 * a status plus JSON, the SSE route turns them into an `error` event.
 */
class AnalyzeError extends Error {
  constructor(status, payload) {
    super(payload.error);
    this.status = status;
    this.payload = payload;
  }
}

/**
 * The analyze pipeline: retrieve -> plan -> execute.
 *
 * Extracted from the POST handler so that POST /api/analyze and
 * GET /api/analyze/stream run the SAME code. Duplicating it would guarantee
 * the two drift, and the streaming one is the path the UI actually uses.
 *
 * `emit` receives structured progress ({ stage, ... }). It is a no-op for the
 * plain POST and an SSE writer for the stream. `generatePlan` takes the same
 * shape, so planner-internal stages (attempts, repairs) flow through untouched.
 *
 * `includeGeometry` exists because ST_AsGeoJSON for 1,000 counties is ~6.6 MB,
 * and the frontend already ships counties.geojson and joins on fips locally.
 */
async function runAnalysis({ query, top_k = 25, execute = true,
                             includeGeometry = true, emit = () => {},
                             // Per-request engine override, for the A/B in
                             // eval/provider_bench.py. Absent means the
                             // configured default, which is the local runner.
                             provider = null,
                             // Literature expansion override; null = EXPAND_ENABLED.
                             expand = null,
                             // Relevance check override; null = RELEVANCE_CHECK.
                             relevanceCheck = null }) {
  const started = Date.now();
  try {
    if (!query || !query.trim()) {
      throw new AnalyzeError(400, { error: "field 'q' is required" });
    }
    if (!isEmbeddingsReady) {
      throw new AnalyzeError(503, { error: "search index not ready" });
    }

    console.log(`\n${"=".repeat(70)}\nANALYZE: "${query}"\n${"=".repeat(70)}`);
    emit({ stage: "started", query });

    // 1. Retrieve candidates via the DECOMPOSED pipeline, not a single search.
    //    This matters for planning specifically: "poverty normalized by
    //    population" needs a population row in the candidate list, and a single
    //    vector search returns twenty flavours of poverty and no denominator.
    //    Observed directly -- with single-search candidates the planner divided
    //    "100-149% of poverty level" by "at or above 150%", which is
    //    well-formed, executable, and wrong.
    // Retrieve well beyond top_k, because two filters run after this and both
    // can empty a purpose group:
    //   - unresolvable attributes are dropped (they cannot be planned against)
    //   - facility datasets are excluded from normalization and capped
    // At a budget of 20 this left ZERO normalization candidates for "poverty
    // normalized by population" -- the exact query shape the pipeline exists
    // for -- because facility columns ("Objectid", "Feattype") had taken the
    // slots. Retrieval is ~30ms, so over-fetching is close to free.
    const RETRIEVAL_BUDGET = Number(process.env.ANALYZE_RETRIEVAL_BUDGET ?? 60);
    const search = await unifiedSearch(query, {
      useLLMFilter: false,            // measured in Phase 2: costs 10pp recall
      topKPerConcept: Math.max(top_k, RETRIEVAL_BUDGET),
      ...(typeof expand === "boolean" ? { expand } : {})
    });
    const candidates = search.all_results || [];
    emit({ stage: "decomposed", decomposition: search.decomposition,
           retrieved: candidates.length });
    if (search.expansion?.seeds?.length) {
      emit({ stage: "expanded", seeds: search.expansion.seeds,
             kept: search.expansion.concepts.filter(c => c.kept).map(c => c.name) });
    }
    const resolved = await resolveAttributes(candidates.map(c => c.attr_id));

    // Collapse feature tables to one candidate per dataset.
    //
    // count_features counts a DATASET's features per county; which column the
    // retrieval happened to match is irrelevant. Without this, a query about
    // tornado tracks offered the planner seven rows from the same table --
    // "Yr", "Len", "Tz", "Pre 1996 Loss" -- which is noise, and none of it
    // says "tornado". One row per dataset, described by the dataset name, is
    // both what the op needs and what a reader would recognize.
    // Facility datasets need two guards, both learned the hard way. Without
    // them, adding facility coverage dropped plan validity from 62.5% to 12.5%.
    //
    //  1. A DENOMINATOR IS NEVER A FACILITY COUNT. "poverty normalized by
    //     population" was being offered Hospitals, Child Care Centers and Local
    //     Law Enforcement as normalization candidates, which crowded the actual
    //     population attribute out of the list entirely. Normalizing by a count
    //     of hospitals is essentially never what anyone means.
    //  2. THEY MUST NOT CROWD OUT VALUE SERIES. 83 facility datasets against a
    //     top_k of 20 will happily fill the whole list.
    const MAX_FEATURE_CANDIDATES = Number(process.env.MAX_FEATURE_CANDIDATES ?? 6);
    const seenTable = new Set();
    const valueSeries = [];
    const featureRows = [];

    for (const c of candidates) {
      const src = resolved.get(c.attr_id);
      if (!src) continue;
      if (src.source_kind !== "feature_table") valueSeries.push(c);
    }

    // Facility slots are filled ROUND-ROBIN ACROSS SUB-QUERIES, not first-come
    // down the merged list.
    //
    // Taking the merged order looks right and silently loses the dataset the
    // question is actually about. Measured on "how far is each county from the
    // nearest hospital": the sub-query "nearest hospital" ranks Hospitals #1,
    // but RRF over three sub-queries buries it at merged rank 19, behind six
    // unrelated facility datasets pulled in by "county distance" and
    // "population density". Those six filled the cap, Hospitals never reached
    // the planner, and the planner dutifully measured distance to Major Sport
    // Venues while calling it "nearest hospital".
    //
    // One dataset per sub-query per round guarantees every concept the
    // decomposer identified is represented before any concept gets a second.
    const facilityLists = (search.results_by_query || [])
      .map(q => (q.results || []).filter(c => {
        const src = resolved.get(c.attr_id);
        return src && src.source_kind === "feature_table"
            && c.search_purpose !== "normalization"    // a denominator is never a facility count
            // Literature expansion adds value series, not map layers. Without
            // this, "obesity rates in Texas" let an expanded concept claim a
            // facility slot -- a 5th expanded candidate past EXPAND_QUOTA (4),
            // and one placed ahead of the rule that expanded goes last.
            && c.search_purpose !== "expanded";
      }))
      .filter(list => list.length);

    // Fall back to the merged list as a single group, so behavior is unchanged
    // if results_by_query is ever absent.
    const groups = facilityLists.length ? facilityLists : [candidates.filter(c => {
      const src = resolved.get(c.attr_id);
      return src && src.source_kind === "feature_table"
          && c.search_purpose !== "normalization" && c.search_purpose !== "expanded";
    })];

    const cursors = groups.map(() => 0);
    let addedThisRound = true;
    while (featureRows.length < MAX_FEATURE_CANDIDATES && addedThisRound) {
      addedThisRound = false;
      for (let gi = 0; gi < groups.length; gi++) {
        if (featureRows.length >= MAX_FEATURE_CANDIDATES) break;
        const list = groups[gi];
        while (cursors[gi] < list.length) {
          const c = list[cursors[gi]++];
          const src = resolved.get(c.attr_id);
          if (!src || seenTable.has(src.table_name)) continue;   // one row per dataset
          seenTable.add(src.table_name);
          featureRows.push({
            ...c,
            // Facility columns have no useful description (see PROVENANCE.md on
            // the discarded gen_desc), so describe the dataset instead.
            // Op-neutral: this dataset can be counted per county, measured
            // distance to, or mapped directly. Saying "count per county" here
            // put that phrase into the step description of a locations result,
            // which then read as a count of something it had not counted.
            attr_desc: `${c.dataset_clean || src.table_name} (mapped locations)`,
            is_feature_table: true,
            // Carried into the prompt so the planner filters by values that
            // exist, rather than inventing plausible-looking ones that match
            // nothing and return an empty answer that looks valid.
            filter_values: src.filter_values || {},
          });
          addedThisRound = true;
          break;
        }
      }
    }

    // Quota per purpose, not a flat rank cut.
    //
    // Taking the top N value series overall looks reasonable and is wrong: the
    // primary concept always out-ranks the denominator, so a flat cut deletes
    // every normalization candidate and the planner is left unable to build a
    // rate at all. Observed directly -- the normalization section came back
    // empty for "poverty normalized by population", which is the one query
    // shape this whole pipeline exists to serve.
    // `expanded` is literature expansion (backend/expansion.js). Absent unless
    // expansion ran and kept something, so this is inert when it is off.
    const QUOTA = { primary: 10, normalization: 6, filter: 2, related: 2,
                    expanded: Number(process.env.EXPAND_QUOTA ?? 4) };
    const takenByPurpose = { primary: 0, normalization: 0, filter: 0, related: 0, expanded: 0 };
    const picked = [];

    // The quota is per purpose, and it used to be filled first-come from the
    // merged list. That silently loses a whole CONCEPT whenever two of them
    // share a purpose.
    //
    // Measured on "compare median income against educational attainment": the
    // decomposer emits two primary sub-queries, both retrieve well on their
    // own, and income filled all 10 primary slots. Educational attainment never
    // reached the planner, which then reported -- correctly, given what it was
    // shown -- that the data did not exist. A direct search ranks it 1-6.
    //
    // So the purpose quota is now shared ROUND-ROBIN across the sub-queries
    // that carry that purpose: every concept the decomposer found is
    // represented before any concept gets a second slot. Same fix as the
    // facility cap above, one level up.
    const allowed = new Map(valueSeries.map(c => [c.attr_id, c]));
    const byPurpose = new Map();
    for (const q of search.results_by_query || []) {
      const purpose = QUOTA[q.purpose] !== undefined ? q.purpose : "related";
      const list = (q.results || [])
        .map(r => allowed.get(r.attr_id))
        .filter(Boolean);
      if (!list.length) continue;
      if (!byPurpose.has(purpose)) byPurpose.set(purpose, []);
      byPurpose.get(purpose).push(list);
    }

    const seenAttr = new Set();
    for (const [purpose, groups] of byPurpose) {
      const cursors = groups.map(() => 0);
      let added = true;
      while (takenByPurpose[purpose] < QUOTA[purpose] && added) {
        added = false;
        for (let gi = 0; gi < groups.length; gi++) {
          if (takenByPurpose[purpose] >= QUOTA[purpose]) break;
          const list = groups[gi];
          while (cursors[gi] < list.length) {
            const c = list[cursors[gi]++];
            if (seenAttr.has(c.attr_id)) continue;
            seenAttr.add(c.attr_id);
            takenByPurpose[purpose]++;
            picked.push(c);
            added = true;
            break;
          }
        }
      }
    }

    // Top up from the merged order for anything the per-query pass could not
    // fill, and as the whole path when results_by_query is unavailable.
    for (const c of valueSeries) {
      if (seenAttr.has(c.attr_id)) continue;
      const purpose = QUOTA[c.search_purpose] !== undefined ? c.search_purpose : "related";
      if (takenByPurpose[purpose] >= QUOTA[purpose]) continue;
      seenAttr.add(c.attr_id);
      takenByPurpose[purpose]++;
      picked.push(c);
    }

    // Expanded candidates go LAST, after the facility rows: they are the only
    // candidates the question did not ask for, so when top_k truncates, they
    // are what gets cut, not the Hospitals layer a question named. With
    // expansion off there are none and this is the previous ordering exactly,
    // which keeps the prompt byte-identical.
    const executable = [
      ...picked.filter(c => c.search_purpose !== "expanded"),
      ...featureRows,
      ...picked.filter(c => c.search_purpose === "expanded"),
    ].slice(0, top_k);

    console.log(`   candidates by purpose: ${JSON.stringify(takenByPurpose)}, ` +
                `${featureRows.length} facility`);



    console.log(`   ${candidates.length} retrieved, ${executable.length} executable`);
    emit({ stage: "retrieved", retrieved: candidates.length,
           executable: executable.length, by_purpose: takenByPurpose,
           facility: featureRows.length });

    // Named separately from "we found nothing": a dataset that IS in the
    // catalog but has no table is a loading gap, not an unsupported question,
    // and the user cannot tell those apart without being told.
    const missing = unavailableDatasets(candidates, resolved);

    if (executable.length === 0) {
      throw new AnalyzeError(422, {
        error: missing.length
          ? `the data for this question has not been loaded`
          : "no executable attributes for this query",
        detail: missing.length
          ? `Retrieval matched ${missing.join(", ")}, but ${missing.length > 1 ? "those datasets are" : "that dataset is"} ` +
            `in the catalog without any underlying table. See docs/RUNBOOK.md section 4.`
          : "Retrieval found matches, but none are mapped to a physical " +
            "table yet. Only ACS county attributes are loaded; see " +
            "etl/load_reference_data.py.",
        unavailable_datasets: missing,
        // Nothing here resolved, so the suggestions come from the wider
        // catalog of what IS loaded rather than from this query's results.
        suggestions: buildSuggestions(await answerableSample()),
        retrieved: candidates.slice(0, 10),
        ms: Date.now() - started
      });
    }

    // 2. Plan, with validation and repair.
    const planning = await generatePlan({
      query,
      candidates: executable,
      // Bind the planner to PLAN_MODEL, leaving decomposition on the small one.
      callLLM: (sys, usr, temp, schema, extra) =>
        callLLM(sys, usr, temp, schema, CONFIG.llm.planModel, extra),
      resolve: resolveAttributes,
      // Whether named boundaries are loaded. filter_place is useless without
      // them, and offering an op that can only fail costs a repair round.
      hasPlaceBoundaries: await placeBoundariesLoaded(),
      hasNeighbors: await countyNeighborsLoaded(),
      log: (m) => console.log(m),
      emit,
      // planner/relevance.js. On by default; eval runs can pass
      // relevance_check:false to measure it without recreating the container.
      relevanceCheck: typeof relevanceCheck === "boolean" ? relevanceCheck
        : !/^(0|false|no)$/i.test(process.env.RELEVANCE_CHECK ?? "1"),
    });

    if (!planning.ok) {
      // An empty steps array is not a malfunction: it is the planner saying the
      // attributes it was shown cannot answer the question. Observed on
      // "population density per square mile", where retrieval returns housing
      // occupancy columns and no total-population series, so there is nothing
      // to divide by land area.
      //
      // Reported as a coverage answer rather than "could not produce a valid
      // plan", which reads as a crash and sends the user looking for a bug.
      // The planner's LAST word decides. "Premier league attendance" produced a
      // malformed plan, was sent back, and then returned no steps -- it had
      // concluded nothing answers the question, and requiring EVERY attempt to
      // say so reported that as "could not produce a valid plan".
      const allEmpty = planning.attempts.length > 0 &&
        (planning.attempts.at(-1).errors || []).some(e => /no steps/.test(e));
      // Every attempt either used data that does not measure the question, or
      // gave up with no steps. That is "not loaded", not a planner malfunction,
      // and must never be reported as an answer.
      const rejected = planning.attempts.flatMap(a => (a.relevance || [])
        .filter(v => v.verdict === "unrelated"));
      const notMeasured = rejected.length > 0 &&
        (planning.attempts.at(-1).errors || []).some(e => /no steps|^NOT_RELEVANT/.test(e));
      if (notMeasured) {
        const names = [...new Set(rejected.map(v => v.description).filter(Boolean))];
        throw new AnalyzeError(422, {
          error: "the loaded data does not measure what this question asks about",
          detail: "The closest attributes found measure something else " +
                  `(${names.slice(0, 3).map(n => `"${n.slice(0, 60)}"`).join(", ")}), ` +
                  "so any number built on them would answer a different question. " +
                  "These are things the same data can answer:",
          not_measured: true,
          rejected_attributes: rejected,
          suggestions: buildSuggestions(executable),
          unavailable_datasets: missing,
          attempts: planning.attempts.length,
          candidates: executable.slice(0, 10),
          ms: Date.now() - started
        });
      }
      // Grounded alternatives, built from what DID resolve -- so following one
      // cannot fail the same way this question just did.
      const suggestions = buildSuggestions(executable);
      throw new AnalyzeError(422, allEmpty ? {
        error: "no analysis could be built from the available data",
        detail: "Retrieval found related attributes, but none of them answer " +
                "this question directly. These are things the same data can answer:",
        suggestions,
        unavailable_datasets: missing,
        validation_errors: planning.errors,
        attempts: planning.attempts.length,
        candidates: executable.slice(0, 10),
        ms: Date.now() - started
      } : {
        error: "could not produce a valid plan",
        detail: "The planner could not turn this into an executable analysis. " +
                "These are close to what it did find:",
        suggestions,
        unavailable_datasets: missing,
        validation_errors: planning.errors,
        attempts: planning.attempts.length,
        candidates: executable.slice(0, 10),
        ms: Date.now() - started
      });
    }

    // Provenance: everything needed to reconstruct or audit this result later.
    //
    // Assembled server-side because this is where the facts actually are. The
    // browser cannot know which model planned the query, which embedding
    // corpus was searched, or which physical column an attr_id resolved to --
    // and a provenance record the client fills in itself is worth very little.
    //
    // The per-attribute origins matter most. A downloaded CSV of "poverty rate"
    // is not checkable unless it says WHICH poverty measure, from which table
    // and census code, for which year.
    // explain: attach its factors now that the plan is valid. Chosen by code,
    // never by the model (planner/ops/explain.js), then resolved like any
    // other attribute so the compiler can bind them.
    const explainStep = planning.plan.steps.find(s => s.op === "explain");
    if (explainStep) {
      const outcomeStep = planning.plan.steps.find(s => s.id === (explainStep.inputs || [])[0]);
      const chosen = planOps.byName("explain").chooseFactors({
        outcomeAttrId: outcomeStep?.attr_id || null,
        candidates: executable,
        resultsByQuery: search.results_by_query || [],
        expansion: search.expansion,
      });
      const extra = await resolveAttributes(chosen.map(f => f.attr_id));
      explainStep.factors = chosen
        .filter(f => extra.get(f.attr_id) && extra.get(f.attr_id).source_kind !== "feature_table")
        .map(f => ({ ...f, description: f.description || extra.get(f.attr_id).description || f.attr_id }));
      for (const [k, v] of extra) planning.resolved.set(k, v);
      const nFactors = explainStep.factors.filter(f => f.role === "factor").length;
      console.log(`   explain: ${nFactors} factor(s), ` +
        `${explainStep.factors.length - nFactors} control(s): ` +
        explainStep.factors.map(f => `${f.role[0]}:${(f.description || "").slice(0, 30)}`).join(" | "));
      if (!nFactors) {
        throw new AnalyzeError(422, {
          error: "no candidate factors could be found for this outcome",
          detail: "Neither the question, the literature links nor the default covariates " +
                  "resolved to loaded data.",
          plan: planning.plan, ms: Date.now() - started,
        });
      }
    }

    const usedAttrIds = [...new Set(planning.plan.steps.flatMap(
      s => [s.attr_id, s.near_attr_id, ...(s.factors || []).map(f => f.attr_id)]
        .filter(Boolean)))];
    const byId = new Map(executable.map(c => [c.attr_id, c]));
    const origins = usedAttrIds.map(id => {
      const src = planning.resolved.get(id) || {};
      const cand = byId.get(id) || {};
      const isFeature = src.source_kind === "feature_table";
      return {
        attr_id: id,
        description: cand.attr_desc || src.description || null,
        dataset: cand.dataset_clean || null,
        original_name: cand.attr_orig || null,
        source_kind: src.source_kind || null,
        table_name: src.table_name || null,
        // A feature dataset is read for its GEOMETRY -- counted, or measured
        // against. attribute_source still carries whichever column retrieval
        // happened to match ("website", "objectid"), and reporting that as the
        // source of the number is simply wrong, so it is dropped here rather
        // than in each of the three places that render provenance.
        value_column: isFeature ? null : (src.value_column || null),
        geometry_column: isFeature ? (src.geom_column || "geom") : null,
        census_code: src.census_code || null,
        entity_type: cand.entity_type || src.entity_type || null,
        start_date: cand.start_date || null,
        end_date: cand.end_date || null,
        srid: src.srid ?? null,
      };
    });

    const body = {
      query,
      decomposition: search.decomposition,
      expansion: search.expansion,
      plan: planning.plan,
      repairs: planning.repairs,
      // Deterministic corrections applied to the model's plan. Surfaced because
      // a filter that could not be applied silently widens the answer.
      adjustments: planning.adjustments || [],
      // How each attribute the plan uses relates to the question. A "proxy"
      // is kept but should be shown: "median household income" answers "the
      // wealthiest" only by stand-in, and the reader deserves to know that.
      relevance: planning.relevance,
      // ALL executable candidates, not the top 10. A plan may load an attribute
      // ranked below 10th, and the UI's step-by-step report has to be able to
      // name what each step operates on. The list is ~25 small rows.
      candidates: executable,
      provenance: {
        generated_at: new Date().toISOString(),
        query,
        intent: planning.plan.intent,
        models: {
          decomposition: CONFIG.llm.model,
          planner: CONFIG.llm.planModel || CONFIG.llm.model,
          embedding: CONFIG.embedder.model,
        },
        retrieval: {
          corpus_cache_key: corpusCacheKey ?? null,
          catalog_rows: variables.length,
          retrieved: candidates.length,
          executable: executable.length,
          plan_repairs: planning.repairs,
          // Which candidates came from the literature rather than the question,
          // and from which SemMedDB release. null when expansion was off.
          expansion: search.expansion ? {
            source: search.expansion.source || null,
            seeds: search.expansion.seeds,
            concepts: search.expansion.concepts.filter(c => c.kept).map(c => c.name),
          } : null,
        },
        database: CONFIG.database.database,
        attribute_origins: origins,
        // Units are not derivable from the numbers and are wrong to guess at.
        units_note:
          "per_area yields value per square mile of LAND area (water excluded); " +
          "nearest_distance yields miles; normalize yields numerator/denominator " +
          "times the step's scale.",
      },
      ms: Date.now() - started
    };

    // 3. Execute, unless the caller only wanted the plan.
    if (execute) {
      emit({ stage: "executing" });
      try {
        const result = await executePlan(planning.plan, planning.resolved, pool);
        body.sql = result.sql;
        body.params = result.params;
        body.row_count = result.row_count;
        body.rows = result.rows;
        body.execution_ms = result.ms;
        body.output_mode = result.mode;
        // Two-series results carry `value_b` on every row. Announced explicitly
        // so the UI can offer a series switch without having to sniff the rows.
        if (result.series === 2) body.series = 2;
        // Signed measures (hotspot, outlier) must be drawn on a diverging ramp.
        // Declared by the op that produced the layer, not guessed from the
        // numbers: an all-positive run of a diverging measure is still one.
        if (result.diverging) {
          body.diverging = true;
          body.value_label = result.valueLabel ?? null;
        }
        // A one-row statistic (correlate): its figures, named. Also marks the
        // result as a statistic rather than a county layer, so the UI shows a
        // summary instead of a map of one NULL-fips row.
        if (result.stats) {
          body.stats = result.stats;
          body.value_label = result.valueLabel ?? null;
        }
        // explain: the ranked factor table, the controls it used, and how many
        // counties had the outcome at all.
        if (result.mode === "factors") {
          body.explain = {
            factors: result.factors,
            controls: result.controls,
            outcome_counties: result.outcome_counties,
          };
        }
        // A plan with several `output` steps returns several layers. The first
        // is ALSO surfaced flat above, so a client that knows nothing about
        // layers still gets an answer rather than an empty result.
        if (result.layer_count > 1) {
          body.layers = result.layers.map(l => ({
            id: l.id,
            step: l.step,
            op: l.op,
            // A component of an arithmetic result rather than the answer, so
            // the UI can label it as such instead of calling it "Layer 2".
            part: l.part === true,
            mode: l.mode,
            series: l.series,
            diverging: l.diverging === true,
            value_label: l.valueLabel ?? null,
            stats: l.stats ?? null,
            row_count: l.row_count,
            ...(l.mode === "features" ? { features: l.features } : { rows: l.rows }),
          }));
          body.layer_count = result.layer_count;
        }
        // A successful result can still be the wrong ANSWER: a city filter with
        // no state quietly spans the country. Report the spread so the UI can
        // offer to narrow, rather than presenting 25 states as one city.
        const ambiguity = cityAmbiguity(planning.plan, result.features);
        if (ambiguity) body.ambiguity = ambiguity;
        if (result.mode === "features") {
          // Feature geometry is the ANSWER here, not an optional overlay, so
          // include_geometry does not apply -- withholding it would leave the
          // caller with nothing. Bounded instead by MAX_FEATURES.
          body.features = result.features;
        } else if (includeGeometry) {
          // County geometry is ~6.6 MB for a 1,000-row result. Callers that
          // already have county boundaries locally ask for it to be left out.
          body.geometry = result.geometry;
        }
      } catch (err) {
        // A plan that validates can still fail at execution. Return the plan
        // and the reason rather than swallowing both.
        console.error("   Execution failed:", err.message);
        body.execution_error = err.message;
        body.http_status = 500;
      }
    }

    body.ms = Date.now() - started;
    console.log(`   done in ${body.ms}ms (${body.row_count ?? 0} rows)`);
    return body;

  } catch (error) {
    if (error instanceof AnalyzeError) throw error;
    console.error("Analyze error:", error);
    throw new AnalyzeError(500, { error: "analyze failed", details: error.message });
  }
}

app.post("/api/analyze", auth.requireAuth, limitAnalyze, async (req, res) => {
  const { q, top_k, execute, include_geometry } = req.body || {};
  // Queued like the stream: both compete for the same single GPU, and letting
  // POST bypass the queue would let it jump ahead of everyone waiting.
  let closed = false;
  req.on("close", () => { closed = true; });
  try {
    const body = await analysisQueue.submit(
      () => runAnalysis({
        query: q, top_k, execute,
        // Defaults to true so existing callers (eval/run.py, curl) are unchanged.
        includeGeometry: include_geometry !== false,
        // Only ever "google" or absent; anything else falls through to local.
        provider: req.body?.provider === "google" ? "google" : null,
        expand: typeof req.body?.expand === "boolean" ? req.body.expand : null,
        relevanceCheck: typeof req.body?.relevance_check === "boolean"
          ? req.body.relevance_check : null,
      }),
      { isAbandoned: () => closed },
    );
    const status = body.http_status ?? 200;
    delete body.http_status;
    return res.status(status).json(body);
  } catch (err) {
    if (err instanceof QueueFullError) {
      res.set("Retry-After", "30");
      return res.status(503).json({
        error: "server is busy",
        detail: `${err.depth} analyses are already waiting. Try again shortly.`,
      });
    }
    if (err instanceof AnalyzeError) return res.status(err.status).json(err.payload);
    return res.status(500).json({ error: "analyze failed", details: err.message });
  }
});

/**
 * Streaming analyze.
 *
 * GET rather than POST because EventSource cannot issue a POST, and the query
 * is short enough to sit in the querystring. A 45s p50 with no feedback is the
 * reason this exists: the UI shows which stage is running instead of a spinner.
 *
 * nginx is already configured for this -- `proxy_buffering off` in
 * frontend/nginx.conf, without which every event would be held until the
 * response completed and the stream would be pointless.
 *
 * Geometry defaults OFF here: the client joins values to its own
 * counties.geojson on fips, so shipping polygons would add ~6.6 MB to a
 * payload the browser already has.
 */
app.get("/api/analyze/stream", auth.requireAuth, limitAnalyze, async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    // Belt and braces: honored by nginx even if proxy_buffering is ever re-enabled.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let open = true;
  req.on("close", () => { open = false; });

  const send = (event, data) => {
    if (!open) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat. Planning can sit silent for tens of seconds inside one LLM call,
  // and idle proxies drop connections; a comment frame keeps it alive and is
  // ignored by EventSource.
  const heartbeat = setInterval(() => { if (open) res.write(": keepalive\n\n"); }, 15000);

  try {
    const body = await analysisQueue.submit(
      () => runAnalysis({
        query: req.query.q,
        top_k: req.query.top_k ? Number(req.query.top_k) : undefined,
        execute: req.query.execute !== "false",
        includeGeometry: req.query.include_geometry === "true",
        expand: req.query.expand === "true" ? true : req.query.expand === "false" ? false : null,
        emit: (ev) => send(ev.stage, ev),
      }),
      {
        // The whole reason the queue reports position: a 19s analysis behind
        // three others is a 76s wait, and an unexplained 76s reads as a hang.
        onPosition: (position, total) => send("queued", { stage: "queued", position, total }),
        // A browser that navigated away must not cost the GPU a full run.
        isAbandoned: () => !open,
      },
    );
    delete body.http_status;
    send("done", body);
  } catch (err) {
    const payload = err instanceof QueueFullError
      ? { status: 503, error: "server is busy",
          detail: `${err.depth} analyses are already waiting. Try again shortly.` }
      : err instanceof AnalyzeError
        ? { status: err.status, ...err.payload }
        : { status: 500, error: "analyze failed", details: err.message };
    send("failed", payload);
  } finally {
    clearInterval(heartbeat);
    if (open) res.end();
  }
});

app.get("/api/health", async (req, res) => {
  const freshness = await checkCorpusFreshness();
  res.json({
    status: "ok",
    embeddings_ready: isEmbeddingsReady,
    variable_count: variables.length,
    embedding_count: embeddings.length,
    embedding_model: CONFIG.embedder.model,
    embedder_url: CONFIG.embedder.url,
    llm_model: CONFIG.llm.model,
    plan_model: CONFIG.llm.planModel,
    // Whether this instance is sending questions off the machine. Reported
    // because "local-only" is a property people rely on, and a config flag that
    // silently changes it should be visible from outside.
    llm_provider: process.env.LLM_PROVIDER || "ollama",
    google_available: googleConfigured(),
    database: CONFIG.database.database,
    resolvable_attributes: resolvableCount,
    auth_required: auth.AUTH_ENABLED,
    queue: analysisQueue.stats(),
    corpus_cache_key: corpusCacheKey,
    // True when the embedder has re-embedded since this process started. The
    // vectors held here are then from a different space than the query
    // embeddings, and results are silently wrong until POST /api/reload-corpus.
    corpus_stale: freshness.stale,
    corpus_available_key: freshness.available,
    // Literature expansion: whether it is on by default, and whether its index
    // is built. Enabled with no index means it silently does nothing.
    expansion_enabled: EXPANSION_CONFIG.enabled,
    expansion_index: (await expansionIndexLoaded(pool)).meta
  });
});

// =============================================================================
// Initialization
// =============================================================================

async function initializeEmbeddings() {
  try {
    if (!fs.existsSync(CONFIG.search.csvPath)) {
      throw new Error(`CSV not found: ${CONFIG.search.csvPath}`);
    }

    console.log("  Waiting for embedder service...");
    const health = await waitForEmbedder();
    console.log(`  Embedder ready: ${health.model} (dim ${health.dimension})`);

    console.log("  Loading variables from CSV...");
    variables = await loadVariablesFromCSV(CONFIG.search.csvPath);
    if (variables.length === 0) throw new Error("No variables loaded");

    // The embedder owns the corpus: it reads the same CSV, builds the same
    // embedding text, and caches the matrix to disk keyed by a content hash.
    // After the first run this is a disk read on their side and one HTTP call
    // on ours -- seconds, not minutes.
    console.log("  Fetching corpus vectors from embedder...");
    const corpus = await fetchJSON(`${CONFIG.embedder.url}/corpus/vectors`, {}, 600000);

    // Row order is the CSV's on both sides, so indices line up -- but assert it
    // rather than trust it. A mismatch would silently return wrong results for
    // every query, which is far worse than failing to start.
    if (corpus.count !== variables.length) {
      throw new Error(
        `corpus/CSV row mismatch: embedder has ${corpus.count}, this process loaded ` +
        `${variables.length}. Both must read the same geoark_attributes.csv. ` +
        `Check the CSV bind mount in docker-compose.yml.`
      );
    }

    embeddings = corpus.embeddings;
    processedVariablesText = corpus.processed_texts;
    corpusCacheKey = corpus.cache_key;

    buildLexicalIndex(processedVariablesText);

    // How much of the catalog is actually executable. Surfaced on /api/health
    // because "search works but nothing can run" is otherwise invisible.
    try {
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM attribute_source");
      resolvableCount = rows[0].n;
      console.log(`  Executable attributes: ${resolvableCount} of ${variables.length}`);
    } catch (err) {
      resolvableCount = 0;
      console.warn(`  attribute_source unavailable (${err.message}). ` +
                   `/api/analyze will return 422 until etl/load_reference_data.py runs.`);
    }

    console.log(`  ${embeddings.length} embeddings ready (${corpus.model}, cache ${corpus.cache_key})`);
    isEmbeddingsReady = true;

  } catch (error) {
    console.error("  Failed to initialize:", error.message);
    process.exit(1);
  }
}

// =============================================================================
// Start Server
// =============================================================================

const PORT = CONFIG.server.port;

initializeEmbeddings().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  UNIFIED GEOSPATIAL SEARCH SERVER`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   Running on: http://localhost:${PORT}`);
    console.log(`\n  API Endpoints:`);
    console.log(`   POST /api/unified-search   - Full unified search pipeline`);
    console.log(`   POST /api/decompose-query  - Query decomposition only`);
    console.log(`   GET  /api/search           - Simple hybrid search`);
    console.log(`   POST /api/analyze          - NL -> plan -> executed results`);
    console.log(`   GET  /api/health           - Health check`);
    console.log(`\n  Access control:`);
    console.log(auth.startupWarning());
    console.log(`   Queue: concurrency ${analysisQueue.stats().concurrency}, ` +
                `max depth ${analysisQueue.stats().maxDepth}`);
    console.log(`\n  Configuration:`);
    console.log(`   Embedder:  ${CONFIG.embedder.url} (${CONFIG.embedder.model})`);
    console.log(`   Ollama:    ${CONFIG.llm.endpoint}`);
    console.log(`   LLM Model: ${CONFIG.llm.model}  (planner: ${CONFIG.llm.planModel})`);
    console.log(`   Database:  ${CONFIG.database.user}@${CONFIG.database.host}:${CONFIG.database.port}/${CONFIG.database.database}`);
    console.log(`   Variables: ${variables.length}`);
    console.log(`   CSV Path: ${CONFIG.search.csvPath}`);
    console.log(`${'='.repeat(80)}\n`);
  });
}).catch(error => {
  console.error("Failed to start:", error);
  process.exit(1);
});

// =============================================================================
// Exports for integration
// =============================================================================

module.exports = {
  // Main functions
  unifiedSearch,
  decomposeQuery,
  performHybridSearch,
  verifyResultsWithLLM,

  // Helper functions
  createSmartFallback,
  loadVariablesFromCSV,
  generateEmbeddings,
  waitForEmbedder,
  buildLexicalIndex,
  bm25Score,
  tokenize,
  
  // Configuration and state
  CONFIG,
  pool,
  
  // State accessors
  getVariables: () => variables,
  getEmbeddings: () => embeddings,
  isReady: () => isEmbeddingsReady
};
