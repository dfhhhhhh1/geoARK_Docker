# The natural-language → analysis pipeline

How GeoARK turns a question into a geospatial analysis: what it does now, why
that shape is fragile, and what to build instead.

---

## 1. What exists today

Two generations of the same idea live in the repo.

**Generation 1** — now `backend/legacy/geospatial_server.js`, `POST /api/parse-query`:

```
query → embed → top-20 variables → LLM writes IR JSON → LLM writes DAG JSON → return
```

**Generation 2** — `backend/unified_search_server.js`, `POST /api/unified-search` (the live entrypoint):

```
query → LLM decomposes into concepts (primary / normalization / filter / related)
      → hybrid search per concept (0.7 × BGE cosine + 0.3 × keyword overlap)
      → LLM verifies/filters the merged results
      → PostGIS metadata lookup
      → IR → DAG
```

Generation 2 is a real improvement: decomposing "poverty per capita" into
*poverty* **and** *population* is exactly the right instinct, and hybrid search
fixes the cases where embeddings miss an exact variable name.

**Generation 2.5** — `backend/geospatial_search_enhanced.py` already
defines six LangGraph `@tool` functions (`search_metadata`, `search_columns`,
`get_table_sample`, `get_column_statistics`, `decompose_query`, `join_datasets`).
This is the right architecture and is 80% written. It just isn't what the
frontend calls — connecting it is Phase 3.

## 2. Why the current shape is fragile

**The LLM is asked to author JSON, unconstrained.** Both IR and DAG generation
end in `llmResponse.match(/\{[\s\S]*\}/)` followed by `JSON.parse`. A 4B model
that emits a preamble, a trailing comma, two JSON objects, or `<think>` tags
(the `deepseek-r1` default) takes down the whole request with a 500. Ollama has
supported **schema-constrained decoding** since 0.5 — you pass a JSON Schema as
`format` and the tokens are constrained so invalid JSON is *unrepresentable*.
Adopting that removes an entire class of failure for about ten lines of change.

**The LLM invents identifiers.** The IR prompt says "Do NOT guess variable
names", and then the DAG prompt hands the model a list of variables and asks it
to produce `load_data` steps — so it guesses table names anyway. Nothing
validates that `poverty_table` exists.

**It is one shot, with no feedback.** The model gets one chance at retrieval,
one at the IR, one at the DAG. It cannot look at a column's actual values, or
notice that a search returned nothing, or try a different phrasing. A person
doing this analysis would iterate; the pipeline can't.

**Nothing executes the DAG.** The response is a plan the user cannot run.

**Progress is invisible.** A query runs three sequential LLM calls at 5–20 s
each on a local model. The UI shows a spinner for a minute.

## 3. The shape to move to: a constrained tool-calling agent

The core reframe: **stop asking the model to write the answer, and start giving
it tools that can only produce valid answers.** The LLM chooses *which* tool and
*with what arguments*; your code owns everything else.

```
                    ┌──────────────────────────────┐
   user query ─────►│  agent loop (local LLM)      │
                    │  schema-constrained decoding │
                    └───┬──────────────────────▲───┘
                        │ tool call            │ tool result / validation error
                        ▼                      │
      ┌─────────────────────────────────────┐  │
      │  TOOL SURFACE (typed, validated)    │──┘
      │                                     │
      │  search_variables(concept, level)   │  → pgvector + FTS hybrid
      │  describe_dataset(dataset_id)       │  → schema, row count, bbox, CRS
      │  column_stats(table, column)        │  → min/max/nulls/distribution
      │  sample_rows(table, n)              │  → 5 real rows
      │  add_step(op, inputs, params)       │  → appends to a validated plan
      │  validate_plan()                    │  → typecheck + dry-run
      │  execute_plan()                     │  → runs it, returns GeoJSON + stats
      └─────────────────────────────────────┘
```

### 3a. Ground every identifier in a lookup

Rule: **the model may never emit a `dataset_id`, `table_name`, or `column` that
it did not receive from a tool result in this conversation.** Enforce it in the
validator, not the prompt. `add_step` rejects unknown identifiers and returns an
error the model can read and correct.

This one rule eliminates hallucinated schemas entirely, which is the failure
mode that makes small local models feel unusable for this task.

### 3b. Make the plan a typed DSL, not free-form JSON

Define a closed set of operations with a schema per operation — Pydantic on the
Python side, zod on the Node side:

```python
class SpatialJoin(BaseModel):
    op: Literal["spatial_join"]
    left: StepRef
    right: StepRef
    predicate: Literal["intersects", "within", "contains", "dwithin"]
    distance_m: float | None = None

class Normalize(BaseModel):
    op: Literal["normalize"]
    numerator: ColumnRef      # ColumnRef validates against the live catalog
    denominator: ColumnRef
    scale: float = 1.0
```

Then a **deterministic compiler** turns a validated plan into PostGIS SQL. The
model writes the plan; your code writes the SQL. Benefits compound: no arbitrary
code execution, the same plan always produces the same result, plans are
diffable and cacheable, and you can render the plan in the UI as an editable
pipeline the user can correct by hand.

Keep the op set genuinely small — `load`, `filter_attr`, `filter_temporal`,
`buffer`, `spatial_join`, `aggregate`, `normalize`, `rank`, `output`. Nine ops
cover the great majority of real queries, and a small closed vocabulary is
dramatically easier for a 4B model to use correctly than an open one.

