# Query decomposition: prompt, model, candidate caps (2026-11-19)

Question: should decomposition move from gemma3:4b to the planner model
(qwen3:14b), and was the prompt holding it back? Deployed result:
`DECOMP_PROMPT=v3`, `DECOMP_MODEL=qwen3:14b`, `DECOMP_THINK=off`
(deploy/.env). The caps are unchanged.

Prompts (`backend/unified_search_server.js`, `DECOMP_PROMPTS`):

- **v1**: the original prompt. It ends with "Return JSON with this exact structure" and a two-item example.
- **v3**: v1 with three changes:
  - The two-item example is replaced by field descriptions.
  - "Use as many as the query needs: one for a simple query, five or more for a compound one."
  - It asks for 1-3 `related` terms, meaning the catalog's wording or a closely related measure.
- **v2**: a full rewrite. It describes the catalog, defines each purpose, tells the model not to make search terms for places, units or years, and gives five examples.

Every setting can be overridden per request with `decomp: {prompt, model, think}` and
`candidates: {feature_cap, primary, normalization, filter, related,
retrieval_budget, only}`, so an A/B needs no container recreate.

## Reach (`reach.py`)

"Reached" means every measure the question declares is on the planner's candidate list. The test covers 83 dev questions: research, research_advanced, gis_ops, plus the layer_concepts set. Each ran twice, 166 tries per arm. Held-out questions were never read.

| arm | reached | mean sub-queries | decomposition p50 |
|---|--:|--:|--:|
| v1 gemma (was live) | 148 (89.2%) | 3.65 | 1.04 s |
| v3 gemma | 150 (90.4%) | 4.82 | 1.19 s |
| v2 gemma | 144 (86.7%) | 2.2 | 1.04 s |
| v1 qwen | 155 (93.4%) | **2.07** | 1.64 s |
| **v3 qwen** | **159 (95.8%)** | 6.17 | 2.69 s |
| v2 qwen | 156 (94.0%) | 2.0 | 1.67 s |
| v3 qwen + wide caps | 157 (94.6%) | 6.06 | 2.61 s |

- **The two-item example did anchor qwen3.** On v1 it returned a mean of 2.07 sub-queries, against gemma's 3.65. Removing the example and asking for "as many as needed" takes it to 5-10.
- **The rewrite (v2) under-decomposes with both models.** Its "don't make terms for..." rules read as "be brief". On gemma it lost 9 of 56 layer questions.
- **Wide caps found the needed data slightly less often, not more.** That arm used `feature_cap` 10, `primary` 14, `normalization` 8, `related` 6 and `top_k` 35. Showing the planner more candidates is not where the losses are.
- **num_ctx does not matter for decomposition.** Its prompt is 229-690 tokens.

## End to end (one run each, experiment container on :4100)

| | v1 gemma (was live) | **v3 qwen** | v3 qwen, wide caps |
|---|--:|--:|--:|
| research.yaml answer correctness | 61.1% (25.8 s/q) | 61.1% (**24.1 s**) | 72.2% (21.2 s) |
| research_advanced (`/api/research`) | 66.7% (34.3 s) | **70.8%** (**27.8 s**) | 58.3% (29.1 s) |
| combined, of 42 | 27 | **28** | 27 |
| plan_correctness op appropriateness | 92.3% | **96.2%** | 92.3% |
| plan validity | 96.2% | **100%** | 96.2% |
| plan suite mean latency | 23.2 s | **17.4 s** | 17.6 s |
| known_item via `--endpoint unified`, R@1 / MRR | 41.7% / 0.576 | **58.3% / 0.704** | n/a |
| queries.yaml via `unified`, recall / MRR | 100% / 0.773 | 100% / **0.820** | n/a |

- **v3 + qwen is the same or better on every suite, and faster end to end.** Decomposition itself is about 1.6 s slower. That is more than repaid because Ollama no longer swaps between gemma and qwen at `OLLAMA_MAX_LOADED_MODELS=1`.
- **Wide caps move answers in both directions**: +2 on research and -3 on advanced. These are single runs on small suites, so this is not a reason to change the caps.
- **The answer-correctness absolute numbers are lower than the 83-89% recorded on 2026-11-11.** Both arms share this build, which includes the uncommitted DSL work in `planner/index.js`, so the comparison between arms is fair. The absolute level was not investigated.
- **The two known_item numbers are not comparable.** The recorded 91.7% uses `--endpoint search`, which skips decomposition, so it cannot see this change. `unified` is the endpoint that can.

## Not done

- **Not checked:** answerability (false refusals) on the new setup, and repeat runs.
- **Gemma still handles two jobs:** rewriting follow-up questions and extracting research keywords (`LLM_MODEL`). Moving everything to one model means `LLM_MODEL=qwen3:14b` plus `LLM_THINK=off`. That route is untested; check `followup_probe.py` first. `numCtxFor` now gives any planner-model call the planner's 8,192-token context, so this cannot silently shrink the planner's context window.
