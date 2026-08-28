const express = require("express");
const cors = require("cors");
const csv = require("csv-parser");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

console.log("Starting semantic search server...");

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage for variables and embeddings
let variables = [];
let embeddings = [];
let isEmbeddingsReady = false;

// ============================================================================
// CONFIGURATION: Local LLM Endpoint
// ============================================================================
// Update this URL to point to your local LLM server
const LOCAL_LLM_ENDPOINT = process.env.LLM_ENDPOINT || "http://127.0.0.1:11434/api/generate";
const LOCAL_LLM_MODEL = process.env.LLM_MODEL || "deepseek-r1:8b"; // e.g., "llama2", "mistral", etc.

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
    model = SentenceTransformer('all-MiniLM-L6-v2')
    
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

// ============================================================================
// NEW: Helper function to perform semantic search (reused from /api/search)
// ============================================================================
async function performSemanticSearch(query, topK = 20) {
  if (!isEmbeddingsReady) {
    throw new Error("Embeddings not ready yet");
  }
  
  console.log(` Performing semantic search for: "${query}"`);
  
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
  
  const topResults = similarities.slice(0, topK).map(item => ({
    dataset_id: item.variable.dataset_id,
    attr_id: item.variable.attr_id,
    attr_label: item.variable.attr_label,
    attr_desc: item.variable.attr_desc,
    tags: item.variable.tags,
    entity_type: item.variable.entity_type,
    start_date: item.variable.start_date,
    end_date: item.variable.end_date,
    similarity: Math.round(item.similarity * 1000) / 1000,
    embeddingText: item.variable.embeddingText
  }));
  
  return topResults;
}

// ============================================================================
// NEW: Helper function to call local LLM
// ============================================================================
async function callLocalLLM(systemPrompt, userPrompt, temperature = 0.2) {
  try {
    console.log(` Calling local LLM at ${LOCAL_LLM_ENDPOINT}...`);
    
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
    
    const response = await fetch(LOCAL_LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL,
        prompt: fullPrompt,
        temperature: temperature,
        stream: false,
        format: 'json' // Request JSON output if your LLM supports it
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Extract response text (adjust based on your LLM's response format)
    // For Ollama: data.response
    // For other LLMs, adjust accordingly
    const responseText = data.response || data.text || data.content || '';
    
    console.log(` LLM responded with ${responseText.length} characters`);
    
    return responseText;
    
  } catch (error) {
    console.error(' LLM call failed:', error.message);
    throw new Error(`Failed to call local LLM: ${error.message}`);
  }
}

// ============================================================================
// NEW: Generate IR from query using LLM
// ============================================================================
async function generateIRFromQuery(userQuery, topVariables) {
  
  // System prompt for IR generation
  const systemPrompt = `You are an expert geospatial analyst. Your job is to convert a natural-language question into a structured geospatial analytic plan.

You will receive the user's query and a list of potentially relevant variables identified via semantic search.

For the given user query and variables, extract ONLY the information required to build a multi-step geospatial analysis pipeline.

Return ONLY valid JSON following the specified IR schema. Do NOT guess variable names; describe concepts using plain language only.

IR Schema:
{
  "raw_query": "string - The original user input query",
  "entities": [
    {
      "type": "string - Type of entity (e.g., 'crop', 'location', 'demographic')",
      "name": "string - Plain language name or description"
    }
  ],
  "spatial_operations": [
    {
      "op": "string - Operation name (e.g., 'buffer', 'intersect', 'overlay')",
      "distance": "string - Distance with units (optional)",
      "target": "string - Target entity in plain language"
    }
  ],
  "temporal_filter": {
    "field": "string - Time-related field or concept",
    "relative": "string - Relative time description (e.g., 'last 5 years')",
    "absolute_start": "string - Absolute start date (optional)",
    "absolute_end": "string - Absolute end date (optional)"
  },
  "filters": [
    {
      "type": "string - Filter type (e.g., 'trend', 'threshold', 'category')",
      "field": "string - Field to filter on",
      "direction": "string - Direction (e.g., 'increase', 'decrease', optional)",
      "value": "string - Filter value (optional)",
      "operator": "string - Comparison operator (e.g., '>', '<', '=', optional)"
    }
  ],
  "aggregations": [
    {
      "function": "string - Aggregation function (e.g., 'mean', 'sum', 'count')",
      "field": "string - Field to aggregate",
      "group_by": "string - Grouping dimension (optional)"
    }
  ],
  "output_type": "string - Desired output format (e.g., 'map', 'table', 'chart', 'statistics')"
}

Be thorough but precise. Extract all relevant analytical steps from the user's query.`;

  // User prompt with context
  const userPrompt = `Input Context:
${JSON.stringify({
  user_query: userQuery,
  top_variables: topVariables.map(v => ({
    attr_label: v.attr_label,
    attr_desc: v.attr_desc,
    tags: v.tags,
    entity_type: v.entity_type,
    start_date: v.start_date,
    end_date: v.end_date
  }))
}, null, 2)}

Analyze the above query and variables, then return the IR as valid JSON.`;

  const llmResponse = await callLocalLLM(systemPrompt, userPrompt, 0.2);
  
  // Parse JSON response
  let ir;
  try {
    // Try to extract JSON if LLM wrapped it in markdown or other text
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      ir = JSON.parse(jsonMatch[0]);
    } else {
      ir = JSON.parse(llmResponse);
    }
  } catch (error) {
    console.error('Failed to parse IR JSON:', error);
    throw new Error(`LLM returned invalid JSON: ${error.message}`);
  }
  
  console.log('Successfully generated IR');
  return ir;
}

// ============================================================================
// NEW: Generate DAG execution plan from IR
// ============================================================================
async function generateDAGFromIR(ir, topVariables) {
  
  // System prompt for DAG generation
  const systemPrompt = `You are an expert in geospatial data processing pipelines. Your job is to convert a structured Intermediate Representation (IR) into an executable Directed Acyclic Graph (DAG).

The DAG should represent a sequence of atomic geospatial operations that can be executed by a processing engine like GeoPandas or DuckDB.

Each node in the DAG represents a single operation with:
- node_id: Unique identifier (e.g., "step_1", "step_2")
- operation: The operation name (e.g., "load_data", "buffer", "filter_temporal", "spatial_join", "aggregate")
- inputs: Array of input names (either dataset names or outputs from previous steps)
- parameters: Object containing operation-specific parameters
- output_name: The name of this node's output (used as input for subsequent nodes)

Common operations:
- load_data: Load a dataset
- buffer: Create buffer around geometries
- filter_temporal: Filter by time range
- filter_attribute: Filter by attribute values
- spatial_join: Join datasets by spatial relationship
- intersect: Spatial intersection
- aggregate: Aggregate values (mean, sum, count, etc.)
- overlay: Overlay spatial layers

The final node should produce "final_output".

Return ONLY valid JSON with a "dag" array containing the execution steps in order.`;

  // User prompt with IR and available variables
  const userPrompt = `Intermediate Representation:
${JSON.stringify(ir, null, 2)}

Available Variables:
${JSON.stringify(topVariables.map(v => ({
  dataset_id: v.dataset_id,
  attr_label: v.attr_label,
  attr_desc: v.attr_desc,
  entity_type: v.entity_type
})), null, 2)}

Generate a DAG execution plan that implements the operations described in the IR. Return as JSON with a "dag" key containing an array of step objects.`;

  const llmResponse = await callLocalLLM(systemPrompt, userPrompt, 0.2);
  
  // Parse JSON response
  let dagResult;
  try {
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      dagResult = JSON.parse(jsonMatch[0]);
    } else {
      dagResult = JSON.parse(llmResponse);
    }
  } catch (error) {
    console.error('Failed to parse DAG JSON:', error);
    throw new Error(`LLM returned invalid JSON for DAG: ${error.message}`);
  }
  
  console.log('✅ Successfully generated DAG');
  return dagResult.dag || dagResult;
}