### 3c. Validate → repair → retry

When validation fails, hand the error *back to the model* as a tool result and
let it fix its own call, capped at 2–3 attempts. This turns most hard failures
into a slightly slower success. It is the single highest-leverage addition after
constrained decoding.

### 3d. Route to the right model size

Not every step needs the same model. On one server with `OLLAMA_MAX_LOADED_MODELS=2`:

| Step | Model | Why |
|---|---|---|
| Decomposition, routing, reranking | `qwen3:4b` / `gemma3:4b` | fast, structured, low stakes |
| Planning, repair, explanation | `qwen3:14b` / `llama3.1:8b` | needs actual reasoning |

Set `OLLAMA_KEEP_ALIVE=-1` so neither is evicted between requests.

### 3e. Expose the tools over MCP

This is the piece that has changed most since the project was last worked on.
The Model Context Protocol standardizes how a model reaches tools. If the tool
surface in §3 is an MCP server rather than a set of private functions, then:

- the web app uses it through your agent loop;
- you can debug the exact same tools interactively from Claude Code or any MCP
  client, which makes prompt iteration enormously faster;
- swapping the local model for a different one — or temporarily for a frontier
  model, to establish a quality ceiling — changes one config line;
- other people's geospatial MCP servers become composable with yours.

Concretely: a small Python MCP server wrapping `PostGISSearcher` from
`backend/geospatial_search_enhanced.py`. Most of the code already exists; it needs the
`@tool` decorators swapped for MCP tool registrations.

## 4. Retrieval improvements, in order of value

1. **Move the index into pgvector.** One SQL query replaces 6,860 JS cosine
   loops. See [DEPLOYMENT.md §3](DEPLOYMENT.md#3-persisting-the-computed-embeddings-part-c--the-big-win).

2. **Fuse properly instead of blending scores.** *(`CONFIG.search.semanticWeight` / `keywordWeight` are now env-tunable, so this is easy to A/B once the eval set exists.)*
    The current `0.7 × semantic +
   0.3 × keyword` compares a cosine (0–1) against an unnormalized token-overlap
   count — the weights don't mean what they look like. Use **Reciprocal Rank
   Fusion**: `score = Σ 1/(60 + rank_i)` across the two rankings. It needs no
   tuning and no score normalization, and it is strictly more robust.

3. **Add a cross-encoder reranker.** Retrieve 50 candidates cheaply, then rerank
   with `BAAI/bge-reranker-base` (~30 ms for 50 pairs on CPU). This is far
   better and ~50× cheaper than the current "ask the LLM to verify results"
   step, which is a whole generation call doing a reranker's job.

   **Now with evidence:** on *"unemployment and food stamp usage together"* the
   verification step reduced 18 retrieved results to 3. It is not just expensive,
   it is destructive. The decomposition ahead of it was correct — it split the
   query into unemployment and food-stamp concepts — and then the verifier threw
   most of the retrieved rows away.

4. **Embed richer text.** Right now the embedded string is
   `label + description + tags`, lowercased. Add `entity_type` ("county-level"),
   the temporal range in words ("2015 to 2020"), and the parent dataset name.
   Users query with those attributes constantly.

5. ~~**Cache query embeddings.**~~ Done in Phase 1 (`lru_cache` in the embedder).

6. **Demote margin-of-error rows.** Done in Phase 2. ~900 of 6,860 catalog rows
   are ACS MOE companions that near-duplicate the estimates they accompany;
   demoting them (not filtering — they stay reachable) was worth +2.5pp concept
   recall on its own.

## 5. Making it feel fast

Local models are slow enough that perceived latency is a design problem, not
just an optimization one.

- **Stream the pipeline over SSE.** Emit `decomposed`, `searching`,
  `found_variables`, `planning`, `plan_ready`, `executing`, `done`. The user
  sees candidate variables in ~1 s instead of a blank spinner for 60 s.
- **Show the plan before executing it**, with an "Edit" affordance. Reviewing a
  plan is much faster than waiting for a wrong answer.
- **Return retrieval results without waiting for the LLM.** Search is fast;
  planning is slow. Don't couple them.
- **Cache aggressively.** Decompositions and plans keyed by normalized query
  text; a demo of the same ten queries then runs instantly.

## 6. How to know whether any of this helps

Right now there is no way to tell whether a prompt edit improves things. Before
changing the pipeline, build the measuring stick — it is a day of work and it
pays for itself immediately:

**`eval/queries.yaml`** — 50 realistic queries with expected outcomes:

```yaml
- query: "poverty rates normalized by population for counties"
  must_retrieve: [attr_id_poverty_pct, attr_id_total_pop]
  must_plan_ops: [load, normalize, output]
  geographic_level: COUNTY
```

**`eval/run.py`** — executes each query and reports:

| Metric | Measures |
|---|---|
| Recall@20 | did retrieval find the needed variables at all |
| MRR | are they ranked near the top |
| Plan validity rate | % of plans that typecheck |
| Execution success rate | % that run without error |
| p50 / p95 latency | per stage |

Run it against each model and each prompt version. Every claim in §3 and §4
becomes a number you can check rather than an opinion.
