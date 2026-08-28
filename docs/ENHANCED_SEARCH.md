# Enhanced Geospatial Search System

A multi-agent search system that combines query decomposition, semantic search, and PostGIS database integration using LangGraph/LangChain.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              User Query                                       │
│        "Show me poverty rates normalized by population for counties"         │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        STEP 1: Query Decomposition                           │
│                         (LLM via LangChain/Ollama)                           │
├──────────────────────────────────────────────────────────────────────────────┤
│  Input: "Show me poverty rates normalized by population for counties"        │
│                                                                              │
│  Output:                                                                     │
│  {                                                                           │
│    "primary_concepts": ["poverty rates", "poverty"],                         │
│    "normalization_concepts": ["population", "total population"],             │
│    "filter_concepts": [],                                                    │
│    "geographic_level": "county",                                             │
│    "search_queries": [                                                       │
│      {"query": "poverty rate", "purpose": "primary"},                        │
│      {"query": "population total", "purpose": "normalization"},              │
│      {"query": "county demographics", "purpose": "related"}                  │
│    ]                                                                         │
│  }                                                                           │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│  STEP 2a: Semantic    │ │  STEP 2b: Semantic    │ │  STEP 2c: PostGIS     │
│  Search (Primary)     │ │  Search (Normalization)│ │  Metadata Search      │
├───────────────────────┤ ├───────────────────────┤ ├───────────────────────┤
│  Query: "poverty rate"│ │  Query: "population"  │ │  All decomposed       │
│                       │ │                       │ │  terms searched       │
│  Embedding Search     │ │  Embedding Search     │ │  against metadata     │
│  ↓                    │ │  ↓                    │ │  table                │
│  Variables:           │ │  Variables:           │ │  ↓                    │
│  - Poverty_Rate_Est   │ │  - Total_Population   │ │  Datasets:            │
│  - Pct_Below_Poverty  │ │  - Pop_Over_18        │ │  - acs_2020_county    │
│  - Poverty_Status     │ │  - Households         │ │  - census_dp02        │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘
                    │                 │                 │
                    └─────────────────┼─────────────────┘
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     STEP 3: Result Aggregation                               │
├──────────────────────────────────────────────────────────────────────────────┤
│  Combine results by purpose:                                                 │
│                                                                              │
│  results_by_purpose: {                                                       │
│    "primary": [Poverty_Rate_Est, Pct_Below_Poverty, ...],                   │
│    "normalization": [Total_Population, Pop_Over_18, ...],                   │
│    "filter": [],                                                             │
│    "related": [Median_Income, Unemployment_Rate, ...]                       │
│  }                                                                           │
│                                                                              │
│  Deduplicate and rank by similarity score                                    │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    STEP 4: IR Generation (LLM)                               │
├──────────────────────────────────────────────────────────────────────────────┤
│  Generate structured Intermediate Representation including:                   │
│  - Entities (data types needed)                                              │
│  - Spatial operations (buffer, join, etc.)                                   │
│  - Filters (temporal, attribute)                                             │
│  - Aggregations                                                              │
│  - Output type                                                               │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    STEP 5: DAG Generation (LLM)                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Convert IR to executable DAG:                                               │
│                                                                              │
│  [                                                                           │
│    {node_id: "step_1", operation: "load_data", inputs: ["poverty_table"]},  │
│    {node_id: "step_2", operation: "load_data", inputs: ["population_table"]},│
│    {node_id: "step_3", operation: "join", inputs: ["step_1", "step_2"]},    │
│    {node_id: "step_4", operation: "normalize",                               │
│     parameters: {numerator: "poverty_rate", denominator: "population"}},    │
│    {node_id: "step_5", operation: "output", output_name: "final_output"}    │
│  ]                                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Files

### Python Module: `geospatial_search_enhanced.py`

Full LangGraph-based agent system including:

- **PostGISSearcher**: Database interface for searching metadata and executing queries
- **QueryDecomposer**: LLM-powered query decomposition
- **GeospatialSearchAgent**: LangGraph workflow orchestrating the full pipeline

```python
from geospatial_search_enhanced import GeospatialSearchAgent, DatabaseConfig, LLMConfig

# Configure
db_config = DatabaseConfig(host="localhost", database="mygisdb", user="samspell")
llm_config = LLMConfig(model="llama3.1", base_url="http://localhost:11434")

# Create agent
agent = GeospatialSearchAgent(db_config, llm_config)
agent.connect()

# Search
results = agent.search_sync("Show me poverty rates normalized by population")
print(results)

agent.disconnect()
```

### Node.js Module: `enhanced_search_server.js`

Express.js integration with:

- Query decomposition via LLM
- PostGIS metadata search
- Column search
- Table sampling
- Statistics queries
- Spatial queries
- Table joins

```javascript
const enhancedSearch = require('./enhanced_search_server');

// Use standalone
const decomposition = await enhancedSearch.decomposeQuery("poverty by population");
const metadata = await enhancedSearch.searchMetadata(["poverty", "population"]);

// Or mount as Express router
app.use("/api", enhancedSearch.createEnhancedRouter(yourSemanticSearchFn));
```

### Integration: `geospatial_server_integration_example.js`

Shows how to integrate with your existing `geospatial_server.js`:

