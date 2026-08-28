const express = require("express");
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
const { OpenAI } = require("openai");
require("dotenv").config();

console.log("Starting semantic search server...");

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage for variables and their embeddings
let variablesData = [];
let variableEmbeddings = [];
let isIndexBuilt = false;

// Configuration
const EMBEDDING_MODEL = "text-embedding-3-small";
const CSV_FILE_PATH = "./shortened_var.csv"; // Update this path as needed
const TOP_K_RESULTS = 10;

/**
 * Combine variable fields into a searchable text string
 */
function createSearchableText(variable) {
  const parts = [];
  
  if (variable.attr_label) parts.push(variable.attr_label);
  if (variable.attr_desc) parts.push(variable.attr_desc);
  if (variable.tags) {
    // Clean up tags - remove brackets and quotes, split by comma
    const cleanTags = variable.tags
      .replace(/[\[\]']/g, "")
      .split(",")
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
    parts.push(cleanTags.join(" "));
  }
  
  return parts.join(" ").trim();
}

/**
 * Load CSV file and create variable records
 */
async function loadVariablesFromCSV() {
  return new Promise((resolve, reject) => {
    const variables = [];
    
    fs.createReadStream(CSV_FILE_PATH)
      .pipe(csv())
      .on("data", (row) => {
        const searchableText = createSearchableText(row);
        if (searchableText.length > 0) {
          variables.push({
            dataset_id: row.dataset_id,
            attr_label: row.attr_label,
            attr_desc: row.attr_desc,
            attr_id: row.attr_id,
            tags: row.tags,
            entity_type: row.entity_type,
            start_date: row.start_date,
            end_date: row.end_date,
            searchableText: searchableText,
            originalRow: row // Keep full row for reference
          });
        }
      })
      .on("end", () => {
        console.log(`Loaded ${variables.length} variables from CSV`);
        resolve(variables);
      })
      .on("error", reject);
  });
}

/**
 * Generate embeddings for a batch of texts
 */
async function generateEmbeddings(texts, batchSize = 100) {
  const embeddings = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    console.log(`Generating embeddings for batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(texts.length/batchSize)}`);
    
    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });
      
      embeddings.push(...response.data.map(item => item.embedding));
      
      // Rate limiting - avoid hitting API limits
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error("Error generating embeddings:", error);
      throw error;
    }
  }
  
  return embeddings;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new Error("Vectors must have the same length");
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Build the search index at server startup
 */
async function buildSearchIndex() {
  try {
    console.log("Building search index...");
    
    // Load variables from CSV
    variablesData = await loadVariablesFromCSV();
    
    if (variablesData.length === 0) {
      throw new Error("No variables loaded from CSV file");
    }
    
    // Generate embeddings for all variables
    const searchableTexts = variablesData.map(v => v.searchableText);
    variableEmbeddings = await generateEmbeddings(searchableTexts);
    
    console.log(`Generated ${variableEmbeddings.length} embeddings`);
    
    isIndexBuilt = true;
    console.log("Search index built successfully!");
    
  } catch (error) {
    console.error("Error building search index:", error);
    throw error;
  }
}

/**
 * Search for similar variables using semantic similarity
 */
async function searchVariables(query, topK = TOP_K_RESULTS) {
  if (!isIndexBuilt) {
    throw new Error("Search index not built yet");
  }
  
  try {
    // Generate embedding for the query
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: [query],
    });
    
    const queryEmbedding = response.data[0].embedding;
    
    // Calculate similarities with all variables
    const similarities = variableEmbeddings.map((embedding, index) => ({
      variable: variablesData[index],
      similarity: cosineSimilarity(queryEmbedding, embedding)
    }));
    
    // Sort by similarity (descending) and return top K
    similarities.sort((a, b) => b.similarity - a.similarity);
    
    return similarities.slice(0, topK).map(item => ({
      dataset_id: item.variable.dataset_id,
      attr_label: item.variable.attr_label,
      attr_desc: item.variable.attr_desc,
      attr_id: item.variable.attr_id,
      tags: item.variable.tags,
      entity_type: item.variable.entity_type,
      start_date: item.variable.start_date,
      end_date: item.variable.end_date,
      similarity: Math.round(item.similarity * 1000) / 1000, // Round to 3 decimal places
      searchableText: item.variable.searchableText
    }));
    
  } catch (error) {
    console.error("Error in searchVariables:", error);
    throw error;
  }
}

// API Routes

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    indexBuilt: isIndexBuilt,
    variableCount: variablesData.length 
  });
});

// Semantic search endpoint
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    const topK = parseInt(req.query.top_k) || TOP_K_RESULTS;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ 
        error: "Query parameter 'q' is required" 
      });
    }
    
    if (!isIndexBuilt) {
      return res.status(503).json({ 
        error: "Search index is still being built. Please try again in a moment." 
      });
    }
    
    console.log(`Searching for: "${query}" (top ${topK})`);
    
    const results = await searchVariables(query, topK);
    
    res.json({
      query: query,
      total_results: results.length,
      results: results
    });
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ 
      error: "Internal server error",
      message: error.message 
    });
  }
});

// Get variable by ID
app.get("/api/variable/:attr_id", (req, res) => {
  try {
    const attrId = req.params.attr_id;
    const variable = variablesData.find(v => v.attr_id === attrId);
    
    if (!variable) {
      return res.status(404).json({ error: "Variable not found" });
    }
    
    res.json(variable);
    
  } catch (error) {
    console.error("Error fetching variable:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all unique tags
app.get("/api/tags", (req, res) => {
  try {
    const allTags = new Set();
    
    variablesData.forEach(variable => {
      if (variable.tags) {
        const cleanTags = variable.tags
          .replace(/[\[\]']/g, "")
          .split(",")
          .map(tag => tag.trim())
          .filter(tag => tag.length > 0);
        cleanTags.forEach(tag => allTags.add(tag));
      }
    });
    
    res.json({
      tags: Array.from(allTags).sort(),
      count: allTags.size
    });
    
  } catch (error) {
    console.error("Error fetching tags:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Statistics endpoint
app.get("/api/stats", (req, res) => {
  try {
    const stats = {
      total_variables: variablesData.length,
      unique_datasets: new Set(variablesData.map(v => v.dataset_id)).size,
      unique_entity_types: new Set(variablesData.map(v => v.entity_type)).size,
      date_range: {
        earliest: Math.min(...variablesData.map(v => parseInt(v.start_date)).filter(d => !isNaN(d))),
        latest: Math.max(...variablesData.map(v => parseInt(v.end_date)).filter(d => !isNaN(d)))
      },
      index_built: isIndexBuilt
    };
    
    res.json(stats);
    
  } catch (error) {
    console.error("Error generating stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 4000;

// Start server and build index
async function startServer() {
  try {
    // Build search index first
    await buildSearchIndex();
    
    app.listen(PORT, () => {
      console.log(`🚀 Semantic search server running on http://localhost:${PORT}`);
      console.log(`📊 Indexed ${variablesData.length} variables`);
      console.log(`🔍 Ready for search queries at /api/search`);
    });
    
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();