# Data carpentry log

What was done to each dataset between the download and `make ingest`: which
file was chosen, what was reshaped, renamed, dropped and why, and what did not
match. `etl/data_manifest.yaml` (the ledger) records *what loaded*, with file
hashes; this file records *why it looks the way it does*. Each entry names the
script that reproduces the prepared file, and **every prep script was re-run
and checked to reproduce its loaded CSV byte for byte (2026-11-12)**. That
matters: `make replay` on the server refuses a file whose sha256 differs from
the ledger, so the server needs the prepared folders, not the raw downloads.

Format for a new entry: source file(s) and release, steps, columns kept and
dropped (and why), match rate against the geography already loaded, caveats,
numbers worth re-checking. Add it in the same session as the load.

## Conventions every entry follows

- **Raw downloads are never edited.** A script in `etl/prep_*.py` reads them
  and writes `deploy/incoming/<id>/<id>.csv` plus `<id>.meta.yaml`.
- **Codes are padded to full width** (5 digits county, 11 tract, 12 block
  group). Federal files often store them as numbers and lose the leading zero;
  one file here (the Food Access general table) did it for only some states.
- **Wide files are cut to a curated column list**, under the loader's 60
  measure cap. Every measure becomes a search entry and corpus size is what
  limits retrieval quality (CLAUDE.md). Left out on purpose everywhere:
  standard errors and counts when a rate is given, race-by-sex cuts, and
  anything that would compete with an existing series (total population,
  population density).
- **A code that matches no geometry is skipped, and the count is recorded.**
  Two causes recur: a newer county vintage than `county_geom` (Connecticut
  planning regions `091xx`, Alaska `02063` / `02066`), and 2010-boundary
  tracts and block groups that were redrawn for 2020.
- **Tagging is part of `make ingest` and runs per dataset, locally.** Tract and
  block-group measures get no catalog rows, so nothing is tagged for them (see
  "Open: tract-only measures" below).
- Unit labels were checked against the data's min / mean / max where the prep
  script prints them. Labels not verifiable that way are listed under
  "Unverified".

---

## County datasets

### FEMA National Risk Index (`nri_county`, id `nri`)
- **Source:** `National_Risk_Index_Counties_*.csv`, December 2025 metadata
  (hazards.fema.gov). 3,232 rows x 467 columns.
- **Prep:** none beyond copying the CSV into `nri_county/`; the cut is done by
  the sidecar's `include:` list (no script).
- **Kept (44 measures):** composite risk score and value, expected annual loss
  total and score, social vulnerability score, community resilience score,
  community risk factor, and for each of 18 hazards the expected annual loss
  total and the hazard-type risk index score.
- **Dropped:** population, building value, agriculture value (a "resident
  population" series would compete with total population: CLAUDE.md records
  CENSUS_POP breaking two questions that way); per-hazard annualized
  frequency (18) and the composite loss-rate variants, to stay under the cap;
  all text rating columns.
- **Match:** 3,221 of 3,232; 11 skipped (CT planning regions, AK 02063 / 02066).
- **Catalog:** 39 rows. 5 measures cover under 500 counties and are loaded
  without catalog rows: coastal flooding risk score (490), tsunami loss and
  score (118, 64), volcanic activity loss and score (358, 305).
- Scores average ~50 (they are national percentile-like scores).

### Opportunity Atlas, four folders (`oi_mobility_county|tract`, `oi_neighborhood_county|tract`)
- **Source:** Opportunity Insights `county_outcomes_simple.csv`,
  `tract_outcomes_simple.csv`, `cty_covariates.csv`, `tract_covariates.csv`.
- **Script:** `etl/prep_opportunity_atlas.py` (data),
  `etl/prep_opportunity_atlas_sidecars.py` (sidecars).
- **Prep:** the files carry `state`, `county` and `tract` as separate unpadded
  integers, so a GEOID is built (5-digit county, 11-digit tract). Four prepared
  folders: outcomes and neighbourhood covariates, each at county and tract.
- **Kept:** outcomes: the household income rank (`kfr`) and incarceration rate
  (`jail`) for children whose parents were at the 25th percentile, for all
  children, Black, Hispanic, White, daughters and sons (12 measures).
  Neighbourhood: 29 covariates (31 at tract, which adds jobs within 5 miles).
- **Dropped:** every `_se` and `_count` column; race-by-sex cuts (mostly empty
  at tract level); Asian and other groups; `popdensity2000/2010`
  (competes with population density).
- **Match:** county outcomes 3,219 of 3,219; county covariates 3,220 of 3,221
  (`02270`, an old Alaska code, skipped); tract outcomes 60,963 of 73,278;
  tract covariates 61,749 of 74,123. The tract misses are **2010 tract
  boundaries** against 2020 geometry.
- **Caveat:** published jail rates include small negative values (min about
  -0.075); that is estimation noise in the source, not a load error. Left as
  published.
- **Sidecars share one description set**, so the county and tract entries read
  identically.

### AHRF 2024-2025 (`ahrf_workforce`, `ahrf_facilities`, `ahrf_population_health`)
- **Source:** HRSA Area Health Resources File 2024-2025, themed county CSVs
  (`hp`, `hf`, `utl`, `exp`, `pop`, `env`) and the Technical Documentation
  workbook for field labels.
- **Script:** `etl/prep_ahrf.py [--sidecars]`.
- **Prep:** AHRF has one row per county and one column per variable and year
  (`hosp_23`, `hosp_22`). The loader keys values by a per-row year, so the chosen
  variables are **reshaped to one row per (county, year)**, year taken from the
  column suffix. Non-numeric cells are ignored.
- **Kept:** 38 workforce measures (M.D.s by 24 specialties, primary care
  physicians, NP, PA, APRN, CRNA, nurse midwives, chiropractors, optometrists,
  podiatrists, dentists); 35 facility and utilization measures (hospitals,
  beds, ICU and obstetric services, clinics, health centers, ED visits,
  inpatient days, Medicare cost); 24 Medicare / births / deaths / air quality
  measures. All descriptions are hand-written from AHRF's abbreviated labels.
- **Dropped:** population estimates and density (ACS has them); race and sex
  cuts; the other ~2,300 variables.
- **Years:** workforce spans 2022-2024 and facilities 2022-2025 in this
  release, so these are not long trends. Population-side variables reach 2010.
- **Match:** 3,223-3,224 of 3,234-3,235 counties; 11 newer-vintage codes
  skipped.
- **Not in this release:** health professional shortage area (HPSA) counts.
- **Catalog:** 96 rows; 1 measure covers under 500 counties and has none.
- **Retrieval note:** "number of cardiologists by county" ranks the cardiology
  measure 8th (ERS counts rank above it); "cardiology physicians" ranks it 1st.

### NOAA nClimDiv county climate (`noaa_climdiv_county`, id `noaa_climdiv`)
- **Source:** nClimDiv county files, release 2026-11-05: monthly precipitation,
  average / maximum / minimum temperature, heating and cooling degree days, and
  Palmer Drought Severity Index (`climdiv-*cy-v1.0.0-20261105`, fixed-width
  text) plus `county-readme.txt` for the layout.
- **Script:** `etl/prep_climdiv_overdose.py climdiv`.
- **Prep:** one row per (county, element, year) holds 12 monthly values; they
  become one annual value per county and year (precipitation and degree days
  summed, temperatures and PDSI averaged). A year with any missing month is
  dropped (so the partial 2026 is absent; data run 1895-2025). **The first two
  characters of each record are NOAA's own state code, not FIPS** (01 Alabama,
  02 Arizona ... 49 Hawaii, 50 Alaska), so they are mapped by state; using them
  as FIPS would put Arizona's data on Alabama-adjacent counties.
- **Kept (11):** 7 annual series and four 1991-2020 normals (precipitation,
  temperature, heating and cooling degree days), computed here from the annual
  values and written on the 2020 row, only where all 30 years exist.
- **Not used:** the `climdiv-norm-*` normals files. Their layout (12 rows per
  county, apparently one per normals period) is not described in what was
  downloaded (the normals readme is missing), so which row is 1991-2020 would
  have been a guess. Station inventories, division and state files, SPI and the
  other drought indexes were not downloaded or used.
- **Match:** 3,139 of 3,142 counties. Skipped: `02063`, `02066` (newer Alaska
  vintage) and `24511` (probably the District of Columbia filed under
  Maryland; not mapped, so DC has no climate data).
- **Checked:** driest 30-year normals are Imperial CA (3.2 in) and Yuma AZ
  (4.6); wettest Yakutat AK (197 in). Alaska and Hawaii are included.
- **Rows:** 410,222 county-years; 2.87 million values.
- **Finding, snowfall:** "Which counties get the most snow each year?" is now
  *answered* with total annual precipitation (2 of 2 runs), where it used to be
  refused. The measure text says it is not snowfall; the planner and relevance
  check still accept it as a stand-in. Not tuned (that needs the answerability
  and research suites). See "Suites that now read differently".

