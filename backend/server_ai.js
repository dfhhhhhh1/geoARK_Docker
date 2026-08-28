const express = require("express");
const cors = require("cors");
const csv = require("csv-parser");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const { ChatOllama } = require("@langchain/ollama");
const { PromptTemplate } = require("@langchain/core/prompts");
const { OllamaEmbeddings } = require("@langchain/ollama");




console.log("Starting semantic search server with LangChain query refinement...");

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage for variables and embeddings
let variables = [];
let embeddings = [];
let isEmbeddingsReady = false;

// Initialize Ollama LLM for query refinement
const llm = new ChatOllama({
  model: "llama3.1",
  temperature: 0.3, // Lower temperature for more focused refinement
  baseUrl: "http://localhost:11434", // Default Ollama URL
});

// Prompt template for query refinement
const queryRefinementPrompt = PromptTemplate.fromTemplate(`You are a search query expert for a geospatial and demographic dataset repository. Your task is to refine user queries into optimal search terms.

The dataset contains variables with:
- Attribute labels (variable names)
- Descriptions (detailed explanations)
- Tags (categorical labels)
- Entity types (geographic levels like county, state, tract)
- Date ranges

User Query: {query}

Task: Extract and generate the most relevant search keywords and phrases that would help find matching variables in the dataset. Focus on:
1. Core concepts and themes
2. Geographic terms or entity types
3. Demographic categories
4. Statistical measures or indicators
5. Synonyms and related terms

Output ONLY the refined search terms as a concise phrase (max 50 words). No explanations, just the search terms.

Refined search terms:`);

// Query refinement function using LangChain + Ollama
async function refineQuery(userQuery) {
  try {
    console.log(`🤖 Refining query: "${userQuery}"`);
    
    const formattedPrompt = await queryRefinementPrompt.format({
      query: userQuery
    });
    
    const response = await llm.invoke(formattedPrompt);
    const refinedQuery = response.content.trim();
    
    console.log(`✨ Refined to: "${refinedQuery}"`);
    return refinedQuery;
    
  } catch (error) {
    console.error("Query refinement error:", error.message);
    console.log("⚠️  Falling back to original query");
    return userQuery; // Fallback to original query if refinement fails
  }
}

// Helper function to normalize and combine text fields for embedding
function createEmbeddingText(row) {
  const parts = [];
  
  if (row.attr_label) parts.push(row.attr_label.trim());
  if (row.attr_desc) parts.push(row.attr_desc.trim());
  
  // Parse tags - handle both array format and string format
  if (row.tags) {
    try {
      // Remove brackets and quotes, split by comma
      const cleanTags = row.tags
        .replace(/[\[\]'\"]/g, '')
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);
      parts.push(...cleanTags);
    } catch (e) {
      // If parsing fails, just add the raw string
      parts.push(row.tags.trim());
    }
  }
  
  return parts.join(' ').toLowerCase();
}

// Load CSV and prepare data
async function loadVariablesFromCSV(csvFilePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        // Create embedding text from multiple fields
        const embeddingText = createEmbeddingText(row);
        
        // Store both original row and embedding text
        results.push({
          dataset_id: row.dataset_id || '',
          attr_id: row.attr_id || row.attr_label || '',
          attr_label: row.attr_label || '',
          attr_desc: row.attr_desc || '',
          tags: row.tags || '',
          entity_type: row.entity_type || '',
          start_date: row.start_date || '',
          end_date: row.end_date || '',
          embeddingText: embeddingText
        });
      })
      .on('end', () => {
        console.log(`Loaded ${results.length} variables from CSV`);
        resolve(results);
      })
      .on('error', reject);
  });
}

// Python script for generating embeddings
const pythonEmbeddingScript = `
import sys
import json
import numpy as np
from sentence_transformers import SentenceTransformer

def main():
    # Load model
    model = SentenceTransformer('all-mpnet-base-v2')
    
    # Read input from stdin
    input_data = json.loads(sys.stdin.read())
    texts = input_data['texts']
    
    # Generate embeddings
    embeddings = model.encode(texts)
    
    # Convert to list for JSON serialization
    embeddings_list = embeddings.tolist()
    
    # Output as JSON
    result = {
        'embeddings': embeddings_list,
        'dimension': len(embeddings_list[0]) if embeddings_list else 0
    }
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
`;

