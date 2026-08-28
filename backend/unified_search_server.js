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

console.log("  Starting Unified Geospatial Search Server...");

const app = express();
app.use(cors());
app.use(express.json());

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
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2)
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
    semanticWeight: Number(process.env.SEMANTIC_WEIGHT ?? 0.7),
    keywordWeight: Number(process.env.KEYWORD_WEIGHT ?? 0.3),
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
async function callLLM(systemPrompt, userPrompt, temperature = 0.2) {
  try {
    console.log(`   Calling LLM (${CONFIG.llm.model})...`);
    
    const response = await fetch(CONFIG.llm.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.llm.model,
        messages: [
          { role: "user", content: systemPrompt }
        ],
        temperature: temperature,
        stream: false
      })
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
    const response = await callLLM(prompt, query);
    
    console.log(`   Raw LLM response length: ${response?.length || 0} chars`);
    
    if (!response || response.length < 10) {
      console.log(`   Empty or short response, using smart fallback`);
      return createSmartFallback(query);
    }
    
    // Parse JSON from response
    let result;
    try {
      let jsonStr = response;
      
      // Try different extraction methods
      if (response.includes("```json")) {
        jsonStr = response.split("```json")[1].split("```")[0];
      } else if (response.includes("```")) {
        jsonStr = response.split("```")[1].split("```")[0];
      } else {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }
      
      result = JSON.parse(jsonStr.trim());
      
      // Validate the result has expected structure
      if (!result.search_queries || !Array.isArray(result.search_queries)) {
        console.log(`   Invalid structure, using smart fallback`);
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
function keywordMatchScore(query, text) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const textWords = text.toLowerCase().split(/\s+/);
  
  let matchCount = 0;
  for (const qWord of queryWords) {
    for (const tWord of textWords) {
      if (tWord.includes(qWord) || qWord.includes(tWord)) {
        matchCount++;
        break;
      }
    }
  }
  
  return queryWords.length > 0 ? matchCount / queryWords.length : 0;
}

/**
 * Perform hybrid search combining semantic and keyword matching
 */
async function performHybridSearch(query, topK = 20, searchPurpose = 'primary') {
  if (!isEmbeddingsReady) {
    throw new Error("Embeddings not ready");
  }
  
  console.log(`   Hybrid search for: "${query}" (${searchPurpose})`);
  
  // Generate query embedding
  const queryEmbeddingResult = await generateEmbeddings([query], true);
  const queryEmbedding = queryEmbeddingResult.embeddings[0];
  const processedQuery = queryEmbeddingResult.processed_texts[0];
  
  // Calculate scores for all variables
  const scores = embeddings.map((embedding, index) => {
    const semanticScore = cosineSimilarity(queryEmbedding, embedding);
    const keywordScore = keywordMatchScore(processedQuery, processedVariablesText[index]);
    
    const hybridScore = 
      CONFIG.search.semanticWeight * semanticScore + 
      CONFIG.search.keywordWeight * keywordScore;
    
    return {
      variable: variables[index],
      semantic_score: semanticScore,
      keyword_score: keywordScore,
      hybrid_score: hybridScore,
      search_purpose: searchPurpose
    };
  });
  
  // Sort by hybrid score and take top K
  scores.sort((a, b) => b.hybrid_score - a.hybrid_score);
  
  const topResults = scores.slice(0, topK).map(item => ({
    dataset_id: item.variable.dataset_id,
    table_name: item.variable.table_name,
    attr_id: item.variable.attr_id,
    attr_orig: item.variable.attr_orig,
    dataset_clean: item.variable.dataset_clean,
    attr_desc: item.variable.attr_desc,
    tags: item.variable.tags,
    entity_type: item.variable.entity_type,
    spatial_rep: item.variable.spatial_rep,
    source_folder: item.variable.source_folder,
    semantic_score: Math.round(item.semantic_score * 1000) / 1000,
    keyword_score: Math.round(item.keyword_score * 1000) / 1000,
    hybrid_score: Math.round(item.hybrid_score * 1000) / 1000,
    search_purpose: item.search_purpose
  }));
  
  console.log(`   Found ${topResults.length} results (top score: ${topResults[0]?.hybrid_score.toFixed(3) || 'N/A'})`);
  
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
    const responseRaw = await fetch(CONFIG.llm.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.llm.model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        format: "json", // <--- Forces the model to output valid JSON
        stream: false,
        options: { temperature: 0.1 }
      })
    });
    
    
    const data = await responseRaw.json();
    const content = data.message?.content || "";

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Last ditch effort to find JSON in the string
      const match = content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
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
    topKPerConcept = CONFIG.search.topK
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
    related: finalResults.filter(r => r.search_purpose === 'related')
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
// PostGIS Data Retrieval (from geospatial_server.js base)
// =============================================================================

