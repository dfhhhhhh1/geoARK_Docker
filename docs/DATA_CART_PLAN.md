# Data cart and paper search: plan (2026-11-20)

Turn **Browse data** (`/data-search`) into a data cart: a question goes through
expanded search, an LLM proposes the measures most worth having, and the user
edits the cart and then downloads it, maps it, or runs AutoML on it. Also port
the parts of `search_and_analysis/` paper search that are not in the backend
yet.

Status: slice 1 (Phases 1, 3, 4) in progress; the rest is plan.

---

## Why this, and what went wrong last time

- **Expansion reaches more data than any answer uses.** Measured 2026-11-20, for
  "coronary heart disease in each county":
  - Literature adds obesity and diabetes. PubMed adds PM2.5, ozone and diesel PM.
  - The analysis maps only CHD prevalence. Its candidates and provenance never
    reach the UI.
  - A cart is the natural place for "data related to X". A map answers one
    question; a cart collects the data for an analysis.
- **The old cart was removed for a reason.** Its checkout opened `/api/download`,
  which never existed, so every cart ended in a 404 (`Header.tsx` comment).
  - **Rule for this plan: no checkout button ships before its endpoint exists
    and has a test.**
- **This project has already measured an LLM selection step losing value.** LLM
  verification of retrieval cost -10pp concept recall while raising MRR: it
  "ranks well and deletes too much".
  - So the curator below has to beat a **no-LLM baseline** on a suite built for
    this purpose before it becomes the default. Otherwise top-k by score is the
    default.

## What exists to build on

| Need | Already there |
|---|---|
| Expanded candidates with provenance | `unifiedSearch` (`expand`, `research`), `search_purpose: "expanded"`, `expansion.concepts`, `research.documents` (PMID, title, url) |
| Executable rows only | `resolveAttributes` / `attribute_source`, one row per feature layer (`/api/measures/search`) |
| Coverage, units | `series_stats.js`, `planner/coverage.js` (median-ratio equivalence test) |
| Levels a measure has | `geo_measure` (county, tract, ZIP, grid, zones) |
| A measure as a plan, no planner | `followup.js` `map_measure`, `add_measure` (compare / correlate, 2 series) |
| Exports with provenance | `frontend/src/lib/exports.ts` (CSV `#` lines, GeoJSON `metadata`, Markdown, bundle) |
| Grounded relevance judging | `relevance` extraction (quote the phrase, a fit, `none` rejects; reasoning budget `off/2048`) |
| AutoML | `backend/ml_service.py` `POST /automl/train` (CSV + target), `automl` compose profile, nginx `/automl/` |
| Multi-layer map | Analysis `LayerStack` / `AddLayerMenu`, `/explore` for any measure at any level |

---

## Phase 1: the shelf (candidates, no LLM)

`POST /api/cart/suggest { q, expand, research }` returns the candidate pool,
grouped and explained.

- **Retrieval:** `unifiedSearch` with the request's expansion settings (the
  Analysis toggle's component, reused).
- **Keep only rows with data:** executable rows; one row per feature layer.
  - Drop identifier and location columns (`state`, `county`, `latitude`, `x`).
    PubMed surfaced all four in the 2026-11-20 run. Reuse the location-column
    list from `levels.asksDistance`; do not start a new list.
- **Group by role:**
  - `subject`: primary sub-queries.
  - `related`: purpose `expanded`.
  - `denominator`: normalization.
  - `context`: everything else.
- **Each row carries:**
  - Coverage: units with data, and its levels from `geo_measure`.
  - Latest year and units.
  - **Why it is here:** "Heart disease → Obesity, 180 papers (SemMedDB 43)", or
    "PubMed keyword *air pollution*: PMID 1, 2, 3". Already returned; just
    carried through.
- **Near-duplicates are collapsed, not hidden.**
  - Example: crude vs age-adjusted, and the same measure from ERS, CHR and PLACES.
  - Show one row with "+2 equivalent", grouped by the `coverage.js` equivalence
    test (same class, median ratio 0.9–1.1). There are 42 unemployment-like rows;
    a cart of three copies of one measure is the likely failure.

**Done when:**
- The shelf returns in under 3 s without research.
- Every row resolves.
- The same question with expansion off returns a subset.

## Phase 2: the intelligent cart (LLM curation, measured)