```javascript
// NEW endpoint that uses enhanced search
app.post("/api/parse-query-enhanced", async (req, res) => {
  // 1. Decompose query
  // 2. Multi-concept semantic search
  // 3. PostGIS metadata search
  // 4. Combine and generate IR/DAG
});
```

## API Endpoints

### Enhanced Search Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/parse-query-enhanced` | POST | Full enhanced pipeline with decomposition |
| `/api/enhanced-search` | POST | Enhanced search without IR/DAG generation |
| `/api/decompose-query` | POST | Query decomposition only |
| `/api/search-metadata` | POST | Search PostGIS dataset catalog |
| `/api/search-columns` | POST | Search for column names |
| `/api/table-sample` | POST | Get sample data from a table |
| `/api/column-statistics` | POST | Get column statistics |
| `/api/spatial-query` | POST | Execute spatial query with optional bbox |
| `/api/join-tables` | POST | Join tables by FIPS code |

### Original Endpoints (Preserved)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/parse-query` | POST | Original single-search pipeline |
| `/api/search` | GET | Original semantic search |
| `/api/health` | GET | Health check |

## Usage Examples

### 1. Query with Normalization

```bash
curl -X POST http://localhost:4000/api/parse-query-enhanced \
  -H "Content-Type: application/json" \
  -d '{"q": "poverty rates per capita by county"}'
```

Response includes:
- Decomposed query with `normalization_concepts: ["capita", "population"]`
- Separate search results for primary (poverty) and normalization (population) variables
- DAG with `normalize` operation

### 2. Multi-Variable Query

```bash
curl -X POST http://localhost:4000/api/enhanced-search \
  -H "Content-Type: application/json" \
  -d '{"q": "unemployment, education levels, and median income for rural areas"}'
```

Response includes:
- Multiple search concepts: unemployment, education, income, rural
- Results grouped by purpose
- PostGIS metadata matches

### 3. Search PostGIS Metadata Directly

```bash
curl -X POST http://localhost:4000/api/search-metadata \
  -H "Content-Type: application/json" \
  -d '{"terms": ["poverty", "income"], "geometry_type": "POLYGON", "limit": 10}'
```

### 4. Get Column Statistics

```bash
curl -X POST http://localhost:4000/api/column-statistics \
  -H "Content-Type: application/json" \
  -d '{"table_name": "acs_2020_county", "column": "poverty_rate", "group_by": "state"}'
```

## Setup

### Prerequisites

1. **PostGIS Database** with data loaded via `geospatial_etl.py`
2. **Ollama** running with llama3.1 model
3. **Node.js** 18+ with dependencies:
   ```bash
   npm install express cors pg
   ```
4. **Python 3.8+** with dependencies:
   ```bash
   pip install psycopg2-binary pandas sqlalchemy langchain-core langchain-ollama langgraph
   ```

### Configuration

Update the configuration in both files:

```javascript
// enhanced_search_server.js
const CONFIG = {
  llm: {
    endpoint: "http://localhost:11434/api/chat",
    model: "llama3.1"
  },
  database: {
    host: "localhost",
    port: 5432,
    database: "mygisdb",
    user: "your_user",
    password: ""
  }
};
```

```python
# geospatial_search_enhanced.py
db_config = DatabaseConfig(
    host="localhost",
    port="5432",
    database="mygisdb",
    user="your_user",
    password=""
)
```

### Running

```bash
# Start the enhanced server
node enhanced_search_server.js

# Or integrate with existing server
node geospatial_server_integration_example.js
```

## Key Features

### 1. Query Decomposition

The system intelligently identifies different types of variables needed:

- **Primary**: The main data the user wants
- **Normalization**: Variables for computing ratios (per capita, per area)
- **Filter**: Criteria for filtering (rural, urban, high/low)
- **Related**: Semantically related variables to expand results

### 2. Parallel Search

Multiple search strategies run in parallel:
- Semantic embedding search for each concept
- PostGIS metadata catalog search
- Column name pattern matching

### 3. PostGIS Integration

Direct access to the metadata created by `geospatial_etl.py`:
- `dataset_metadata` table with all imported datasets
- Column lists for searching specific variables
- Geometry type filtering
- Bounding box queries

### 4. DAG Generation

The generated DAG includes normalization operations:

```json
{
  "node_id": "step_4",
  "operation": "normalize",
  "inputs": ["poverty_data", "population_data"],
  "parameters": {
    "numerator_column": "poverty_count",
    "denominator_column": "total_population"
  },
  "output_name": "poverty_rate_normalized"
}
```

## Extending

### Adding Custom Tools

```python
from langchain_core.tools import tool

@tool
def my_custom_tool(param: str) -> str:
    """Description of what this tool does."""
    # Implementation
    return result

# Add to agent
agent.tools.append(my_custom_tool)
```

### Custom Search Logic

```javascript
// Add to enhanced_search_server.js
async function customSearchFunction(query, options) {
  // Your custom search logic
  return results;
}

module.exports = {
  ...module.exports,
  customSearchFunction
};
```

## Future Enhancements

1. **Vector Store Integration**: Add pgvector for storing embeddings directly in PostGIS
2. **Caching**: Cache decomposition and search results
3. **Async Processing**: Use message queues for long-running queries
4. **Result Ranking**: ML-based ranking of combined results
5. **Query Feedback**: Learn from user selections to improve decomposition
