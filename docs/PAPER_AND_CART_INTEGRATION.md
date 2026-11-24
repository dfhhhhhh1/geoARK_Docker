# Analysis, data cart and paper upload: one flow (plan, 2026-11-20)

How the Analysis page, the Data cart and paper upload fit together, so that a
question or a paper typed into **either** box can end in a map, a download, an
AutoML run, or all three. This builds on `docs/DATA_CART_PLAN.md` (cart
Phases 1-6 and paper steps U1-U5) and does not repeat them. It adds the joins
between the pages and the order to build them in.

Status (2026-11-23): P5 (`moran`) built 2026-11-21. **P3 and P4 first version
built 2026-11-23** (paper -> study card -> cart, paper -> reproduction), see
"P3/P4 built" at the end. P1 (shared cart both ways, header badge) and P2
(AutoML from Analysis) not started; the paper card writes to the same browser
cart store, which is the part of P1 it needed.

---

## 1. What exists today

### Built and checked live (DATA_CART_PLAN "Progress")

| Piece | Where | State |
|---|---|---|
| Shelf: expanded candidates that hold data, grouped by role, with the reason each is there | `backend/cart.js`, `POST /api/cart/suggest` | built |
| Rule-based default cart; LLM curator | `cart.js`, `backend/curator.js` | curator is **opt-in** (held-out +0.03 precision, lost one subject) |
| Checkout: one wide table, LEFT JOIN onto units, CSV / GeoJSON / dictionary | `POST /api/cart/table`, `lib/cart.ts` | county only; no rasters; no zip |
| Cart -> Analysis ("Map in Analysis") | `DataCartPage` -> router state -> `AnalysisPage` `cartMap` | **one-way** |
| AutoML on the cart, spatial CV by state, residual Moran's I, partial-rho companion | `POST /api/cart/model`, `ml_service.py /automl/cv`, `CartModelPanel.tsx` | built, cart page only |
| Analysis: planner, follow-ups, workflows (`/api/research`, up to 4 steps), CSV and layer uploads | `AnalysisPage`, `UploadPanel` | built |

### In `search_and_analysis/` (the prototype) and NOT ported

| Prototype piece | What it does | Decision |
|---|---|---|
| `search/context/extract_text1.py` (markitdown) | file to text | **port** (U1) |
| `analysis/recommendML/llm2.extract_workflow` + `LLM_METHODOLOGY_SCHEMA` | paper to a list of techniques | **port the idea, not the code** (see defects below) |
| `search/context/context_pipeline.py` | keywords from an uploaded file | superseded: the paper's variables become shelf sub-queries |
| `recommend_geospatial/geospatial_analysis_pipeline.py` (PySAL Moran, LISA, Gi* on a CSV) | runs methods on a local CSV | **not ported**. GeoARK has Gi* (`hotspot`); global Moran's I and LISA are a gap, see section 4 |
| `recommendML/tabularML3.py`, `time_seriesML3.py` (AutoGluon model zoo, Chronos, DeepAR...) | trains every matched model on a CSV | tabular: covered by `/api/cart/model`. Time series: **out of scope** (county cross-sections, not series) |
| `search/searxng`, `search/semmed` | web and literature keywords | already in `backend/research.js` and `backend/expansion.js` |

Defects in the prototype extractor, read from its own saved output
(`pre_ran_results/llm_workflow_20261107_194920.json`), that the port must not
carry over:

- **The schema cannot be satisfied as written.** It requires `"methods"` while
  the property is named `"techniques"`.
- **The "evidence" is a paraphrase, not a quote**: "The paper explicitly states
  that spatial autocorrelation was examined..." Nothing can check a paraphrase
  against the text.
- **It contradicts itself.** Step 1 is "Global Moran's I, performed", and
  `gaps` says the paper "does not explicitly state ... Moran's I or Getis-Ord
  Gi*".
- **Model and context:** qwen3:1.7b, and the paper is cut at 10,000
  characters, which usually ends before the methods section of a journal
  article.