// Generate embeddings using Python subprocess
async function generateEmbeddings(texts) {
  return new Promise((resolve, reject) => {
    // Create temporary Python script
    const scriptPath = path.join(__dirname, 'temp_embedding_script.py');
    fs.writeFileSync(scriptPath, pythonEmbeddingScript);
    
    const python = spawn('python', [scriptPath]);
    let output = '';
    let errorOutput = '';
    
    // Send input data
    python.stdin.write(JSON.stringify({ texts: texts }));
    python.stdin.end();
    
    python.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    python.on('close', (code) => {
      // Clean up temp file
      try {
        fs.unlinkSync(scriptPath);
      } catch (e) {
        // Ignore cleanup errors
      }
      
      if (code !== 0) {
        reject(new Error(`Python script failed: ${errorOutput}`));
        return;
      }
      
      try {
        const result = JSON.parse(output);
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse embedding result: ${e.message}`));
      }
    });
    
    python.on('error', (err) => {
      reject(new Error(`Failed to spawn Python process: ${err.message}`));
    });
  });
}

// Cosine similarity function
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must be the same length');
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
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

// Initialize embeddings at startup
async function initializeEmbeddings() {
  try {
    console.log("Loading variables from CSV...");
    
    // Try to load from the uploaded file first, fallback to a default name
    const csvPath = 'geoark_attributes.csv'; // Update this path as needed
    
    if (!fs.existsSync(csvPath)) {
      throw new Error(`CSV file not found at ${csvPath}. Please ensure the file exists.`);
    }
    
    variables = await loadVariablesFromCSV(csvPath);
    
    if (variables.length === 0) {
      throw new Error("No variables loaded from CSV");
    }
    
    console.log("Generating embeddings...");
    const texts = variables.map(v => v.embeddingText);
    
    const embeddingResult = await generateEmbeddings(texts);
    embeddings = embeddingResult.embeddings;
    
    console.log(`Generated ${embeddings.length} embeddings with dimension ${embeddingResult.dimension}`);
    
    if (embeddings.length !== variables.length) {
      throw new Error("Mismatch between number of variables and embeddings");
    }
    
    isEmbeddingsReady = true;
    console.log("✅ Semantic search system ready!");
    
  } catch (error) {
    console.error("❌ Failed to initialize embeddings:", error.message);
    console.error("Make sure you have:");
    console.error("1. Python installed with sentence-transformers library");
    console.error("2. CSV file in the correct location");
    console.error("3. Sufficient memory for embedding generation");
    process.exit(1);
  }
}

// Search endpoint with LangChain query refinement
app.get("/api/search", async (req, res) => {
  try {
    if (!isEmbeddingsReady) {
      return res.status(503).json({ 
        error: "Embeddings not ready yet. Please wait for system initialization." 
      });
    }
    
    const originalQuery = req.query.q;
    const skipRefinement = req.query.skipRefinement === 'true'; // Optional flag
    
    if (!originalQuery || originalQuery.trim().length === 0) {
      return res.json([]);
    }
    
    console.log(`🔍 Original query: "${originalQuery}"`);
    
    // Refine query using LangChain + Ollama (unless skipped)
    let searchQuery = originalQuery;
    if (!skipRefinement) {
      searchQuery = await refineQuery(originalQuery);
    } else {
      console.log("⏭️  Skipping query refinement");
    }
    
    // Generate embedding for refined query
    const queryEmbeddingResult = await generateEmbeddings([searchQuery.toLowerCase()]);
    const queryEmbedding = queryEmbeddingResult.embeddings[0];
    
    // Calculate similarities
    const similarities = embeddings.map((embedding, index) => ({
      variable: variables[index],
      similarity: cosineSimilarity(queryEmbedding, embedding)
    }));
    
    // Sort by similarity (descending) and take top results
    similarities.sort((a, b) => b.similarity - a.similarity);
    
    const topResults = similarities.slice(0, 20).map(item => ({
      dataset_id: item.variable.dataset_id,
      attr_id: item.variable.attr_id,
      attr_label: item.variable.attr_label,
      attr_desc: item.variable.attr_desc,
      tags: item.variable.tags,
      entity_type: item.variable.entity_type,
      start_date: item.variable.start_date,
      end_date: item.variable.end_date,
      similarity: Math.round(item.similarity * 1000) / 1000, // Round to 3 decimal places
    }));
    
    console.log(`📊 Found ${topResults.length} results, top similarity: ${topResults[0]?.similarity || 0}`);
    
    // res.json({
    //   originalQuery: originalQuery,
    //   refinedQuery: searchQuery,
    //   results: topResults
    // });

    res.json(topResults);
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ 
      error: "Search failed", 
      details: error.message 
    });
  }
});

// Direct search endpoint (no refinement)
app.get("/api/search-direct", async (req, res) => {
  try {
    if (!isEmbeddingsReady) {
      return res.status(503).json({ 
        error: "Embeddings not ready yet. Please wait for system initialization." 
      });
    }
    
    const query = req.query.q;
    if (!query || query.trim().length === 0) {
      return res.json([]);
    }
    
    console.log(`🔍 Direct search for: "${query}"`);
    
    // Generate embedding for query
    const queryEmbeddingResult = await generateEmbeddings([query.toLowerCase()]);
    const queryEmbedding = queryEmbeddingResult.embeddings[0];
    
    // Calculate similarities
    const similarities = embeddings.map((embedding, index) => ({
      variable: variables[index],
      similarity: cosineSimilarity(queryEmbedding, embedding)
    }));
    
    // Sort by similarity (descending) and take top results
    similarities.sort((a, b) => b.similarity - a.similarity);
    
    const topResults = similarities.slice(0, 20).map(item => ({
      dataset_id: item.variable.dataset_id,
      attr_id: item.variable.attr_id,
      attr_label: item.variable.attr_label,
      attr_desc: item.variable.attr_desc,
      tags: item.variable.tags,
      entity_type: item.variable.entity_type,
      start_date: item.variable.start_date,
      end_date: item.variable.end_date,
      similarity: Math.round(item.similarity * 1000) / 1000,
    }));
    
    console.log(`📊 Found ${topResults.length} results, top similarity: ${topResults[0]?.similarity || 0}`);
    
    res.json(topResults);
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ 
      error: "Search failed", 
      details: error.message 
    });
  }
});

// Test query refinement endpoint
app.get("/api/refine-query", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: "Query parameter 'q' is required" });
    }
    
    const refinedQuery = await refineQuery(query);
    
    res.json({
      originalQuery: query,
      refinedQuery: refinedQuery
    });
    
  } catch (error) {
    console.error("Query refinement error:", error);
    res.status(500).json({ 
      error: "Refinement failed", 
      details: error.message 
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    embeddingsReady: isEmbeddingsReady,
    variableCount: variables.length,
    embeddingCount: embeddings.length,
    llmEnabled: true,
    llmModel: "llama3.1"
  });
});

// Fallback for the existing mock datasets (for backward compatibility)
app.get("/api/mock-search", (req, res) => {
  const query = (req.query.q || "").toLowerCase();
  
  // This is your existing mock data logic
  const mockDatasets = [
    {
      id: '1',
      title: 'US Census Population Density 2020',
      description: 'Comprehensive population density data for all US metropolitan areas...',
      // ... rest of your mock data
    }
    // Add other mock datasets as needed
  ];
  
  const filtered = mockDatasets.filter(
    d =>
      d.title.toLowerCase().includes(query) ||
      d.description.toLowerCase().includes(query) ||
      (d.tags && d.tags.some(tag => tag.toLowerCase().includes(query)))
  );
  
  res.json(filtered);
});

const PORT = process.env.PORT || 4000;

// Start server after initializing embeddings
initializeEmbeddings().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Semantic search backend with LangChain running on http://localhost:${PORT}`);
    console.log(`📖 API endpoints:`);
    console.log(`   GET /api/search?q=your+query (with LLM refinement)`);
    console.log(`   GET /api/search?q=your+query&skipRefinement=true (skip refinement)`);
    console.log(`   GET /api/search-direct?q=your+query (no refinement)`);
    console.log(`   GET /api/refine-query?q=your+query (test refinement)`);
    console.log(`   GET /api/health`);
    console.log(`   GET /api/mock-search?q=your+query (fallback)`);
  });
}).catch(error => {
  console.error("Failed to start server:", error);
  process.exit(1);
});