One schema-constrained call over the shelf (≤ 40 rows). For each row the model
returns:
- `{ id, role, phrase, fit, reason }`.
- `phrase`: the question phrase, or the linked concept, that the row measures.
- `fit`: one of `direct | proxy | related | none`.

It then proposes a default cart of at most 8 rows.

- **Grounded by construction:**
  - `id` is an enum of the shelf's ids, so nothing invented can be emitted.
  - The same rule as the relevance check applies: `none` rejects only when no
    content word is shared (`relevance.overrules`).
- **Code rules after the model.** The model does not decide these:
  - The subject is always in the cart.
  - At most 2 rows per linked concept.
  - One row per equivalence group, choosing the best coverage.
  - A denominator is added when the subject is a count.
- **"Add more" is two paths:**
  - Typed search reuses `/api/measures/search`.
  - Free-text "also income and rurality" is a second curator call scoped to new
    retrieval. Edits never re-plan the whole cart.
- Reasoning `off/2048`, the measured budget for judging calls. No new model;
  qwen3:14b is resident (VRAM trap).

**Measure before it is the default.** `eval/cart.yaml` + `eval/cart_probe.py`:
- **Questions:**
  - Condition questions from `expansion.yaml`, held-out ones kept separate.
  - Non-health questions, where expansion fired falsely ("heating costs").
  - Two unanswerable questions (rainfall). Their correct cart is empty, with a note.
- **Gold:**
  - `must` (the subject).
  - `should` (linked measures, as regexes in `expansion.yaml`).
  - `must_not` (identifiers, unrelated layers).
- **Metrics:**
  - Subject recall.
  - Related recall in cart.
  - Precision: share of the cart matching `must` or `should`.
  - Duplicate rate.
  - Mean coverage.
- **Arms:**
  - Expansion: off / literature / pubmed / both.
  - Selection: curator / top-8 by score.
  - 3 repeats each.
- **The curator ships as default only if:**
  - It beats top-8 on precision, AND
  - It costs no subject recall.

## Phase 3: Browse data becomes the cart page

- **Layout:**
  - Search box with the Expanded search control.
  - The shelf grouped by role, each row with its "why" and paper links.
  - The cart beside it: proposed rows pre-checked and marked "suggested", with
    add / remove / reason.
- **Cart state:**
  - Ids plus labels in `localStorage` (try/catch, as the toggle does).
  - Shareable as `/data-search?cart=id1,id2&level=county`, so a cart is a link,
    not server state.
- **Level picker:** offers only levels that every cart item has (`geo_measure`).
  Mixed items get "county (3 items are tract-only: roll up?)" using
  `aggregate_to`, and the roll-up is labelled as an estimate, as `/explore` does.
- Replaces `MainGeospatialPage` in `App.tsx` (the last caller of the old
  `/api/unified-search` UI path).

## Phase 4: checkout (the endpoint the old cart never had)

`POST /api/cart/table { items, level, states? }` returns one wide table:
- `geoid, name, state`, then one column per item.
- **Values:** each value item compiles through the same `load` path as
  `map_measure`. All items run in one READ ONLY transaction (same snapshot,
  same as multi-output plans).
- **Feature layers:** count per unit (`count_features`). Raw features are also
  available as their own GeoJSON (`select_features`).
- **Rasters:** the cached unit histograms (`raster_unit_count`).
- **LEFT JOIN onto the unit list, never an inner join of items.** An inner join
  silently deletes every county one item lacks: the `S0102` 1,524-county lesson
  and the ON-vs-WHERE lesson again. Missing stays NULL and is counted in the
  dictionary.
- **Limits:** ≤ 25 items, so that a national tract table (85k rows × 25) stays
  in tens of MB.
- **Downloads:**
  - CSV with `#` provenance lines.
  - GeoJSON (display-tier geometry).
  - A data dictionary (Markdown/JSON), with one entry per column:
    - Dataset, code, vintage, units, coverage.
    - Whether the value is an estimate.
    - Why it is in the cart, including PMIDs.
  - A zip of all three.
- **Tests:**
  - Three columns equal a hand-written SQL value for the same units.
  - Row count = units in the level.
  - Nulls preserved.
  - A user-uploaded layer id is refused (uploads are never stored and are not
    cart items).

## Phase 5: map the cart

- **"Map in Analysis":**
  - Opens `/analysis` with the first item via `map_measure`, and the rest in the
    layer stack (the `AddLayerMenu` path).
  - Two selected items get "compare / correlate" (`add_measure`), including its
    existing PLACES ~ PLACES inflation warning.