So U2 in DATA_CART_PLAN stands as written: quoted evidence, a code check that
each quote occurs in the text, the resident qwen3:14b, and chunking by section.

### The gaps this plan is about

1. **Analysis -> cart does not exist.** An analysis result cannot add its data
   to the cart, and the expansion candidates it retrieved never reach the UI.
2. **The two boxes do not know about each other.** A question typed into the
   wrong one gets the wrong kind of answer, with nothing pointing at the other.
3. **AutoML is only on the cart page.**
4. **Paper upload (U1-U5) is not started.**
5. **No cart indicator outside the cart page**, so a cart collected from
   Analysis would be invisible.

---

## 2. The design: one cart, two front doors, a paper is a third

```
                    ┌──────────── Analysis box ────────────┐
 question ─────────►│ plan -> map / stats (as today)       │──► "Data used" + "Related data" ─┐
                    └───────────────────────────────────────┘                                  │
                    ┌──────────── Data cart box ───────────┐                                   ▼
 question ─────────►│ shelf -> suggested cart (as today)   │──────────────────────────► ONE CART (lib/cart.ts)
                    └───────────────────────────────────────┘                                  │
                    ┌──────────── Paper (either box) ──────┐                                   │
 PDF / DOCX ───────►│ study card: area, unit, period,      │──► variables -> cart ─────────────┤
                    │ variables, methods (all quoted)      │──► methods -> reproduction plans  │
                    └───────────────────────────────────────┘        (run in Analysis)         │
                                                                                               ▼
                                                          download · map in Analysis · AutoML
```

Three rules make this hold together:

1. **One cart store.** `lib/cart.ts`'s `loadCart` / `saveCart` already persist
   the cart. Both pages read and write it, through a small context hook
   (`useCart`), so adding from Analysis shows on the cart page and in the
   header at once.
2. **No intent classifier picks the destination.** Either box always does its
   own job and then *offers* the other one with a button. A wrong guess from a
   model would send someone to a 30 s planner run they did not want, or hide
   the map they did. The only thing phrasing changes is which button comes
   first (`download`, `dataset`, `data on` -> the cart offer first;
   `where`, `which`, `map`, `rank` -> the map first). This is a UI default,
   so it needs no eval.
3. **Every hand-off is a deterministic edit, never a fresh planner call.**
   Cart -> map is already `map_measure` edits. Analysis -> cart sends attribute
   ids. Paper -> reproduction uses templates over cart ids (U4). The only model
   calls are the ones that already exist (planner, curator) plus the one paper
   extraction.

---

## 3. Phases

Each phase is shippable alone, in this order. Guards for every phase are at the
end.

### P1. Shared cart, both directions (no model, ~1 day)

- `frontend/src/hooks/useCart.ts`: a React context over `loadCart` / `saveCart`,
  mounted in `App.tsx`. `DataCartPage` switches to it.
- **Header badge**: "Data cart (3)" in `Header.tsx`'s NAV entry. The comment
  there about the removed cart stays; this cart checks out through a tested
  endpoint.
- **Analysis -> cart**, on every result in `ResultBlock`:
  - "Add this data to cart": the plan's loaded attributes (from `provenance`
    origins, which already name dataset, code and period), plus its area as the
    cart's area.
  - "Related data (N)": the analysis response's retrieved candidates, shown as
    a shelf (reuse the shelf row component from `DataCartPage`), each with an
    add button. Needs `/api/analyze` to return the candidates it already
    computes; behind a response field, so the planner prompt is untouched.
- **Cart -> Analysis** stays as it is. Add "Open in Explore" for one item
  (DATA_CART_PLAN Phase 5, not built).
- **Cross-offers** in each box after it answers:
  - Analysis: "Get the data for this (N measures)" -> cart page with the items
    added.
  - Cart: "Map this question in Analysis" -> `/analysis?q=...` (runs the
    planner there, when the user asks for it).

**Done when:** a cart built half from an analysis and half from the cart page
downloads as one table; the badge count matches; `npm run build` passes;
snapshot byte-identical.