### CDC provisional county overdose deaths (`cdc_overdose_county`, id `cdc_overdose`)
- **Source:** NCHS VSRR provisional county-level drug overdose death counts,
  data as of 2026-10-04. 235,800 rows, one per county and month, 12-month-ending
  counts.
- **Script:** `etl/prep_climdiv_overdose.py overdose`.
- **Prep:** only the December rows are kept (the 12 months ending December are
  the calendar-year count; 2026 is partial). **Counts carry thousands commas
  ("1,308")**, which a numeric loader skips silently; they are stripped. FIPS
  padded to 5 digits. **Two Virginia pairs share a FIPS code** (Alleghany with
  the former Clifton Forge city, Bedford with Bedford city), which crashed the
  load with a duplicate-key error; 12 such county-years are combined: summed when
  both are published, blank when either is suppressed.
- **Kept (2):** the count and the percent of records pending investigation.
- **Coverage:** counts of 1-9 are suppressed by NCHS, so only about 1,500-1,750
  of 3,142 counties have a value each year (2020: 1,638; 2025: 1,518). A ranking
  covers larger counties only; the sidecar says so. Counts, not rates.
- **Match:** 3,142 of 3,142.

### Supplementary File A sources, county tables (2026-11-20)

Four tabular sources listed in the GeoARK paper's Supplementary File A whose
catalog rows had **no data behind them** (the `ACS_combined` groups
`a781336d_02_01` Food Environment Atlas, `a781336d_03_01` Rural Atlas,
`ddbfd2c3_01_01` heart disease atlas; USAFacts COVID had no rows at all). Loaded
as new datasets from current releases. The old unresolved rows were **left in
the catalog** (see "Open" below).

#### USDA ERS Food Environment Atlas (`ers_fea`, id `ers_fea`)
- **Source:** July 2025 release, `food-environment-atlas-csv-files.zip`
  (`StateAndCountyData.csv`, long: FIPS, Variable_Code, Value; `VariableList.csv`).
- **Script:** `etl/prep_ers_atlases.py fea`.
- **Prep:** codes carry a 2-digit year suffix (`LACCESS_POP15`, `LACCESS_POP19`);
  when it matches the label's year it is stripped, so the years become a YEAR
  column under one measure. `-8888` (county did not exist) and `-9999` / `N/A`
  are missing.
- **Dropped (125 of 304):** 48 state-level variables (label ends in `*`: one
  state value repeated over every county would rank as county variation); 60
  change variables (`PCH_`, `CH_`, "% change", "percentage points": `combine`
  computes change from the two years, and `PCH_FDPIR_12_15` is labelled `Count`
  in ERS's own list); 17 of the 18 "Socioeconomic Characteristics" (SAIPE poverty, median
  income, race shares, already loaded under USDA ERS / ACS). **`PERPOV17_21`
  (persistent-poverty counties) is kept as `PERPOV`**: nothing else carries it.
  The first load dropped it with the rest; re-ingested with `--replace` the same day.
- **Kept (103 measures):** access, store and restaurant availability, food
  assistance (county-level), local foods, recreation facilities.
- **Match:** 3,142 of 3,156; the 14 skipped are CT planning regions, the
  Valdez-Cordova split and three retired Alaska codes.