// ============================================================================
// NEW: /api/parse-query endpoint - Main NL-to-IR-to-DAG pipeline
// ============================================================================
app.post("/api/parse-query", async (req, res) => {
  try {
    if (!isEmbeddingsReady) {
      return res.status(503).json({ 
        error: "Embeddings not ready yet. Please wait for system initialization." 
      });
    }
    
    const { q: query } = req.body;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ 
        error: "Query parameter 'q' is required" 
      });
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`NL-to-IR-to-DAG Pipeline Started`);
    console.log(`Query: "${query}"`);
    console.log(`${'='.repeat(80)}\n`);
    
    // STEP 1: Perform semantic search to find top 20 relevant variables
    console.log('STEP 1: Semantic Search');
    const topVariables = await performSemanticSearch(query, 20);
    console.log(`   Found ${topVariables.length} relevant variables\n`);
    
    // STEP 2: Generate IR using LLM
    console.log('STEP 2: Generating Intermediate Representation (IR)');
    const ir = await generateIRFromQuery(query, topVariables);
    console.log(`   IR generated with ${ir.entities?.length || 0} entities, ${ir.spatial_operations?.length || 0} operations\n`);
    
    // STEP 3: Generate DAG execution plan from IR
    console.log('STEP 3: Generating DAG Execution Plan');
    const dag = await generateDAGFromIR(ir, topVariables);
    console.log(`   DAG generated with ${dag?.length || 0} steps\n`);
    
    // Construct final response
    const response = {
      query: query,
      top_variables: topVariables,
      ir: ir,
      dag: dag
    };
    
    console.log(`${'='.repeat(80)}`);
    console.log(`Pipeline Complete`);
    console.log(`${'='.repeat(80)}\n`);
    
    res.json(response);
    
  } catch (error) {
    console.error("Parse query error:", error);
    res.status(500).json({ 
      error: "Failed to parse query", 
      details: error.message 
    });
  }
});

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
    console.log("Semantic search system ready!");
    
  } catch (error) {
    console.error("Failed to initialize embeddings:", error.message);
    console.error("Make sure you have:");
    console.error("1. Python installed with sentence-transformers library");
    console.error("2. CSV file in the correct location");
    console.error("3. Sufficient memory for embedding generation");
    process.exit(1);
  }
}

// Search endpoint (UNCHANGED - preserving existing functionality)
app.get("/api/search", async (req, res) => {
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
    
    const topResults = await performSemanticSearch(query, 20);
    res.json(topResults);
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ 
      error: "Search failed", 
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
    llmEndpoint: LOCAL_LLM_ENDPOINT,
    llmModel: LOCAL_LLM_MODEL
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
    console.log(`Semantic search backend running on http://127.0.0.1:${PORT}`);
    console.log(`API endpoints:`);
    console.log(`   GET  /api/search?q=your+query`);
    console.log(`   POST /api/parse-query (body: {"q": "your query"}) [NEW]`);
    console.log(`   GET  /api/health`);
    console.log(`   GET  /api/mock-search?q=your+query (fallback)`);
    console.log(`\nLLM Configuration:`);
    console.log(`   Endpoint: ${LOCAL_LLM_ENDPOINT}`);
    console.log(`   Model: ${LOCAL_LLM_MODEL}`);
  });
}).catch(error => {
  console.error("Failed to start server:", error);
  process.exit(1);
});