/**
 * Get actual data from PostGIS using search results
 */
async function getDataFromResults(searchResults, options = {}) {
  const { limit = 10, fipsFilter = null } = options;
  
  const data = [];
  
  // Group results by table
  const byTable = new Map();
  for (const result of searchResults) {
    if (!result.table_name || !result.attr_orig) continue;
    
    if (!byTable.has(result.table_name)) {
      byTable.set(result.table_name, []);
    }
    byTable.get(result.table_name).push(result.attr_orig);
  }
  
  // Query each table
  for (const [tableName, columns] of byTable) {
    try {
      const colList = columns.map(c => `"${c}"`).join(', ');
      let query = `SELECT ${colList} FROM "${tableName}"`;
      const params = [];
      
      if (fipsFilter) {
        query += ` WHERE fips = $1 OR geoid = $1`;
        params.push(fipsFilter);
      }
      
      query += ` LIMIT ${limit}`;
      
      const result = await pool.query(query, params);
      
      data.push({
        table_name: tableName,
        columns: columns,
        rows: result.rows,
        row_count: result.rowCount
      });
      
    } catch (e) {
      console.error(`Failed to query ${tableName}: ${e.message}`);
    }
  }
  
  return data;
}

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * POST /api/unified-search
 * Main unified search endpoint
 */
app.post("/api/unified-search", async (req, res) => {
  try {
    if (!isEmbeddingsReady) {
      return res.status(503).json({ error: "Embeddings not ready" });
    }
    
    const { q: query, use_llm_filter = true, top_k = 10 } = req.body;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: "Query 'q' is required" });
    }
    
    const results = await unifiedSearch(query, {
      useLLMFilter: use_llm_filter,
      topKPerConcept: top_k
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
app.post("/api/decompose-query", async (req, res) => {
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
app.get("/api/search", async (req, res) => {
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
 * POST /api/get-data
 * Retrieve actual data from PostGIS
 */
app.post("/api/get-data", async (req, res) => {
  try {
    const { results, limit = 10, fips = null } = req.body;
    
    if (!results || !Array.isArray(results)) {
      return res.status(400).json({ error: "Results array required" });
    }
    
    const data = await getDataFromResults(results, { limit, fipsFilter: fips });
    res.json(data);
    
  } catch (error) {
    console.error("Get data error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/health
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    embeddings_ready: isEmbeddingsReady,
    variable_count: variables.length,
    embedding_count: embeddings.length,
    embedding_model: CONFIG.embedder.model,
    embedder_url: CONFIG.embedder.url,
    llm_model: CONFIG.llm.model,
    database: CONFIG.database.database
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
    console.log(`   POST /api/get-data         - Retrieve PostGIS data`);
    console.log(`   GET  /api/health           - Health check`);
    console.log(`\n  Configuration:`);
    console.log(`   Embedder:  ${CONFIG.embedder.url} (${CONFIG.embedder.model})`);
    console.log(`   Ollama:    ${CONFIG.llm.endpoint}`);
    console.log(`   LLM Model: ${CONFIG.llm.model}`);
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
  getDataFromResults,
  
  // Helper functions
  createSmartFallback,
  loadVariablesFromCSV,
  generateEmbeddings,
  waitForEmbedder,
  
  // Configuration and state
  CONFIG,
  pool,
  
  // State accessors
  getVariables: () => variables,
  getEmbeddings: () => embeddings,
  isReady: () => isEmbeddingsReady
};
