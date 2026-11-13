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