### P2. AutoML from either page (~0.5 day)

- Move `CartModelPanel` behind a "Model this" action that both pages can open.
  From Analysis, the target defaults to the answer's measure and the features
  to the other cart items. The server path is unchanged (`/api/cart/model`).
- Offer it only for county value items, the same rule as today.

**Done when:** the default CHD cart reproduces the recorded numbers (R² 0.37
national by state) when opened from Analysis.

### P3. Paper -> study card -> cart (U1-U3, ~3 days)

- **Upload**: the paperclip in both boxes gains `.pdf,.docx,.txt`.
  `UploadPanel` routes by type: CSV / GeoJSON as today, documents to
  `POST /api/paper/extract`. Never stored (same rule as user CSVs).
- **Text** (U1): markitdown + pypdf fallback. **Put it on `ml_service.py`, not
  the embedder.** The embedder rebuild upgrades torch and moves the drift
  canary (traps table); `ml_service` is already a Python service with a
  memory cap. That makes paper upload depend on the `automl` profile; if that
  is not acceptable, pin torch and use the embedder as DATA_CART_PLAN U1 says.
- **Extraction** (U2): as written in DATA_CART_PLAN, plus:
  - Locate methods / data / study-area sections by heading; send each to the
    model separately at `num_ctx` 8,192, then merge. Never truncate the paper
    to a fixed length.
  - Every field carries a `quote`; code drops any item whose quote is not a
    substring of the text (after whitespace normalisation), and reports how
    many were dropped.
  - `geoark_op` is an enum, so the model cannot name a method GeoARK does not
    have; anything else is `none`, with the paper's term kept as the label.
- **Study card** (new `PaperStudyCard.tsx`): shown in the thread on Analysis
  and above the shelf on the cart page. Area, unit, period, outcome, exposures,
  covariates, methods, each with its quote on hover and a link to the page.
  Every field is editable before anything runs, because the extraction will
  sometimes be wrong and the user knows the paper.
- **Cart** (U3): each variable is a shelf sub-query; the best row per variable
  is pre-selected; unmatched variables are listed as "not in GeoARK's data",
  with the paper's own source named if it gave one.

**Done when:** U5's metrics on the dev papers: variable recall and quote
validity reported over 3 runs; the two prototype papers produce a cart.

### P4. Paper -> reproduction (U4, ~3 days)

- One button on the study card: **"Replicate the spatial analysis"**. It does
  not start on upload: a reproduction is several analyses (each 20-60 s) and
  the user should check the study card first.
- Each method maps to a template over the cart's ids (DATA_CART_PLAN U4),
  validated by `validatePlan`, run as steps of `/api/research`, and shown as
  ordinary Analysis turns. So the result is a thread the user can follow up on
  ("now only Texas"), not a report frozen at upload.
- A method summary turn at the top: each method **reproduced / approximated
  (why) / not supported**, the paper's quote beside GeoARK's number.
- Paper ML methods (random forest, XGBoost, ANN, SHAP) map to `automl`:
  a "Model this" panel pre-filled with the paper's outcome and covariates. It
  is labelled *approximated*: AutoGluon picks its own models, and the split is
  spatial, which most papers' is not. Say so; it is why the numbers will
  differ.

**Done when:** U5's "share of methods reproduced or approximated" and method
mapping accuracy, 3 runs, dev and held-out reported separately.

### P5. Fill the method gap the papers will hit first

Spatial-epidemiology papers almost always report **global Moran's I** and often
**LISA** clusters. GeoARK computes Moran's I inside `correlate` / `explain`
(`planner/stats.js`) but has no op that returns it, and no LISA.

- `moran` op (global I with a permutation or normal-approximation p, plus
  local I with the high-high / low-low / high-low / low-high classes), pure
  SQL over `county_neighbors` like `hotspot`. Phrasing-gated like every
  statistics op, so the snapshot stays byte-identical.