- **"Open in Explore":** for one item at any level.

## Phase 6: AutoML on the cart

The service today (`backend/ml_service.py`) trains AutoGluon on an uploaded
CSV with an "80/20 chronological" split: the first 80% of rows train, the last
20% test. Our rows are counties in FIPS order, so that "chronological" split
is really an accidental split by state, and nobody chose it. FIPS, name and
state also go in as features.

**Options:**

| | What | Honest about skill? | Cost |
|---|---|---|---|
| A | As is | No: FIPS and neighbours leak location into the test set | none |
| B | **AutoGluon with spatial CV (recommended)** | Yes | small: change the split, drop ids |
| C | No AutoML; use `explain` / `residual` only | Yes, and interpretable | none, but no non-linear models |
| D | B plus spatial-lag features (neighbour means from `county_neighbors`) | Yes | moderate; later |

**B, chosen 2026-11-20. Concretely:**
- **Drop identifiers:** `geoid / name / state` are dropped from the features.
- **Spatial cross-validation:** folds are grouped by state (GroupKFold, 5
  folds), so a test county never has its neighbours in training. County data
  has Moran's I ≈ 0.6, so a random split would report neighbour copying as
  skill.
- **Residual check:** Moran's I of the out-of-fold residuals is reported. If
  it is high, the model missed spatial structure.
- **Wording:** feature importance is labelled "association in this data, not
  a cause". A flag is shown when target and features are all PLACES estimates
  (shared model covariates inflate them).
- **Explain alongside:** the `explain` op's partial Spearman for the same
  target is shown next to it as the interpretable companion; the two should
  broadly agree.

**Shared with every option:**
- The cart table goes to the service server-side, with the target defaulting to
  the subject.
- The `automl` profile needs a time cap and a memory cap. 8 GB of Docker RAM
  already OOM-killed a model runner once.

---

## Paper upload: pull a paper's data and methods

**Corrected scope (2026-11-20):** showing PubMed titles and abstracts is NOT
wanted. The feature is: upload a paper, and GeoARK gives back both

1. **a cart** of the catalog data matching the paper's variables, downloadable
   like any cart, and
2. **a reproduction attempt**: the paper's spatial analysis run as ordinary
   GeoARK plans, each method marked reproduced / approximated / not supported.

What the prototype has: `analysis/recommendML` (`extract_text1.py`
markitdown, `llm2.extract_workflow`, a methodology schema with technique /
purpose / evidence / status per step) and `search/context` (keywords from an
uploaded file). None of it is ported. Its runners (`run_ML3`,
`geospatial_analysis.py`) execute methods on a local CSV. They are not ported
either: GeoARK's ops already compute Gi*, Moran's I, regression residuals and
partial correlations, verified against independent implementations.

### U1. Text, locally

- **Endpoint:** `POST /extract` on the embedder (Python), using markitdown with
  a pypdf fallback. The file is never stored, as with user CSVs.
- **Sections:** the methods and data sections are located by heading.
  - qwen3 runs at `num_ctx` 8,192 and overflow silently discards the system
    prompt (traps table), so the text is chunked, never truncated blindly.
- **No egress:** nothing leaves the machine.

### U2. One extraction call, grounded

A schema-constrained call (reasoning `off/2048`, resident qwen3:14b; the
prototype's qwen3:1.7b would be a third resident model on a card that stalls
with two). It extracts:

- **Study design:**
  - `study_area` (places, matched to `states.js` / `place_geom`).
  - `unit` (county / tract / ZIP).
  - `period` (years).
- **Variables:** `outcome`, `exposures[]` and `covariates[]`, each with the
  **quoted sentence** it came from and the paper's own data source if named.
- **Methods:** `methods[]`, each one:
  - A technique, a quote, and a `geoark_op`.
  - `geoark_op` comes from an enum: `hotspot | outlier | correlate | explain |
    residual | neighbors | compare_groups | access | automl | none`.

A method with no quote is dropped. Code, not the model, checks that each quote
occurs in the text.

### U3. Paper → cart

- Each variable phrase is a sub-query of the Phase 1 shelf. The best row per
  variable is pre-selected.
- Variables nothing resolves to are listed as **not in the catalog**, the
  named-data check's NOT_COVERED idea. That list is as useful as the cart: it
  is what the user still has to bring.