- **Checked:** Taney MO fast-food restaurants per 1,000 (2020) = 1.0694 in the
  raw file and in the answer to "Which Missouri counties have the most fast-food
  restaurants per 1,000 people?" (plan `load ERS_FEA_FFRPTH -> filter_area ->
  rank`).

#### USDA ERS Atlas of Rural and Small-Town America (`ers_rural_atlas`)
- **Source:** 2024 release, `download-the-data-in-csv.zip` (People, Jobs,
  Income, Veterans, CountyClassifications; long, plus `VariableNameLookup.csv`).
- **Script:** `etl/prep_ers_atlases.py rural`.
- **Encoding:** the files are cp1252 ("Doña Ana"), decided over the whole file.
- **Dropped (157 of 249):** 138 that duplicate the USDA ERS county files already
  loaded (population estimates, labor force / employment / unemployment, SAIPE
  poverty and income, educational attainment, metro / RUCC / UIC codes, migration
  and natural change); 19 People counts whose percent is kept. Near-duplicates
  under a second name are the measured retrieval risk (42 unemployment-ish rows
  before this).
- **Kept (92):** race / ethnicity, age, foreign born by region, households, home
  ownership, population change by group, employment by industry, deep poverty,
  per capita income, veterans (share, disability, poverty, era, income), and the
  ERS county typologies (2015 edition and the 2000/2003 ones, natural amenities,
  oil and gas change classes). Five "Percent employment change" codes keep their
  period in the description, or they read identically.
- **Units are partly inferred from the code name** (`units_for`); the oil and gas
  `*_Change` columns are class codes (0 / 2 / 9), not dollars; checked on values.
- **Match:** 3,220 of 3,226.
- **Checked:** "Which counties are retirement destinations?" -> `load
  Retirement_Destination_2015_Update`; "percent of veterans with a disability by
  county in Texas" -> `PctVetsDisabilty`, 251 counties.

#### USAFacts COVID-19 cases and deaths (`usafacts_covid`)
- **Source:** `covid_confirmed_usafacts.csv`, `covid_deaths_usafacts.csv`,
  cumulative daily counts 2020-01-22 to 2023-07-23 (reporting ended).
- **Script:** `etl/prep_usafacts_covid.py`.
- **Prep:** ~575 daily columns per file reduced to 4 measures by YEAR:
  cumulative on 31 Dec (23 Jul for 2023) and new in the calendar year (2020-2022;
  2023 is half a year and gets no annual value). Statewide-unallocated rows
  dropped. 55 negative annual changes (corrections) blanked.
- **Match:** 3,142 of 3,142. Los Angeles cumulative deaths 36,317.
- **Licence:** CC BY-SA 4.0 (USAFacts), not public domain.

#### CDC heart disease and stroke mortality (`cdc_heart_stroke`)
- **Source:** data.cdc.gov `mri7-5jtw` (heart) and `y5ii-knwc` (stroke), adults
  35+, 2022-2024, age-adjusted, spatially smoothed 3-year rates per 100,000 (the
  data behind the Interactive Atlas of Heart Disease and Stroke).
- **Script:** `etl/prep_cdc_heart_stroke.py`.
- **Prep:** CDC's `Year` 2023 is the middle year; dated **2024**, the end of the
  window. Kept overall, by sex, and by race/ethnicity (both sexes): 10 per topic.
  Sex x race cells dropped.
- **Catalog:** 16 of 20; 4 cover under 500 counties (loaded, not catalogued).
- **Checked:** "Which Georgia counties have the highest stroke death rates among
  Black adults?" -> `CDC_HEART_STROKE_STROKE_DEATH_RATE_BLACK`, Miller 221.7.

#### Guards after the four loads
- `known_item.yaml`: **91.7% recall@1, MRR 0.944**, unmoved (0.958 after `PERPOV`
  was added, below).
- `queries.yaml` (search endpoint): single_concept, facilities_via_tags,
  geographic_level, temporal 100%; multi_concept 87.5 / 75%, paraphrase 80 / 80%
  (misses: `unemployment-and-snap`, `race-and-poverty`, `jobless`). **No new
  row appears in the top 20 of any missed query**, so these are not
  displacement by this load; the 97.8% baseline predates several other loads.
  Run in per-suite batches: the full suite now trips the API's search rate
  limiter (30 burst, 60/min) and reports 24 "request errors" (HTTP 429).

#### Removing the replaced no-data rows: tried, reverted (2026-11-20)
The 541 unresolved `ACS_combined` rows these loads replace (`a781336d_02_01`
FEA 280, `a781336d_03_01` Rural Atlas 235, `ddbfd2c3_01_01` heart atlas 26)
were removed, re-embedded and measured, then **restored**:

| | before | removed | restored + `PERPOV` |
|---|--:|--:|--:|
| known_item recall@1 / MRR | 91.7% / 0.944 | **66.7% / 0.667** | 91.7% / **0.958** |
| multi_concept recall / success | 87.5 / 75% | 93.8 / 87.5% | 87.5 / 75% |
| temporal (queries.yaml) | 100% | **refuses to run** | 100% |

**The suites are anchored on rows with no data.** The four known-item misses
(`ki-gini`, `ki-persistent-poverty`, `ki-child-poverty-2015`,
`ki-median-income-2017`) match only removed rows, and two temporal assertions
(`unemployment-2017`, `income-2013-2017`) become unsatisfiable. The other 8
known items kept rank 1. So part of what these suites measure is how well
retrieval finds catalog rows that no plan can use. Removing the rows needs the
gold changed first, which is a decision, not a cleanup:
- `ki-persistent-poverty` is now satisfiable by real data (`ERS_FEA_PERPOV`,
  which also lifted MRR to 0.958);
- child poverty 2015 and median income 2017 exist in no loaded year (ERS SAIPE
  `PCTPOV017` / `MEDHHINC` are loaded for 2023 only); Gini has no loaded measure.
Backup of the removed state's input: `etl/_backups/geoark_attributes.csv.bak-20261120-180341-pre-supfileA-cleanup`.
**Do not restore it**: it predates the feature-layer loads and the HSIP cleanup.

#### Removed for good, after retargeting the gold (2026-11-20, later)
The gold was changed first, then the 541 rows removed (catalog 7,266 -> 6,725,
corpus key `94f4d4bf82e9e811`; backup
`etl/_backups/geoark_attributes.csv.bak-*-pre-ers-replaced-cleanup`).

- `ki-persistent-poverty` -> `ERS_FEA_PERPOV`.
- `ki-child-poverty-2015` -> `ki-child-poverty` ("child poverty rate", SAIPE
  `PCTPOV017`) and `ki-median-income-2017` -> `ki-median-income-saipe` (SAIPE
  `MEDHHINC`). The years are gone because no loaded series has them.
- `ki-gini` -> `ab-gini` in the `absent` suite: no Gini is loaded. Its top hit
  is now CHR "Income inequality" (`CHR_V044`, the 80/20 income ratio) at 0.67,
  a fair proxy, so this item sits at the top of the absent range by design.
- temporal `unemployment-2017` now asserts `covers: "2017"`, a new `run.py`
  predicate (the row's start..end contains the period). It is needed because
  the year became a column: `UNEMPLOYMENT_RATE` is one row spanning 2000-2023.
  `income-2013-2017` is deleted: no loaded income measure covers that period.

Same build, same retargeted gold, before and after removal (known_item with the
HSIP retargeting the other session already made, 11 attribute items):

| | rows kept | rows removed |
|---|--:|--:|
| known_item recall@1 / MRR | 72.7% / 0.826 | **90.9% / 0.917** |
| multi_concept recall / success | 87.5 / 75% | **93.8 / 87.5%** |
| paraphrase, single_concept, facilities_via_tags, geographic_level, temporal | 80 / 100 / 100 / 100 / 100% | unchanged |

Removing them helped: the no-data rows were outranking the loaded measures
(persistent and child poverty both went from rank 2 to rank 1). The one
known-item miss left is `ki-energy-generation` (@12, an HSIP target from the
feature-layer session). The remaining misses (`unemployment-and-snap`,
`jobless`) predate this work. Results: `eval/supa/retarget_*_known.json`.
These numbers are **not comparable** to the 91.7% / 0.958 recorded above,
because the gold changed.

#### Open
- The replaced rows are removed (above). 113 Harvard hospital capacity and 59
  smoking rows with no replacement are still in the catalog with no data.
- "Which counties had the most COVID-19 deaths per person?" planned over the
  older `AHRF_POPULATION_HEAL_COVID_DETH` / CHR population and returned 0.85 for
  Mississippi County AR, whose stored values are 57 deaths and 38,663 people.
  Not caused by this load; not investigated.

#### Supplementary File A: what is still not loaded (checked 2026-11-20)
Against `attribute_source` (a dataset counts as loaded if any of its rows
resolve). Sources not checked for current availability unless stated.

| Kind | Not loaded |
|---|---|
| Tabular | Harvard GHI hospital capacity (2020, static); BRFSS / IHME smoking prevalence 1996-2012 (IHME GHDx, registration) |
| In the catalog, no data (truncated HSIP archive) | Petroleum Ports, POL Terminals, POL Pumping Stations, Power Plants, Prison Boundaries, Public Health Departments, Public Refrigerated Warehouses, Public Transit Routes / Stations, Station Transfers, Rail Company, Road Tunnels, Sand and Gravel Operations, Solid Waste Landfills, Supplemental Colleges, Uranium-Vanadium Deposits, Urgent Care, VHA Medical Facilities |
| Not in the catalog at all | PAD-US (only NPS units loaded); NLCD impervious, land cover change index, forest disturbance; CropScape CDL and corn / soybean / cotton / wheat frequency; EPA RMP, TSCA; EMS stations, local EOCs, PSAP boundaries; HGL and natural gas pipelines, oil / gas interconnects, oil refinery polygons; DoD site points; FUDS munitions response sites and property boundaries; IRM project boundaries; LandScan USA; TGS mines; US coal fields; FEMA NFHL; landslide regions; plate boundaries; seismic hazard 2% / 10%; places of worship; trails; NHD waterbodies (small scale) |

Already covered by another load: Food Access Research Atlas and EJScreen (tract /
block group), the ACS tables, public / private schools (NCES locations), military
installations (DoD boundaries), NWI, NLCD land cover.

**Update, same day:** 23 feature layers from this table are now loaded, see the
next section. What is still missing, and why, is under "Still not loaded" there.

### Supplementary File A feature layers (2026-11-20)

HIFLD Open was retired in 2025 and its ArcGIS Online org
(`services1.arcgis.com/Hp6G80Pky0om7QvQ`) now holds none of its layers. Every
layer below was re-sourced, in this order of preference: (1) the agency that now
publishes it (EIA, BTS NTAD, HRSA, USGS, EPA FRS); (2) a federal copy of the
HIFLD layer (FEMA RAPT / National Integration Center, `services.arcgis.com/XG15cJAlne2vxtgt`);
(3) when neither exists, a third-party copy of the **2021 HIFLD Open release**
(`services5.arcgis.com/HDRa0B57OVrv2E1q`, owner clibby007), named as such in
the layer's originator so a user can see it is a 2021 snapshot.

**Script:** `etl/prep_supp_a_layers.py fetch|prep <layer>` for 21 layers (`list`
shows them); `etl/prep_geo_layers.py rmp|tsca` for the two FRS layers.
`fetch` saves the raw download to `deploy/incoming/_raw/supa_<layer>.*` (ArcGIS
layers are paged by OBJECTID with `f=geojson`, and the fetched count is checked
against the service's own count); `prep` reads only that raw file and writes the
data file and the sidecar, so a re-run reproduces the loaded file byte for byte.
Points are CSV with latitude / longitude, lines and polygons GeoJSON rounded to 6
decimals. **Each sidecar carries an `include:` allowlist** (as `transit_stops`
does), so latitude, longitude, ids and source dates are stored but never become
search entries: 149 catalog rows for the 23 layers.

| Folder (table) | Features | Source used | Replaces |
|---|--:|---|---|
| `eia_power_plants` | 14,864 | EIA-860M, September 2026 generator inventory, built per plant | HSIP Power Plants, EPA FRS Power Plants |
| `ntad_petroleum_ports` | 242 | BTS NTAD `Petroleum_Ports` (2026-07) | Petroleum Ports |
| `ntad_pipeline_terminals` | 1,401 | BTS NTAD Intermodal Freight Facilities: Pipeline Terminals (carries `HIFLD_ID`) | POL Terminals |
| `pol_pumping_stations` | 1,270 | third-party copy of HIFLD 2021 | POL Pumping Stations |
| `prison_boundaries` (polygons) | 6,471 | FEMA RAPT copy of HIFLD (edited 2025-12) | Prison Boundaries |
| `public_health_departments` | 3,699 | FEMA NIC copy of HIFLD Open (edited 2026-01) | Public Health Departments |
| `urgent_care_facilities` | 4,810 | FEMA RAPT copy of HIFLD (edited 2025-09) | Urgent Care Facs |
| `vha_facilities` | 1,657 | VA sites as published by HRSA (`gisportal.hrsa.gov`, VHAFacilities_FS) | VHA Medical Facilities |
| `ntad_passenger_stations` | 15,488 | BTS Intermodal Passenger Connectivity Database | Public Transit Stations |
| `ntad_transit_routes` (lines) | 16,472 | BTS National Transit Map routes (2026-11), one line per route | Public Transit Routes |
| `ntad_road_tunnels` | 580 | FHWA National Tunnel Inventory via BTS NTAD | Road Tunnels |
| `solid_waste_landfills` | 7,376 | third-party copy of HIFLD 2021 | Solid Waste Landfill Facilities |
| `supplemental_colleges` | 2,767 | third-party copy of HIFLD 2021 | Supplemental Colleges |
| `uranium_vanadium_deposits` | 158 | USGS MRDS via third-party copy of HIFLD 2021 | Uranium Vanadium Deposits |
| `usgs_sand_gravel_operations` | 2,829 | USGS Mineral Industry Locations (`mrdata.usgs.gov/mineplant`, 2003 canvass) | Sand And Gravel Operations |
| `places_of_worship` | 254,742 | FEMA copy of HIFLD All Places of Worship (edited 2025-09) | (not catalogued) |
| `epa_rmp_facilities` | 21,855 | EPA FRS interests geodatabase, layer RMP (already on disk) | (not catalogued) |
| `epa_tsca_facilities` | 17,747 | EPA FRS, layer TSCA, one per registry id | (not catalogued) |
| `usgs_coal_fields` (polygons) | 602 | USGS coal fields (Tully 1996) via Esri Living Atlas | (not catalogued) |
| `usgs_landslide_regions` (polygons) | 2,810 | USGS OFR 97-289 / National Atlas `lsoverp020`, Stanford Digital Repository copy | (not catalogued) |
| `usgs_seismic_hazard_2pct50` (polygons) | 461 | USGS 2014 NSHM data release, `uspga250poly` | seismic hazard 2% |
| `usgs_waterbodies_small_scale` (polygons) | 26,878 | USGS National Map Small-Scale `wtrbdyp010g` (1:1M, 2014) | NHD waterbodies (small scale) |
| `plate_boundaries` (lines) | 514 | UTIG PLATES boundaries via Esri Living Atlas (ridge / transform / trench layers merged) | (not catalogued) |

What each one needed:

- **Power plants are built, not copied.** EIA's own Energy Atlas services now
  answer "Token Required", and the third-party copies are derived from EIA
  anyway, so the layer comes from EIA-860M (Operating + Operating_PR sheets,
  28,700 generators). One point per EIA plant id; `type` is the energy source
  with the most nameplate capacity at the plant (energy source codes grouped
  into Coal, Natural Gas, Other Gas, Nuclear, Solar, Wind, Hydroelectric,
  Hydroelectric Pumped Storage (prime mover PS), Petroleum, Biomass, Geothermal,
  Battery Storage, Other); `owner` is the entity of the largest generator.
  Checks: 1,423 GW total nameplate; Palo Verde 4,209.6 MW, Nuclear, Maricopa AZ.
  7,481 plants are mainly solar and 194 mainly coal: counting plants is not
  counting capacity.
- **POL terminals → BTS pipeline terminals.** The NTAD layer carries `HIFLD_ID`,
  so it is the same inventory maintained. The Y/N product and mode flags are
  folded into two text columns (`products`, `modes`); `products` is the label
  column, so "jet fuel terminals" can filter on it.
- **Transit stations → IPCD.** `FAC_TYPE` is a bare number with no domain in the
  service, so the class is derived from the `MODE_*` flags the service does
  define (most specific first: Airport, Ferry terminal, Rail station, Bus
  station, Bike share station): 6,373 bus, 5,279 rail, 2,740 bike share, 755
  airports, 340 ferry. IPCD is wider than HIFLD's transit stations (it includes
  airports and intercity bus); the description says so.
- **VHA:** type from `VHA_PRIM_SVC` (VAMC 172, primary-care CBOC 517, Vet
  Center 315, ...). Only 460 of 1,657 sites have a street address in the
  service; all have city, state, ZIP and coordinates.
- **Supplemental colleges are branch campuses, not trade schools.** My first
  description guessed "career schools"; the names say otherwise ("Central
  Carolina Community College - West Harnett Center", "Devry University -
  Glendale Campus"). HIFLD's `TYPE` is the IPEDS control code (1 public, 2
  private not-for-profit, 3 private for-profit), translated into `control`.
- **"Solid Waste Landfill Facilities" is mostly transfer stations**: 4,280 of
  7,376 are `Transfer`, 1,150 Municipal, 1,031 C&D. A count of "landfills"
  over every row would be wrong by more than half; the `type` description says
  which values are landfills.
- **Tunnels** are placed at the NTI portal coordinates (lat 18.0-60.8, lon
  -157.9 to -65.9: Puerto Rico to Alaska, all west longitudes negative).
- **Sand and gravel:** only `COMMODITY = 'Sand and Gravel'` of the 6,785 mineral
  locations, because crushed stone and the others are separate HSIP layers
  already loaded. Latin-1 file. Every row is a mine (`M`), so `type` is stored
  but not searchable.
- **Landslides:** `INC_SUS` codes translated with the definitions in the USGS
  metadata (high incidence > 15% of area in landslides, moderate 1.5-15%, low
  < 1.5%, and three susceptibility classes); 3 `no-data` polygons dropped.
  National 1:4M overview; the description says it is not for site decisions.
- **Seismic hazard: only 2% in 50 years exists as polygons.** The 2014 data
  release's GIS zip holds PGA 2%/50yr contours only; 10%/50yr is gridded data,
  not contoured. Contour levels are the ones the file uses (0-20 by 2, 30, 40,
  50, 60, 80, 120, 160, 200 %g; there is no 100 or 150). A `VALLEY = 1` polygon
  is a local minimum inside its contour (USGS domain), so its band is the level
  below `ACC_VAL`, not above: without that, the 43 valley polygons would read
  one band too high.
- **Places of worship:** IRS exempt-organization records geocoded by HIFLD
  (every record is `MATCH_TYPE` A). 254,742 points, the largest layer here; it is
  congregations as registered, so one church can appear under several EINs.
- **RMP:** every RMP REPORTER record is ACTIVE (19 blank), so status is dropped.
  **TSCA:** 26,482 submission records for 17,747 registry facilities; one record
  per registry id is kept, or a facility would count once per filing. Status is
  blank for 22,239 and `***UNCHANGED***` for the rest, so it is dropped.
- **Transit routes: one line per route, simplified.** The service holds 76,687
  GTFS shapes (every direction and branch variant) with 44 M vertices; written
  as-is it was a 1.0 GB GeoJSON. `prep` keeps, per `(feed_id, route_id)`, the
  longest shape (ties broken by `shape_id`) and simplifies it with
  Douglas-Peucker at 0.00005 degrees (~5 m): 16,472 routes, 13.9 M -> 2.0 M
  vertices, 48 MB. A route's reverse direction and branches are not separate
  lines; the description says so. 15,939 bus, 135 ferry, 118 light rail, 112
  rail, 79 subway.
- **Waterbodies:** kept all 8 feature types, including 11,632 swamp / marsh and
  1,660 glacier polygons; `type` separates them. `area_sq_mi` is as published.
- **Plate boundaries** are worldwide; most features match no county or state.

**Licences:** federal sources are public domain. The third-party copies are of
HIFLD Open data, which was public domain; the copy itself has no stated
licence. Esri Living Atlas coal fields and plate boundaries are USGS / UTIG data
re-served by Esri.

#### Checks after loading
- All 22 datasets resolve (`attribute_source` rows = catalog rows for every
  `ing_*` id above). `validate_catalog.py --new`: no errors.
- `known_item.yaml`: **91.7% recall@1, MRR 0.958, unchanged**, every item at
  the same rank as before (`eval/supa/known_before.json`, `known_after.json`).
  Three known items target the OLD, data-less HSIP rows (`ki-health-agency`
  Public Health Departments, `ki-tunnel-transport` Road Tunnels,
  `ki-energy-generation` Power Plants) and those rows still rank first, so the
  new layers do not displace them in search. What the planner sees is a
  separate question (below).
- `queries.yaml`, per suite: identical before and after (single_concept,
  facilities_via_tags, geographic_level, temporal 100%; multi_concept 87.5 / 75%;
  paraphrase 80 / 80%; the same three misses). `eval/supa/q_before_*.json`,
  `q_after_*.json`.
- One `/api/analyze` question per layer (`eval/supa/analyze_layers.py`,
  `analyze_run1.json`, `analyze_run2.json`): **23 of 23 plan over the new layer**
  (22 of 23 on the first wording, 20 with a usable answer). Checked against the table: Kentucky coal power plants
  8 = 8 (`type = Coal` filter); Texas petroleum ports 15 = 15; Missouri VA
  medical centers 5 (Columbia, Kansas City, two in St. Louis, Poplar Bluff);
  Michigan open landfills per county, `status = Open`, 83 counties; Utah
  uranium 74 of the 75 rows labelled Utah (Blue Cap, San Juan County, at
  -109.06 on the Utah-Colorado line, falls just outside the generalized
  `county_geom` polygons, so no state restriction reaches it). The three that needed a second wording:
  - "satellite college campuses in North Carolina" planned over the older
    College University Campuses layer; "branch campuses of colleges" uses the
    new one (108).
  - "lakes and reservoirs in Minnesota" returned **0 rows**: the planner emitted
    `type = Lake` AND `type = Reservoir`. "lakes in Minnesota" returns 1,477.
    Two filters on one column are ANDed; a planner / compiler issue, not data.
  - "tectonic plate boundaries near Alaska" returned 0 (plate lines are mostly
    offshore and carry no state); with no place it plans `count_features` per
    county, a valid but odd shape for a line layer.
- **Polygon and line answers repeat a feature once per county it crosses.**
  `select_features` restricted to a state compiles to `JOIN county_geom ON
  ST_Intersects(...)` with no DISTINCT: "areas of high landslide incidence in
  Pennsylvania" returned 11 rows that are **one polygon** (the only
  high-incidence polygon in PA) crossing 11 counties. Pre-existing (any polygon
  layer: NPL, parks, military), not caused by these loads; points are unaffected
  unless they sit on a border. Not fixed here.

Both guards were re-run after the last layer (transit routes) and read the same
(`known_after2.json`, `q_after2_*.json`).

#### Transfer
`C:\Users\Sam\Documents\geoARK_transfer\geoark_incoming_2026-11-20_suppA_features.zip`
(52.5 MB, 23 folders, 46 files, `MANIFEST.sha256` + `UNPACK.txt`). Complements
`geoark_incoming_2026-11-20b.zip`. Verified: every file's sha256 equals the
ledger entry; extracted and `sha256sum -c` 46 / 46 OK; and every `prep` re-run
reproduced all 46 files byte for byte. The raw downloads
(`deploy/incoming/_raw/supa_*`, about 2.1 GB, mostly transit routes and places
of worship) are not in it and are not needed by `make replay`.

#### Removed: the 548 no-data HSIP rows (2026-11-20, user's decision)
The user decided that a suite which drops when rows with no data are removed is
measuring the wrong thing, so all **18 unresolved HSIP groups** in the
Supplementary File A list were removed from `backend/geoark_attributes.csv` and
their entries from `etl/facility_table_map.csv`: 548 rows each, the 16 replaced
above plus Station Transfers, Rail Company and Public Refrigerated Warehouses
(no geometry or no usable source). (An earlier version of this note listed EPA
FRS Power Plants among them; that group has data and stays.) Removed by raw
record, so the diff against the backup is deletions only. Backups:
`etl/_backups/geoark_attributes.csv.bak-20261120-193815-pre-hsip-cleanup`,
`etl/_backups/facility_table_map.csv.bak-20261120-193815-pre-hsip-cleanup`.
Catalog 7,814 -> 7,266 rows; executable rows 5,848 before and after (nothing
with data was lost).

**Gold changed first.** Three known items pointed at the removed rows and now
point at the new layers' `name` rows (`ki-health-agency` ->
`ing_publichealth_01_01`, `ki-tunnel-transport` -> `ing_ntadroadtunn_01_01`,
`ki-energy-generation` -> `ing_eiapowerplan_01_01`; the old ids are kept in the
comments). Original gold: `eval/supa/known_item.yaml.orig`.

| known_item | recall@1 | MRR | the three repointed items |
|---|--:|--:|---|
| old gold, old rows present | 91.7% | 0.958 | 1, 1, 1 (dead rows) |
| new gold, old rows present | 66.7% | 0.776 | 2, 4, 15 (dead rows rank above the live ones) |
| **new gold, old rows removed** | **83.3%** | **0.882** | **1, 1, 12** |
| old gold, old rows removed | 66.7% | 0.708 | miss, miss, miss |

The remaining loss is real and is the new rows' own text: for "energy
generation station name" the new Power Plants layer comes 3rd (its
`technologies` column) and its name column 12th, behind other layers' "Name" /
"Station name" columns (Natural Gas Compressor Stations first). The HSIP tags
said "energy generation"; the new tags do not. Not tuned to the query.
`queries.yaml` per suite: unchanged (same three misses). Analyze probe
(`analyze_after_removal.json`): 22 of 23 on the new layer; "satellite college
campuses" now finds Supplemental Colleges (the older College Campuses layer
won before). The VHA question "how far ... from the nearest **VA medical
center**" planned 1 of 4 times: the planner tries to restrict
`nearest_distance` to `type = VA Medical Center`, which that op does not
accept; "from the nearest VA health care facility" plans
`nearest_distance -> filter_area` 2 of 2. A planner limit, not data.

#### Still not loaded, and why
- **Station Transfers, Rail Company:** not feature layers. Both HSIP entries are
  attribute tables with no geometry (`spatial_rep NONE`): a station-to-system
  lookup and a railroad reporting-mark list. Nothing can be mapped or planned
  over them; rail owners are already on the NTAD rail network.
- **Public Refrigerated Warehouses:** the only current copy
  (`services2.arcgis.com/PYn6bWCjT6bhw1z3`, 531 points) is a Salesforce export
  of Global Cold Chain Alliance member accounts (fields `activeacco`,
  `activeac_1` ...), a private trade association's list with no stated licence.
  Not loaded.
- **Seismic hazard 10% in 50 years:** published only as a grid (see above);
  contouring it here would be a new derived product.
- **PAD-US:** the PAD-US 4.1 Fee layer alone is 296,456 polygons
  (`edits.nationalmap.gov/.../PAD_US_4_1/MapServer/0`), and Designation /
  Easement add more. It needs `make parts` like NWI and a decision on which
  feature classes and GAP statuses to load. Left for its own load.
- Not attempted in this pass (no catalog rows, and each is a separate decision):
  NLCD impervious / change / forest disturbance, CropScape, EMS stations, local
  EOCs, PSAP boundaries, HGL and gas pipelines, oil / gas interconnects, refinery
  polygons, DoD site points, FUDS, IRM project boundaries, LandScan USA, TGS
  mines, FEMA NFHL, trails. FEMA RAPT (`XG15cJAlne2vxtgt`) holds copies of
  several (`911_Master_PSAP`, `EMSStations_*` regional only).

---

## Tract and block-group datasets

### USALEEP life expectancy (`usaleep`, tract)
- **Source:** NCHS `US_A.CSV`, life expectancy at birth by tract, 2010-2015.
- **Script:** `etl/prep_usaleep.py`.
- **Prep:** tract id padded to 11 digits; rows with no estimate dropped (none).
  Kept `e(0)` and its standard error; the abridged life tables
  (one row per tract and age) were not loaded.
- **Match:** 55,948 of 67,148 tracts; 11,200 skipped: **2010 tract boundaries**.
- Loaded as year 2015 (end of the 2010-2015 window).
- Mean life expectancy 78.2 years.

### USDA Food Access Research Atlas (`usda_fara`, tract)
- **Source:** the 2025 SNAP-authorized Retailer Access Map (SRAM) release
  (July 2026), on **2020 tract boundaries**. The 2015 and 2019 releases use
  2010 tracts and were not used.
- **Script:** `etl/prep_tract_tables.py fara`.
- **Prep:** the zip holds three tract tables (general characteristics,
  driving distance, straight-line distance), joined on tract id. **The general
  table drops the leading zero for states 01-09** (10-digit ids); a first run
  with a length filter would have discarded 15,636 tracts (Alabama through
  Connecticut). Ids are now padded before the join.
- **Kept (31 measures):** 8 general (urban flag, low-income tract flag,
  low-income / children / seniors / no-vehicle / SNAP / veteran counts); 20
  driving-distance (low-income-low-access flags at 1/2, 1 and 10/20 miles,
  vehicle access flag, low-access flags and populations); 3 straight-line
  flags. Descriptions come from the release's variable lookup.
- **Dropped:** tract population, poverty rate and median family income
  (ACS and SVI carry them), race-specific low-access counts, the other ~100
  distance variables, county names (the file mixes UTF-8 and cp1252: Dona Ana).
- **Match:** 83,240 of 84,119; 879 skipped (Connecticut's planning-region
  tracts, newer than `county_geom`).
- **Caveat:** distances are to SNAP-authorized *retailers*, not only
  supermarkets, so "food desert" here is the SRAM definition. One column,
  `DD_SRAM_lalowihalfshare`, has a maximum of 4,500 although it is a percent;
  left as published.

### EPA EJScreen 2024 (`epa_ejscreen_tract`, tract)
- **Source:** EJScreen 2024 version **2.32** (August 2024), tract, national
  percentile file. The download holds three releases: `2.30_July_DoNotUse`,
  `2.31_August_useMe`, `2.32_August_UseMe`; 2.32 is the newest. EPA withdrew
  EJScreen from its site in 2025, so this is an archived copy.
- **Script:** `etl/prep_tract_tables.py ejscreen`.
- **Prep:** `ID` written as GEOID; 686 territory rows (American Samoa, Guam,
  Northern Marianas, Virgin Islands: 7- and 10-digit ids) dropped.
- **Kept (37):** 13 environmental indicators (PM2.5, ozone, diesel PM, air
  toxics, traffic, lead paint, Superfund / RMP / hazardous-waste proximity,
  underground tanks, wastewater, NO2, drinking water), 9 demographic shares,
  the two demographic indexes, and 13 EJ indexes (`D2_*`).
- **Dropped:** percentile columns (`P_*`), map bins (`B_*`), map text (`T_*`),
  the supplemental EJ indexes (`D5_*`), ACS count bases, and geometry. The
  percentile filter can derive "top 10%" from the raw values.
- **Match:** 85,396 of 85,396 (100%).
- **Not loaded:** the block group file (available in the same download).

### EPA EJScreen 2024, block group (`epa_ejscreen_bg`, same id `epa_ejscreen`)
- **Source and prep:** the block group file of the same release (v2.32), through
  the same script and column set (`etl/prep_tract_tables.py ejscreen_bg`), so the
  tract and block group measures share codes. 686 territory rows dropped; the
  rest are 12-digit ids.
- **Match:** 242,336 of 242,336 (100%). 8.87 million values, 37 measures.
- **Cross-check:** the national mean PM2.5 is 8.447 at block group and 8.448 at
  tract.
- Same findability gap as the tract measures: no catalog rows, so the planner
  cannot reach them yet (see "Open: tract-only measures").

### EPA Smart Location Database v3 (`epa_sld_bg`, block group)
- **Source:** `SmartLocationDatabase.gdb` (710 MB), layer `EPA_SLD_Database_V3`,
  220,739 block groups, CONUS only.
- **Script:** `etl/prep_tract_tables.py sld [--export]`. GDAL runs inside the
  `etl-geo` container; `/incoming` is read-only there, so the CSV is streamed
  out through stdout to `deploy/incoming/_raw/sld_raw_export.csv`.
- **Prep:** `GEOID20` used as GEOID. `-99999` (no data) treated as missing.
- **Kept (36):** walkability index, residential / employment / activity
  density, land-use mix, road and intersection density, transit distance,
  frequency and coverage, job accessibility by car and transit, zero-car
  households, wage shares, jobs by sector, work-related travel and emissions.
  Descriptions follow EPA's field list.
- **Dropped:** the VMT model coefficients (`B_*`), county aggregates (`C_R_*`),
  rank and log variants, 5-tier job counts, population counts, region.
- **Match: 171,726 of 220,739 (78%).** 49,013 skipped. The block group codes
  are on 2010 boundaries (the data are 2018), so about a fifth no longer exist
  in 2020 geometry.
- Transit measures are blank where a block group has no transit: `D4A` has
  94,196 values of 220,739.

### GeoARK distance to nearest facility (`hsip_proximity_{county,tract,bg}`, id `hsip_proximity`, 2026-11-22)
- **Source:** `summarized_blocks.csv` (5.75 GB, 7,781,824 blocks), made by
  `/scratch/US_L48GeoARK_TEMP/summarize_block.py` from `US_L48GeoARK.gdb`
  layer `L48_All_Pt_Blk1020ZipHUC_TH_Area`: 118,158,718 points (2020 block
  centroids plus hexagon tessellation points), lower 48. Each point carries an
  ArcGIS Near distance to the nearest feature of 29 HSIP layers; a block's
  `D_<x>_avg` is the mean over its points. Plan for the points themselves:
  [POINTS_INTEGRATION_PLAN.md](POINTS_INTEGRATION_PLAN.md).
- **Script:** `etl/prep_proximity_summaries.py [SUMMARIZED_BLOCKS_CSV]`. It writes
  all three folders and their sidecars.
- **Why not the published `summarized_{counties,tracts,block_groups}.csv`:**
  `summarize_eachGeo.py` read `Block20` with pandas as an integer, which
  dropped the leading zero for states 01-09, then took prefixes of a
  14-character string. Every code in AL, AZ, AR, CA, CO, CT and the other
  single-digit states is shifted by one digit ("county" 60730 = county 06073
  split by first tract digit). 336 of 3,159 county, 43,329 of 111,413 tract and
  45,290 of 239,615 block group codes matched no unit. The prep pads `Block20`
  to 15 digits and redoes the roll-up.
- **Checked against the original county file:** for states 10-56 the new values
  equal the original within 1e-4 mi, except 17 counties that the bug had
  merged with another state's shifted codes: 11 in Oklahoma (40019 Carter also
  received Arizona county 001's blocks under tract digit 9) and 6 in Virginia
  (from Arkansas county 1xx). Those 17 were wrong in the original and do not
  match unaffected units, so matching codes alone would not have caught it.
- **Roll-up:** same method as `summarize_eachGeo.py`, the unweighted mean of
  block means (not weighted by points, area or population). Metres to miles.
- **Kept (27):** EMS, public health departments, child care, public schools,
  colleges, worship, public transit, transmission lines, substations, power
  plants, oil refinery points and polygons, biodiesel, EPA TRI, EPA TSCA,
  landfills, tornado tracks, and nine mining / mineral layers.
- **Dropped:** `D_CrshStOp` (equal to `D_CnsMinOp` in all 7,781,824 blocks; its
  gdb alias is a bare `NEAR_DIST`); `D_Airport` (reaches 3,189 km inside the
  lower 48, which fits the USACE IENC "Airport Areas" layer, not airports;
  left out until the source layer is confirmed); `F_*_list` (nearest-feature
  ids). Not in the block file at all, so not here: `HospEDist`,
  `UrgCareEDist`, `ParksEdist`, `DIST_VHA`, `PowerLineDen` (raster-derived or
  added later; they exist on the points).
- **Match:** county 3,108 of 3,108; tract 82,666 of 83,545; block group
  234,943 of 237,654. Every skipped code is Connecticut (879 tracts, 2,711
  block groups): 2020 blocks use the old CT counties, the loaded 2026 TIGER
  tracts the planning regions. CT is present at county level.
- **Missing values:** 54,806 blocks have no value for 23 of the 27 measures
  (all but child care, construction minerals, ferrous mines, biodiesel), so
  some units average over fewer blocks for those.
- **Distance metric, measured:** the values are planar metres in World
  Cylindrical Equal Area (ESRI:54034). On 6,123 points around Columbia, MO,
  `D_EMS` equals the 54034 planar distance to the nearest station in the loaded
  EMS layer within 5 m for 91%; against geodesic distance the median ratio is
  0.977 and the 5th-95th percentile 0.78-1.28. Unit means are close; single
  points are off by up to ~25% at 39N, more further north (east-west stretch
  1/cos(lat), north-south shrink cos(lat)).
- **Zeros:** `dist_college` is 0 where every block of a unit lies inside a
  campus polygon, which is right for a polygon layer.
- **Loaded 2026-11-22:** 27 county measures (83,640 values, 27 catalog rows,
  tagged, all `acs_long` executable), tract 2,222,736 values over 82,666
  tracts, block group 6,314,320 over 234,943, `geo_measure` 27 per level.
  County EMS vs the mean of its tracts' values: r 0.960 (not 1, because a
  county is the mean of its blocks, not of its tracts).
- **Live, through `/api/analyze`:** "Which counties in Missouri have the longest
  average distance to an EMS station?" planned `load(HSIP_PROXIMITY_DIST_EMS) ->
  filter_area -> rank`, top 5 equal to SQL gold (Madison 9.22, Pemiscot 8.62,
  Shannon 7.18, Texas 7.13, Carroll 7.12). The tract question about public
  schools loaded `HSIP_PROXIMITY_DIST_PUBLIC_SCHOOL` at tract level and returned
  the right #1 (29111970200, 10.00 mi), one row only: the open "default rank
  limit for unnumbered 'most'" item.
- **Retrieval after the load** (`eval/proximity/`; run through a signed-in
  session, since `eval/run.py` sends no cookie and with `ACCESS_CODE` set every
  request 401s; the saved `cart_cleanup_*_known.json` runs are all-401 and
  cannot serve as baselines): known-item 10/11 recall@1, MRR 0.917. The one miss,
  `ki-energy-generation` at rank 12, has no proximity row above it.
  `queries.yaml` 94.9% recall / 93.5% success with 5 requests rate-limited (429);
  its two unemployment misses have no proximity row in their top 20.

---

## Feature layers (polygons)

Feature layers are tagged at load (`make ingest` runs gemma3:4b over every
column and writes catalog rows), unlike tract measures, so they are findable
immediately. All three were checked with a question: the planner chose
`select_features` / `count_features` with the right status and type filters.
Script for all three: `etl/prep_geo_layers.py` (GDAL runs in `etl-geo`;
`/incoming` is read-only there, so GeoJSON is streamed out through stdout).

### EPA Superfund NPL site boundaries (`epa_npl_sites`, 1,908 polygons)
- **Source:** `NPL_Boundaries.gdb`, layer `SITE_BOUNDARIES_SF` (the geodatabase
  also holds operable-unit, institutional-control, feature point / line /
  polygon layers; none loaded).
- **One polygon per site.** The layer has 2,115 polygons for **1,908 distinct
  EPA ids**, because a site can carry several boundary types. Counting rows
  would double count sites, so one is kept per id: the first of Comprehensive
  Site Area, Site Boundary, Total Site Polygon/OU Aggregation, Current Ground
  Boundary ... that exists, then the largest. Kept: 785 comprehensive areas, 488
  current ground boundaries, 184 aggregations, 170 site boundaries, the rest
  other types. The choice of priority is mine and is not EPA's; it affects only
  which outline is drawn, not the count.
- **Status codes translated** from the geodatabase's own coded-value domain
  (F "Currently on the Final NPL" 1,322; D "Deleted from the Final NPL" 465;
  P "Proposed" 36; N "Not on the NPL" 70; R, S, A, W small). Federal-facility
  codes likewise.
- **Not carried:** the site contact person's name, phone and email (individuals'
  details), the disclaimer text, feature URLs, dates, `GIS_AREA`.
- **Includes non-NPL records:** 70 sites "Not on the NPL" and 10 "Removed from
  proposed" are in the source; the status column separates them.
- Check: Missouri, currently on the Final NPL: 33.

### DoD military installations (`dod_military_bases`, 815 polygons)
- **Source:** NTAD Military Bases geodatabase, layer `Military_Bases`, 824
  polygons.
- **Repair:** 9 polygons did not survive `-makevalid` and are gone (824 -> 815).
  **PostgreSQL segfaulted** (signal 11) while the loader tagged each polygon with
  the states it overlaps: `ST_Intersects` of one polygon, **Fort Gregg-Adams, VA**
  (5 parts, 1,408 points), against `county_geom` crashes GEOS. `-makevalid` alone
  did not stop it; simplifying by 0.00001 degrees (about 1 m) did, and no crash
  since. Found by running the query per polygon against the 84 large ones. The
  database recovered each time by itself; no data was lost. Other layers in this
  group did not trigger it.
- **Codes translated:** branch (`usa` Army, `usn` Navy, `usaf` Air Force,
  `armyNationalGuard`, ...) and status (`act` Active 782, `care` Caretaker 14,
  `clsd` Closed 11). **`semi` (4) and `excs` (4) are undocumented in the
  geodatabase and are read as Semi-active and Excess (inferred, unverified).**
- **Not carried:** CUI and FIRRMA flags, media and system ids, descriptions.

### National Park Service units (`nps_park_units`, 437 polygons)
- **Source:** `National_Parks.shp` (NPS unit boundaries); no repair needed.
- Types: 87 national monuments, 76 historic sites, 64 historical parks, 62
  national parks, 31 memorials, and others. Status: 421 official, 16 legacy.
- **Not carried:** creator, edit dates, GlobalID, IRMA reference, metadata
  strings.
- The `state` column can hold more than one state for units that cross a border.
- The geometry reads as "Unknown (any)" (polygons and multipolygons mixed); it
  loaded and queried fine.

### Skipped: `NTAD_Places` (32,629 polygons)
It is the Census place polygons, the same set already loaded as `place_geom`
(32,642, TIGER 2026), and `filter_place` already uses it. As a feature layer it
would add 32,000 rows with no new question to answer, and numeric filters on
feature columns (its `POP2020`) are not built.

## Feature layers (points, from the FRS interests download)

Source: `FRS_INTERESTS.gdb` (8.7 GB unpacked) from the EPA Facility Registry
Service. It holds **28 point layers for about 7 million facility-interest
records** (air, water discharge, hazardous waste, toxics, Superfund, Brownfields
and more) plus three attribute tables. Only two parts were loaded. Script:
`etl/prep_geo_layers.py acres | sems`. Tagged at load like the polygon layers.

**Checked for duplication before loading** (attributes exported and compared by
EPA program id, 2026-11-13):

| FRS layer | Records | Against `epa_npl_sites` (1,908 boundary polygons) | Decision |
|---|--:|---|---|
| `SEMS_NPL` | 1,766 | **1,751 of 1,766 ids already have a boundary polygon** (only 15 do not); it is the same sites as points | **Not loaded** (a duplicate) |
| `SEMS` | 31,947 | contains the 1,766 NPL sites **plus 30,181 that are not on the NPL** (11,997 "not on the NPL", 17,705 with no status, 422 part of an NPL site, 51 removed from proposed, 7 withdrawn) | **Loaded the 30,181 non-NPL only** |
| `ACRES` | 44,706 | Brownfields properties; 445 share a registry id with a Superfund (SEMS) site (7 with an NPL site) | **Loaded all**: a property on a Superfund site is a real overlap, not a duplicate |

Not loaded: the other 25 layers and the three tables. FRS `TRI`, `RCRA`,
`NPDES`, `RMP`, `AIR` and others overlap layers already in the catalog from the
HIFLD source (for example TRI and power plants) or are very large (NPDES 1.9
million, RCRA 1.6 million, the interest table 7.1 million); loading them is a
separate decision.

### EPA Brownfields properties (`epa_brownfields`, 44,706 points)
- One point per ACRES property; 42,081 distinct registry facilities, so several
  properties can sit at one facility. All kept.
- Kept: name, program id, registry id, address, city, county, county FIPS, state,
  ZIP, federal-facility flag, EPA region, coordinate accuracy and source.
  **Status is blank for every ACRES record**, so no status column is offered.
- **Coordinates:** none at (0, 0) or outside the US and territories; accuracy is
  stated for 35,895 (median 30, 90th percentile 50, maximum 9,999). The unit is
  assumed to be meters (FRS convention); unverified. Points are address-placed,
  so distance questions are approximate.

### EPA Superfund sites not on the NPL (`epa_superfund_nonnpl`, 30,181 points)
- The SEMS inventory with `INTEREST_TYPE = 'SUPERFUND (NON-NPL)'`. The status
  column keeps EPA's wording ("Not on the NPL", "Removed from proposed NPL",
  "Site is part of NPL site"); **blank status is written as "Not stated"**
  (17,705 records).
- The dataset name and description say "not on the NPL" and point to the NPL
  boundaries layer, because a question about "Superfund sites" now has three
  candidate layers. **Tested:** "How many Superfund sites are in each state?",
  "Which counties have the most Superfund sites?" and "Where are the Superfund
  sites ... in Illinois?" all plan over the NPL boundaries layer, not this one.
- 8 points are in American Samoa and Pacific territories.

### Findings from loading these
- **The API caches feature filter values per table forever**
  (`filterValuesCache`, `unified_search_server.js`). After `--replace` of a layer
  with changed values the planner keeps quoting the old ones until the API is
  restarted (`docker restart geoark-api-1`; reload-corpus does not clear it).
- **Spelling the acronym out hurt.** Changing NPL status text from "Currently on
  the Final NPL" to "Currently on the Final National Priorities List (NPL)" made
  the planner drop the status filter for both wordings of the question (0 of 4
  runs, against 2 of 2 for "Final NPL" before). Reverted.
- **Status filter limits (planner, not data), 2 runs each:** "currently on the
  Final NPL in Illinois" attaches the filter; "currently on the National
  Priorities List in Illinois" does not (3 of 3, returns every status); "deleted
  from the NPL in Ohio" is refused with `the loaded data does not include
  "deleted from the NPL"`. Not changed.

## Feature layers (points, geocoded with the Census Bureau batch geocoder)

Four CMS facility files carried street addresses. Scripts:
`etl/geocode_cms_census.py` (sends addresses, saves the raw answers to
`deploy/incoming/_raw/geocode_<set>.csv`) and `etl/prep_cms_facilities.py`
(builds the layers; reads only the saved answers, so it never calls the
service). **The user authorised sending the addresses to the Census geocoder on
2026-11-13 and asked for one method for all four sets, including the nursing
homes that could have been matched by phone to another layer.** Only an id,
street, city, state and ZIP were sent (no facility name or phone). The service
is `geocoding.geo.census.gov`, benchmark `Public_AR_Current`, 5,000 addresses
per request, no key.

| Set | Rows | Exact | Non-exact | Tie | No match | In layer |
|---|--:|--:|--:|--:|--:|--:|
| Nursing homes (`cms_nursing_homes`) | 14,686 | 11,232 | 2,249 | 133 | 1,072 | **13,481 (91.8%)** |
| Dialysis (`cms_dialysis_facilities`) | 7,471 | 5,314 | 1,346 | 41 | 770 | **6,660 (89.1%)** |
| Hospices (`cms_hospices`) | 6,669 | 4,624 | 1,571 | 41 | 433 | **6,195 (92.9%)** |
| Long-term care hospitals (`cms_long_term_care_hospitals`) | 311 | 214 | 66 | 1 | 30 | **280 (90.0%)** |

- **A point exists only where the geocoder returned a Match.** Tie and No_Match
  facilities (2,759 of 29,137, 9.5%) are not in the layers and each layer's
  description says how many are missing. They are not placed at a ZIP centroid or
  taken from another layer. Every point has `geocode_match` (Exact or Non-exact).
- **Correction to an earlier note:** this log first said none of the CMS files had
  coordinates. **The nursing home file does** (`Latitude`, `Longitude` for all
  14,686); the dialysis, hospice and long-term care files do not. The CMS
  coordinates are not used as positions, only as a cross-check.
- **Cross-check, nursing homes (13,481 placed vs CMS's own coordinates):** median
  difference 35 m, 90th percentile 398 m, 794 over 1 km, 51 over 10 km. Exact
  matches differ by over 1 km in 2.6% of cases, **Non-exact in 22.4%**. In the
  largest disagreements **CMS's own coordinates are the wrong ones** (Wolf Point
  MT plotted 30 km away; an Atlanta GA facility 25 km away; the Dallas Buckner
  Blvd facilities 24 km away), the Census points are in the right town. This is
  why third-party coordinates were not used.
- **Independent check against boundaries (all four layers, 26,616 points):** no
  point lies outside every county; **no point is in a wrong state** once border
  addresses are understood (the one apparent miss is a hospice on North State
  Line Avenue in Texarkana, which is the Arkansas-Texas border). Share of points
  outside the listed ZIP code's area (ZCTAs only approximate ZIPs, so a low
  baseline is expected): Exact 1.7-3.7%, **Non-exact 7.9-11.7%**. Non-exact is the
  weaker group; the layers keep it, flagged. Dropping it would remove about 17%
  of facilities.
- **Geometry loads as MultiPoint**, not Point: `ST_Y` fails on it; use
  `ST_Centroid` first in checks.
- **Kept columns:** nursing homes 22 (ownership, certification type, beds,
  residents, Five-Star ratings, staffing hours, turnover, fines, special focus,
  chain, ...); dialysis 16 (ownership, chain, five-star, stations, services,
  survival and hospitalization categories); hospices 9; long-term care hospitals
  10. **Phone numbers, the CMS legal-entity, footnote, measure-cycle and chain
  statistics columns are not carried.**
- Layers are `kind: features`, so they are tagged at load (61 catalog rows).

### Findings from using them
- **"Nursing homes" is now ambiguous.** The catalog also holds the HIFLD
  "Nursing Homes" layer (40,663 points, 2019, includes uncertified homes).
  "How many nursing homes are in each county in Ohio?" plans over the **HIFLD**
  layer, not the CMS one (1 of 1 runs). Dialysis and hospice questions use the
  CMS layers (no competing layer). Not changed; which one answers "nursing
  homes" is a decision.
- **Numeric columns cannot be filtered on a feature layer** (known, not built):
  "Which nursing homes in Missouri have a five star overall rating?" is refused
  (`the loaded data does not include "five star overall rating"`). Ratings,
  beds and fines are stored and searchable as attributes only.

## Getting this batch onto the server (checked 2026-11-13)

`deploy/incoming/` and `deploy/dumps/` are **git-ignored**, so data folders and
their sidecars do not travel with a commit. Git carries only the catalog and the
ledger.

**Through git** (commit, push, then `git pull` on the server):
`backend/geoark_attributes.csv` (the tagged catalog rows), `etl/data_manifest.yaml`
(the ledger), `etl/facility_table_map.csv`, `etl/prep_*.py`,
`etl/geocode_cms_census.py`, `docs/`, `CLAUDE.md`. The working tree also holds
about 90 other modified or new files from other work (planner ops, frontend);
review them before committing, because the server's API is built from the code in
the repo.

**By copy** into `deploy/incoming/` on the server (554 MB; the folders hold the
prepared data and the sidecar, both checksummed against the ledger):
`usaleep nri_county oi_mobility_county oi_mobility_tract oi_neighborhood_county
oi_neighborhood_tract ahrf_workforce ahrf_facilities ahrf_population_health
usda_fara epa_ejscreen_tract epa_ejscreen_bg epa_sld_bg noaa_climdiv_county
cdc_overdose_county epa_npl_sites dod_military_bases nps_park_units
epa_brownfields epa_superfund_nonnpl cms_nursing_homes cms_dialysis_facilities
cms_hospices cms_long_term_care_hospitals`. Not needed there: the raw downloads
and `_raw/` (the saved geocoder answers, 7 MB, are only needed to rebuild the CMS
layers).

**On the server:** `git pull`; `make replay-dry`; `make replay`; `make health`
(`corpus_stale: false`, 7,450 catalog rows); `docker restart` the API if only
data changed. Replay loads data only: it never tags and never writes the catalog.

**Ledger state (`make replay-dry`, 2026-11-13):** every entry reads `current` /
`ok` except `ing_nwiwetlands_01`, which was already `stale` in this database
before this work. Two groups needed fixing first, because replay refuses a file
that differs from what the ledger recorded:
- the four Opportunity Atlas entries (sidecars regenerated after loading), and
- `ing_svi_01@tract` / `@county` (sidecars edited on 2026-11-11, after the
  2026-10-16 load). Both re-ingested with `--replace` on 2026-11-13; the 30 county
  SVI measures were re-tagged, and retrieval was re-checked afterwards
  (`known_item` 91.7% / 0.944, concept suites unchanged).

**Transfer file:** `C:\Users\Sam\Documents\geoARK_transfer\geoark_incoming_2026-11-13.zip`
(228 MB; 26 folders, 54 files: the 24 above plus `svi_county` and `svi_tract`).
It holds `incoming/<folder>/...`, a `MANIFEST.sha256` and `UNPACK.txt`. Verified
by extracting it and checking every file against the manifest. Unzip into
`deploy/` on the server.

**Why not a database dump:** replay loads each dataset from its files, checks it
against the ledger, and validates it; a whole-database `pg_dump` would overwrite
whatever else is on the server (its own loads, caches, users) with this
machine's state, and it skips the ledger check. `make dump-dataset` is for one
large dataset at a time (WorldPop: 2 min from raw, 19 s from a dump); nothing in
this batch is large enough to need it.

**What is tagged:** all 352 catalog rows from `ing_*` datasets have tags, and 320
also a generated description. Not in the catalog at all, so not tagged: the 106
tract and block-group-only measures (USALEEP, Food Access, EJScreen, Smart
Location) and 6 measures covering under 500 counties (5 NRI, 1 AHRF). Tags and
descriptions are made here by gemma3:4b and reach the server only through
`backend/geoark_attributes.csv`.

## Suites that now read differently

- **Rainfall is answerable** (`noaa_climdiv`). `eval/answerability.yaml`
  `r-rainfall` and `eval/research.yaml` `r-refuse-rainfall` still expect a
  refusal and will count a correct answer as "nonsense answered". They were not
  edited: whether to flip them to answer-checks with gold from the data is the
  suite owner's call. "What is the average rainfall by county?" plans
  `load` of the 1991-2020 precipitation normal -> `output`.
- **Snowfall is now answered with a stand-in** (see the climate entry).
  `r-snowfall` therefore counts as a refusal failure. This is a real change in
  behaviour caused by adding data, not a suite artefact.

## Not loaded, and why

- **CMS `DAC_NationalDownloadableFile.csv`** (902 MB): one row per clinician,
  not per facility; AHRF already gives physicians per county.
- **Most of the FRS interests download**: 25 of 28 layers (see above).

## Unverified

- **Military status codes `semi` and `excs`** are read as Semi-active and Excess
  (see the military entry); the geodatabase does not define them.
- **EJScreen unit labels** (ozone ppb, PM2.5 and diesel µg/m3, traffic
  proximity, wastewater and air-toxics "toxicity-weighted concentration")
  follow EPA's documentation as I recalled it. Check against
  `deploy/incoming/epa_ejscreen/ejscreen-tech-doc-version-2-3.pdf`.
- **SLD emissions units** (`GHG_per_worker`, `Annual_GHG`) are labelled "units
  per EPA SLD documentation" because the geodatabase field list does not state
  them.
- **Opportunity Atlas descriptions** (income rank "around age 35", children
  born 1978-83, jail rate "on April 1, 2010") are from memory of the Atlas
  documentation; confirm against its readme PDFs.
- **`gsmn_math_g3_2013`** is labelled "average third-grade math test score,
  standardized"; the readme should be checked.

## Open: tract-only measures cannot be asked about yet

**Tracked as a known gap with options and a done-when in
[DATA_LOADING_PLAN.md](DATA_LOADING_PLAN.md), "Open: tract-only measures are not
findable".** Summary:

Measures at a tract or block group get no catalog rows (`ingest.py` prints
"No catalog rows: nothing can plan over a tract measure"). The planner reaches
a measure at a named unit only through a catalog row whose code has values at
that level (`unified_search_server.js`, around line 2376, `hasLevel`). So:

| Reachable at tract level | Not reachable |
|---|---|
| SVI, Opportunity Atlas (each has a county twin with catalog rows) | USALEEP, Food Access, EJScreen, SLD |

Measured 2026-11-12: "Which census tracts in Missouri have the highest PM2.5?"
returns `the loaded data does not include "PM2.5"`. The data is loaded and shows
on the `/explore` map; the planner cannot reach it. Adding catalog rows for
tract-only measures is the fix and it is a retrieval-affecting change (they
would also be retrieved for county questions), so it needs the suites in the
CLAUDE.md list run before and after.