- Verify against PySAL on the same weights (the prototype's
  `geospatial_analysis_pipeline.py` is a ready reference implementation), the
  way Gi* was verified (mean Gi* -0.008).
- Its own `plan_probe.py` run before it is offered by the free planner; the
  paper templates can use it as soon as it is verified, because templates do
  not grow the planner's op set.

Do this before P4 if the dev papers show it is the most common unsupported
method, which is likely.

**Built 2026-11-21** (GIS_OPS_PLAN.md "H6 tier 1, item 6", evidence
`eval/gis_ops/moran/`). Equal to esda 2.10.0 on five live cases for every
deterministic quantity (1e-13); LISA classes agree on 99.07-100% of counties.
One correction to the plan above: it is **not** pure SQL. The permutation
tests (999 draws per county for LISA) run in Node after the SQL, seeded; SQL
would have meant ~19M random draws in a query. Not yet run through the
planner (plan_probe / answer_probe), which needs an API rebuild.

What paper upload changed in how it was built, and what P3 / P4 should rely on:

- **Templates set the method; the free planner never sees it.** `local`,
  `alpha`, `permutations`, `weights` and `seed` are step fields outside the
  decoding schema. `applyMoran` fills only the fields a step lacks, so a U4
  template that writes `{op: "moran", local: true, alpha: 0.01,
  permutations: 9999}` from the paper's quoted methods runs exactly that.
  The fields are validated like any browser-sent plan.