- The level and area default to the paper's, and are downloaded through Phase 4.

### U4. Paper → reproduction

- **Plans from templates, not free planning.** Each `geoark_op` has a template
  over the cart's ids:
  - `hotspot`: `load(outcome) -> filter_area -> hotspot`.
  - Regression: `explain` with the paper's covariates as factors (`add_factor`),
    or `residual`.
  - Correlation: `correlate`.
- **Execution:** each plan goes through `validatePlan` and runs as a step of a
  research workflow (`/api/research`, ≤ 4 steps).
- **Every method gets a status:**
  - *Reproduced*: same method.
  - *Approximated*: for example GWR → OLS residual, or a paper's own survey
    data → the closest PLACES measure. The reason is stated.
  - *Not supported*.
- **Later:** extract the paper's reported effect sizes and show them next to
  GeoARK's.

### U5. Measure it

- **Papers:** the prototype's two sample PDFs (`analysis/context_files/`) plus
  6–8 more spatial-epidemiology papers. Gold variables, methods and study area
  are written by hand. Half are held out.
- **Metrics:**
  - Variable recall (gold variable → a cart row, or correctly listed as
    missing).
  - Method mapping accuracy.
  - Quote validity.
  - Share of methods reproduced or approximated.
- **Repeats:** 3 runs, at the temperature the traps table records.

---

## Guards (every phase)

- `snapshot_prompt.js` byte-identical. Nothing here changes the planner prompt.
- `known_item.yaml`, `queries.yaml`, `expansion.yaml` unchanged. The shelf uses
  the same retrieval.
- `npm run build` in `frontend/` (the type check that matters).
- Browser check of the cart page at desktop and phone width.

## Server

