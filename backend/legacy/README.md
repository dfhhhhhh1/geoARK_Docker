# legacy/

Superseded code kept for reference, not wired into anything.

## `geospatial_server.js`

The Generation-1 pipeline: `POST /api/parse-query` → semantic search →
LLM-authored IR → LLM-authored DAG. Superseded by `unified_search_server.js`,
which has better retrieval (query decomposition + hybrid search) but **no IR/DAG
generation**.

Kept because the IR and DAG system prompts (the `generateIRFromQuery` and
`generateDAGFromIR` functions) are the starting point for the Phase 3 planner,
see [../../docs/AI-PIPELINE.md](../../docs/AI-PIPELINE.md). When that planner is
built as a typed, schema-constrained DSL, delete this file.

## Deleted in the Phase 0 consolidation

Recoverable from git history (`git log --diff-filter=D --name-only`):

| File | Why |
|---|---|
| `server.js` | Semantic search only, no LLM. Superseded |
| `server_ai.js` | LangChain query-refinement experiment. Superseded by decomposition |
| `server_tunnel.js` | localtunnel variant of `server.js` |
| `semantic_backend.js` | Used the OpenAI embedding API, and read a `shortened_var.csv` that does not exist |
| `semantic_search_python.py` | Standalone script, unreferenced |
| `old_server/old_server.js` | Substring filter over the CSV |