- **The extraction enum** (U2's `geoark_op`) should carry `moran_global`,
  `moran_local` (LISA) and `hotspot` (Gi*) as three values, mapped to
  `moran` with `local` false / true and to `hotspot`. Papers say "LISA",
  "local Moran's I", "cluster and outlier analysis" (ArcGIS's name for it),
  "Anselin Local Moran's I" for the second; "hot spot analysis" is Gi*.
  Quote the paper's alpha, permutations and weights into the template.
- **Global and local in one plan.** Papers report I and then the cluster map;
  one template yields both layers from one transaction (two moran steps over
  one input), so the reproduction turn reads as one analysis.
- **The response carries what papers quote**: I, E[I], z, normal-approximation
  p, pseudo p and its permutations, n and islands; for LISA the class counts
  and how many units clear alpha by chance. That is what "the paper's quote
  beside GeoARK's number" in P4's method summary needs, without parsing text.
- **Approximated, not silently different.** Only queen contiguity is built.
  The validator refuses any other `weights`, so a template cannot claim a
  paper's k-nearest or distance-band weights; the template must say
  *approximated (queen contiguity instead of k = 8 nearest neighbours)*. The
  free-planner path writes the same note when a question names other weights.
- **Gaps the dev papers will hit next**, in likely order: tract-level studies
  (no tract adjacency yet), k-nearest / distance-band weights (k-nearest from
  centroids is the cheapest: `<->` plus the geodesic check nearest_distance
  already uses), FDR / Bonferroni-corrected LISA, bivariate LISA, and
  spatial regression (lag / error). Count them on the dev papers before
  building any.

### P6. Later

- Extract the paper's reported effect sizes and set them beside GeoARK's.
- Levels below the county in the cart table (tract, ZIP), which a paper at
  tract level needs.
- Data test for duplicate columns at checkout (|rho| >= 0.97), which fixes the
  PM2.5-twice cart for every selection method.

---

## 4. Measuring it

Per CLAUDE.md, nothing here is "better" until a suite that can move says so.

- **P1 / P2**: no new retrieval or planning claim. Guards only, plus a browser
  check that the hand-offs work at desktop and phone width.
- **P3 / P4**: `eval/papers.yaml` + `eval/paper_probe.py` (DATA_CART_PLAN U5):
  8-10 spatial-epi papers, gold written by hand before any run, half held
  out. Metrics: quote validity, variable recall (to a cart row or correctly
  listed missing), study-area accuracy, method mapping accuracy, share
  reproduced or approximated, and for reproduced methods whether GeoARK's sign
  and rough size match the paper's. 3 runs.
- **P5**: equal to PySAL on two measures; `plan_probe.py` for the gate.

## 5. Guards (every phase)

- `snapshot_prompt.js` byte-identical across 48 contexts.
- `known_item.yaml`, `queries.yaml`, `cart.yaml` unchanged when retrieval is
  untouched; re-run if `/api/analyze` returning candidates changes anything on
  the retrieval path.
- `npm test` in backend; `npm run build` in frontend (the type check that
  matters).
- Rebuild the API with `--no-deps` (GPU trap) and coordinate with other
  sessions first (shared working tree).

## 6. Decisions for you

1. **Where text extraction runs**: `ml_service` (no embedder rebuild, but paper
   upload then needs the `automl` profile) or the embedder (pin torch first).
   Recommended: `ml_service`.
2. **Does upload start the reproduction automatically?** Recommended: no, one
   click after the study card, for the latency and correctness reasons above.
3. **Build `moran` / LISA (P5) before the reproduction (P4)?** Recommended: yes,
   if the dev papers confirm it is the most common missing method.

---

## P3/P4 built (2026-11-23)

`backend/paper.js` (text, sections, extraction, quote checks, matching),
`backend/paper_templates.js` (method -> plan), `POST /api/paper/extract`,
`POST /api/paper/reproduce` (`dry_run: true` returns statuses only),
`frontend/src/components/PaperPanel.tsx`, `lib/paper.ts`. Tests
`backend/test_paper.js` (26, in `npm test`; every template plan goes through
the real `validatePlan` and compiler). Suite `eval/papers.yaml` +
`eval/paper_probe.py`; runs in `eval/paper/`. Planner prompt and schema
untouched (snapshot byte-identical across 48 contexts).

**Flow.** Data cart page "Or start from a paper", or a PDF / .docx dropped on
the Analysis paperclip -> study card (area, unit, period, variables grouped
by role with the catalog row chosen for each, methods with a status and the
reason) -> "Add N measures to the cart" and/or "Replicate N methods". Nothing
runs on upload (decision 2: no). Replication runs in Analysis: each run is an
ordinary turn ("run directly, no planning needed") with the status and what
differs shown under it, so it can be followed up like any answer.

**Decisions taken, and why they differ from the plan above.**

- **Text extraction is in the Node API** (`pdfjs-dist` 4.10.38, `mammoth`
  1.9.0), not `ml_service` or the embedder (decision 1). Paper upload then
  needs neither the 4 GB `automl` profile nor an embedder rebuild (the torch
  trap). The file is read in memory and never stored.
- **Introduction and Discussion are not read when the paper has a methods
  section**, and the card says so. On the first dev run every concept-level
  "variable" ("healthcare access", "socioeconomic disadvantage", matched to
  Toxic Release Inventory facilities) came from those two parts, which
  describe OTHER studies. References and boilerplate are set aside too.
  Over `PAPER_MAX_CHUNKS` (8) the unread sections are named, never cut quietly.
- **Families: the technique's standard name wins** (`familyFromName`, a table
  of the field's own method names: Moran, LISA, Getis-Ord, SaTScan, GWR, ARIMA,
  random forest, VIF ...). Without it, and before the families were described
  in the prompt, qwen3 filed Global Moran's I and Getis-Ord Gi* as
  `spatial_lag` and Pearson correlation as `other`. A name the table does not
  know keeps the model's family. A `preprocessing` family (imputation, scaling,
  VIF) is shown as data preparation rather than "not supported".