- SemMedDB index dump restored (`docs/RUNBOOK.md` "Literature and research
  expansion on the server").
- Outbound access to NCBI for PubMed.
- `--profile automl` for Phase 6.
- The embedder rebuild for U1 needs torch pinned first. A rebuild upgraded torch
  on 2026-10-30.

## Order

1. **Slice 1:** Phases 1 + 4 + 3. A working, downloadable cart with no LLM
   picking. **Built 2026-11-20, see "Progress".**
2. **Mapping:** Phase 5. **Built 2026-11-20** (Map in Analysis; Open in
   Explore not yet).
3. **Curator:** Phase 2, with `cart.yaml`; the default only if it wins.
4. **Paper upload:** U1-U3, a cart from a paper.
5. **Reproduction:** U4, then U5.
6. **AutoML:** Phase 6, option B. **Chosen and built 2026-11-20**, ahead of
   3-5 because it reuses the checkout and nothing else.

## Progress

### Slice 1 built (2026-11-20)

**Code:**
- `backend/cart.js` (shelf, default cart, checkout plan, wide table) with
  `backend/test_cart.js` (11 tests, in `npm test`).
- `POST /api/cart/suggest` and `POST /api/cart/table` in
  `unified_search_server.js`.
- `frontend/src/components/DataCartPage.tsx` and `frontend/src/lib/cart.ts`.
- The Expanded search switch is now one component and one setting
  (`ExpandedSearchControl`, `useExpandedSearch`), shared with Analysis.
- The nav label is "Data cart"; the old catalog-search page is gone from
  `App.tsx`.

**Guards:**
- `npm test` passes.
- `snapshot_prompt.js` identical across 48 contexts.
- `npm run build` passes.

**Checked live:**
- **Shelf, "coronary heart disease in each county" with Literature + PubMed:**
  14 items, 17 s (PubMed is most of it).
  - Crude and age-adjusted CHD are grouped as one item with "1 other version".
  - The suggested cart has 7 items: CHD, adult obesity, diabetes, cardiology
    MDs, two PM2.5 measures, child mortality.
- **Checkout, Missouri:** 115 counties × 7 columns in about 0.1 s.
  - `PLACES_CHD_CrdPrv` reads 6.1 for Adair (29001) and St. Louis city
    (29510), equal to `acs_county_values` 2023.
  - Missing cells stay empty and are counted (child mortality: 48 of 115).
- **Downloads:** the CSV, GeoJSON (115 features) and dictionary were generated
  in the browser, each carrying provenance.
- **Phone width:** the cart page fits at 375 px. The shared site header does
  not: Survey and Readable push it to 459 px, on every page.

**Seen in that run, for the next phases:**
- **Same measure from two sources.** CHR "Air pollution - particulate matter"
  and AHRF PM2.5 hold identical values (7.4, 7.7 in Missouri). Label grouping
  cannot see this. The data-based equivalence test from Phase 1 (median ratio
  on shared counties, `coverage.js`) is the fix, not a word list.
- **Weak links reach the default cart.** "mortality", a PubMed keyword, put
  Child mortality in it. This is exactly what the Phase 2 curator is for, and
  `cart.yaml` should hold such a case.
- **No population denominator in the default cart.** The "population"
  sub-query returned only feature layers (Child Care Centers, Hospitals), and
  the default now refuses a layer as a denominator. Retrieval for denominators
  could use `population.js`'s total-population rule.
- **"Add more" works by searching again.** The cart persists across searches
  and reloads, but there is no free-text "also add income" yet.

**Not built in slice 1:**
- Levels below the county.
- Rasters in the table (offered as "Map only").
- A zip of all three downloads.
- Mapping (Phase 5) and AutoML (Phase 6) buttons. These are deliberately absent
  until they work end to end.

### Phases 5 and 6 built (2026-11-20)

**Code:**
- **Map in Analysis** (`DataCartPage` -> router state -> `AnalysisPage`,
  `useConversation.openMeasure`). The first by-county item becomes the answer,
  each other item a layer in its stack; every one is a `map_measure` edit, plus
  `restrict_area` when the cart has an area. No planner call.
- **`POST /api/cart/model {items, states?, target, split?}`** builds the same
  table as the checkout (`buildCartTable`, shared), sends values and ids
  SEPARATELY to `ml_service.py` `POST /automl/cv`, then computes Moran's I of
  the out-of-fold residuals and the companion (`cart.partialCompanion`,
  explain's own `compute()`).
- **Folds** (`_fold_groups`): 5 folds of whole states, balanced by size; with
  fewer than 5 states, contiguous blocks (k-means on county centroids, ~n/10
  blocks). `split: "random"` is the comparison arm only. AutoGluon
  `medium_quality`, 25 s per fold (`AUTOML_FOLD_SECONDS`), no neural nets,
  permutation importance on each held-out fold, averaged. One training at a
  time (429 otherwise).
- **Compose:** `automl` gets `mem_limit: 6g` (`AUTOML_MEM_LIMIT`).
  `/automl/train` (the CSV tools page) is unchanged.
- **Tests:** `backend/test_ml_cv.py` (fold assignment, in the image) and a
  12th `test_cart.js` case (a duplicated column).

**Checked live, the default CHD cart (CHD target, 6 features):**

| | national, by state | national, random | Missouri, by block |
|---|--:|--:|--:|
| counties | 2,945 | 2,945 | 115 |
| out-of-fold R² | **0.37** | 0.43 | 0.21 |
| RMSE (guess-the-mean) | 1.19 (1.49) | 1.12 (1.49) | 1.28 (1.44) |
| residual Moran's I (target) | 0.42 (0.45) | 0.36 | 0.24 (0.35) |
| wall time | 18 s | 17 s | 9 s |

- **The random split overstates skill by 0.06 R²** on this cart, which is the
  measurement option B was chosen for. Option A's split would have been worse
  still (FIPS as a feature).
- **The model leaves most of the spatial structure**: residual I 0.42 against
  0.45 for CHD itself. The panel says so ("something regional is missing").
- **Importance and the partial rho agree on order**: child mortality (0.26;
  partial +0.34) and cardiology MDs per capita (0.15; partial -0.33) lead;
  diabetes and obesity are small once the others are held fixed (+0.06,
  +0.11). Associations, not causes; child mortality is the weak PubMed link
  noted above, standing in for general county health.
- **Wall time is far under the cap**: ~3,000 rows x 6 columns trains each fold
  in ~3 s, so "2-3 min" on the button is conservative.

**Defect found on the first live run, fixed:** the two PM2.5 columns are the
same values, which made the companion's controls singular, so EVERY feature
read `controls_collinear` and nothing got a partial rho. `partialCompanion`
now sets aside any column with |rho| >= 0.97 to an earlier one and reports it
as "same measure as ...". AutoGluon had already dropped the copy (no
importance). Same lesson as the slice 1 finding: two sources of one estimate
need a data test.

**Not built:** Open in Explore; spatial-lag features (option D); a target
that is a feature-layer count (offered targets are by-county values only);
model download.