- **Quotes**: compared on letters and digits only (line breaks, hyphenation,
  ligatures, curly quotes do not matter); ellipsis fragments must occur in
  order. Variables and places may quote a short table cell or name ("Poverty
  (%)", "Taiwan") but only as a whole phrase of the text; the 16-character
  minimum dropped "Taiwan" and the card read the area as unknown instead of
  outside the US.
- **Matching**: each variable is searched directly (hybrid search, no
  decomposition call), then one judging call per 12 variables chooses a
  candidate, `same` / `proxy` / `none` (reasoning budget of the relevance
  check). Retrieval similarity alone cannot say "not in GeoARK" (CLAUDE.md,
  relevance check). Variables that chose the same row collapse into one, so
  an exposure matched to the outcome's own row folds into the outcome.
- **Templates** (`reproductionPlan`): map, Gi*, Moran global / LISA (the
  paper's alpha and permutations go into the step), correlation (first 3
  partners), regression -> `explain` (exposures as factors, covariates as
  controls, approximated), spatial regression -> `explain` plus LISA of the
  OLS residual, spatial lag -> `neighbors`, outlier, access ->
  `nearest_distance` when a facility layer matched. Group comparison gives an
  editable question for Analysis. Machine learning (all models merged) is
  AutoML with the paper's outcome as target, labelled approximated. Time
  series and anything unknown: not supported, said why. A study outside the
  US runs nothing. **Reproduced only when nothing differs**: a paper at tract
  level, a different period or non-queen weights makes it approximated, and
  the reason names each difference.
- **Cart hand-off capped at 20** (the checkout's `MAX_ITEMS`), outcome first.

**Measured** (`eval/paper_probe.py`, dev tier = the two prototype papers;
gold written by hand from the text before any run was read):

| run | build | quote validity | area | unit | period | variable recall / match | method recall | reproduction | runs executed | s / paper |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 0 | first version, CVD paper only, read by eye | 105/160 | ok | ok | ok | 30 vars, 3 concept vars, outcome x3 | Moran, Gi* filed as spatial_lag | - | - | 287 |
| 1 | fixes above, less the short place quote | 0.90 | 1/2 | 2/2 | 1/2 | 1.00 / 1.00 | 1.00 | 1.00 | 8/8 | 285, 130 |
| 1b | + short place quotes (Taiwan only) | 0.96 | 1/1 | 1/1 | 1/1 | 1.00 / 1.00 | 1.00 | 1.00 | - | 81 |
| 2 | final (api + web rebuilt) | 0.95 | 2/2 | 2/2 | 1/2 | 1.00 / 1.00 | 1.00 | 1.00 | 8/8 | 274, 81 |
| 3 | same | 0.95 | 2/2 | 2/2 | 1/2 | 1.00 / 1.00 | 1.00 | 1.00 | 8/8 | 267, 81 |

Runs 2 and 3 are identical in every count (temperature 0): the repeats show
the result is stable, not that it is right beyond these two papers.

Live through the UI on the CVD paper: card in 258 s; "Add the first 20 of 34
measures" -> checkout 3,233 counties x 20 columns; "Replicate" -> 7 runs in
Analysis, all executed (Moran's I and Gi* over 3,099 counties, three
correlations, outliers, an 8-factor explain).

**What these numbers do not show.** Two papers, both dev, and the gold covers
12 of the CVD paper's 41 variables, so recall 1.00 is not a claim about papers
in general. The CVD period reads 2018-2022 against gold 2018-2021: the
outcome covers 2018-2021 and the covariate table 2018-2022, a defensible
reading. Roles split arbitrarily between exposure and covariate when a paper
lists 40 predictors without singling any out, which changes which ones
`explain` holds fixed. No held-out papers exist yet: U5 asks for 6-8 more with
half held out, and that is the next step before any further tuning.

**Open.**
- Held-out papers (U5) before more prompt or rule changes.
- Latency: 4-5 minutes for a 14-page article, about half extraction (4
  chunks) and half matching (4 judging calls with reasoning). Progress is a
  timer only; streaming the part being read would help.
- Templates run at the county with each measure's latest year. A `year` per
  load chosen from the paper's period, and tract-level templates (no tract
  adjacency yet), are the obvious next steps.
- The paper's reported numbers (Moran's I, coefficients) are not extracted, so
  the side-by-side in the plan's P4 method summary is not built.
- An aborted upload still runs to completion on the server once it has left
  the queue (the queue only skips jobs abandoned while waiting).
