"""Prepare two USDA ERS county atlases for `make ingest`.

    python etl/prep_ers_atlases.py fea      # Food Environment Atlas (July 2025 release)
    python etl/prep_ers_atlases.py rural    # Atlas of Rural and Small-Town America (2024 release)

Raw downloads (unzipped in place) are read from deploy/incoming/ers_fea_raw/ and
deploy/incoming/ers_rural_raw/:

    https://www.ers.usda.gov/media/5570/food-environment-atlas-csv-files.zip
    https://www.ers.usda.gov/media/5776/download-the-data-in-csv.zip

Both releases are LONG (FIPS, State, County, Attribute/Variable_Code, Value) with
a lookup table that gives each code a label ending in its year ("..., 2019",
"..., 2017-21"). Each writes deploy/incoming/<id>/<id>.csv as GEOID, YEAR,
measures, plus a sidecar, the same shape as the AHRF and overdose loads.

ONE MEASURE PER CONCEPT, THE YEAR AS A COLUMN. FEA codes carry the year as a
two-digit suffix (LACCESS_POP15, LACCESS_POP19): when the label's year matches
the code's suffix the suffix is stripped, so both land under LACCESS_POP with
YEAR 2015 / 2019. A label with a range ("2017-21") is dated by its END year,
the convention ACS and the existing ERS load use.

WHAT IS DROPPED, AND WHY (detail in docs/DATA_CARPENTRY.md):
  fea   state-level variables (label ends in "*": one value repeated over every
        county in a state reads as county variation and would rank as such);
        "% change" and "percentage points" variables (derived, and `combine`
        computes a change from the two years); "Socioeconomic Characteristics"
        (poverty, median income, race shares: the same SAIPE/ACS numbers already
        loaded under USDA ERS and ACS), except PERPOV17_21, the persistent-
        poverty designation, which nothing else carries.
  rural every variable already loaded from the ERS county files (population
        estimates, labor force / employment / unemployment, SAIPE poverty and
        median income, educational attainment, metro / RUCC / UIC codes): the
        same numbers under a second name are near-duplicates, which this project
        has measured as the main retrieval risk. Count columns are dropped where
        a percent of the same thing is kept.
"""
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
q = json.dumps

RANGE = re.compile(r"((?:19|20)\d\d)\s*-\s*((?:19|20)?\d\d)\s*\*?\s*$")
YEAR = re.compile(r"((?:19|20)\d\d)\s*\*?\s*$")


def label_year(label: str):
    """(label without its trailing year, end year) or (label, None)."""
    s = label.strip()
    m = RANGE.search(s)
    if m:
        a, b = m.group(1), m.group(2)
        end = int(b) if len(b) == 4 else int(a[:2] + b)
        if end < int(a):
            end += 100
        return s[: m.start()].strip(" ,-"), end
    m = YEAR.search(s)
    if m:
        return s[: m.start()].strip(" ,-"), int(m.group(1))
    return s, None


def fips5(raw: str):
    d = re.sub(r"\D", "", raw or "")
    if not d or len(d) > 5:
        return None
    d = d.zfill(5)
    return None if d.endswith("000") else d


def detect(path: Path) -> str:
    """ERS files mix UTF-8 and cp1252 ("Doña Ana"), and the first bad byte can be
    megabytes in, so the WHOLE file decides."""
    b = path.read_bytes()
    try:
        b.decode("utf-8")
        return "utf-8-sig"
    except UnicodeDecodeError:
        return "cp1252"


def num(raw: str):
    s = (raw or "").strip().replace(",", "")
    if s in ("", "N/A", "NA", "-9999", "-8888", "-9999.0", "-8888.0"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return None if v in (-9999.0, -8888.0) else s


def write(out_id, rows_by_key, measures, header_meta):
    """rows_by_key: {(geoid, year): {code: value}}; measures: {code: (desc, units)}."""
    out = INC / out_id
    out.mkdir(exist_ok=True)
    codes = sorted(measures)
    n = 0
    with open(out / f"{out_id}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["GEOID", "YEAR"] + codes)
        for (g, y) in sorted(rows_by_key):
            vals = rows_by_key[(g, y)]
            w.writerow([g, y] + [vals.get(c, "") for c in codes])
            n += 1
    lines = [header_meta.rstrip(), "columns:"]
    for c in codes:
        d, u = measures[c]
        lines.append(f"  {c}: {{desc: {q(d)}, units: {q(u)}}}")
    (out / f"{out_id}.meta.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    counties = len({g for g, _ in rows_by_key})
    print(f"{out_id}: {len(codes)} measures, {counties} counties, {n} county-years -> {out}")


# ---------------------------------------------------------------- Food Environment Atlas
FEA_UNITS = {"Percent": "percent", "Count": "count", "# per 1,000 pop": "per 1,000 people",
             "Classification": "code", "Acres": "acres", "Acres/1,000 pop": "acres per 1,000 people",
             "Dollars": "dollars", "Dollars/store": "dollars per store",
             "Dollars/capita": "dollars per person", "Legend": "code",
             "1,000 dollars": "thousand dollars", "Sq ft": "square feet",
             "Sq ft/1,000 pop": "square feet per 1,000 people"}


def fea():
    src = INC / "ers_fea_raw"
    code_map, measures, dropped = {}, {}, defaultdict(int)
    for r in csv.DictReader(open(src / "VariableList.csv", encoding="utf-8-sig")):
        code, name, units = r["Variable_Code"].strip(), r["Variable_Name"].strip(), r["Units"].strip()
        cat = r["Category_Name"].strip()
        if name.endswith("*"):
            dropped["state-level"] += 1; continue
        if units in ("% change", "Percentage points") or code.startswith(("PCH_", "CH_")):
            dropped["change"] += 1; continue
        if cat == "Socioeconomic Characteristics" and code != "PERPOV17_21":
            # Every other socioeconomic variable is a SAIPE / ACS number already
            # loaded; the persistent-poverty designation is not (it is also the
            # target of known_item.yaml ki-persistent-poverty).
            dropped["socioeconomic duplicate"] += 1; continue
        label, year = label_year(name)
        if year is None:
            dropped["no year"] += 1; continue
        measure = code
        suf = str(year)[2:]
        rng = re.search(r"(\d\d)_(\d\d)$", code)
        if rng and rng.group(2) == suf:          # PERPOV17_21 -> PERPOV
            measure = code[: rng.start()].rstrip("_")
        elif code.endswith(suf) and len(code) > 2:
            measure = code[: -len(suf)].rstrip("_")
        code_map[code] = (measure, year)
        desc = f"{label} ({cat}, USDA ERS Food Environment Atlas)"
        if measure in measures and measures[measure][0] != desc:
            # Two years of one measure whose labels differ only in wording: keep the first.
            pass
        measures.setdefault(measure, (desc, FEA_UNITS.get(units, units.lower())))
    rows = defaultdict(dict)
    for r in csv.DictReader(open(src / "StateAndCountyData.csv", encoding="utf-8-sig")):
        c = r["Variable_Code"].strip()
        if c not in code_map:
            continue
        g = fips5(r["FIPS"])
        v = num(r["Value"])
        if g is None or v is None:
            continue
        m, y = code_map[c]
        rows[(g, y)][m] = v
    print("fea dropped variables:", dict(dropped))
    head = f"""# USDA ERS Food Environment Atlas, July 2025 release (county level only).
# Prepared by etl/prep_ers_atlases.py fea: state-level, change and socioeconomic
# variables dropped; year suffixes folded into a YEAR column.
id: ers_fea
name: "Food Environment Atlas"
kind: table
level: county
geo_column: GEOID
year_column: YEAR
missing: [-8888]
description: "County indicators of the food environment from the USDA ERS Food Environment Atlas: access and distance to grocery stores (low-access population by income, age, vehicle access), counts and densities of grocery stores, supercenters, convenience stores, specialized food stores, SNAP- and WIC-authorized stores, fast-food and full-service restaurants, food assistance participation, farmers' markets and local food sales, and recreation and fitness facilities."
originator: USDA Economic Research Service
source_url: https://www.ers.usda.gov/data-products/food-environment-atlas/data-access-and-documentation-downloads
license: public domain
probe: "which counties have the most people with low access to a grocery store"
"""
    write("ers_fea", rows, measures, head)


# ---------------------------------------------------------------- Rural Atlas
RURAL_DROP = re.compile(
    r"^(TotalPop|POPESTIMATE|ESTIMATESBASE|TotalPopEst|NumCivLabor|NumEmployed|NumUnemployed|UnempRate"
    r"|NumCivEmployed|Ed[1-5]|PCTPOV|POV017|POVALL|MedHHInc|Median_HH_Inc_ACS|Poverty_Rate"
    r"|NumAll_inPOV|Num_inPOV|Metro|Micropolitan|Nonmetro|Noncore|RuralUrban|UrbanInfluence"
    r"|LandAreaSQMiles|PopDensity|TotalHH|TotalOccHU|NaturalChg|NaturalChange1019"
    r"|Net_InterMigration_2020|Net_International_Migration_2010|Net_Migration_2020|NetMigration1019"
    r"|Natural_Change_Rate|NaturalChangeRate|Net_InterMigrationRate|Net_International_Migration_Rate"
    r"|Net_Migration_Rate|NetMigrationRate|Pop_change_Rate_2020|PopChangeRate1019"
    r"|CivPop18ONum|CivPopVets18to64Num|CLFVets18to64Num|NonVetsDisabilty|NonVetsPoor|VetsDisabilty|VetsPoor)",
)
# People: keep percents, drop the count twin.
RURAL_COUNT_TWIN = re.compile(r"Num(2020)?$")


def rural():
    src = INC / "ers_rural_raw"
    keep, dropped = {}, defaultdict(int)
    cats = {"People": "people", "Jobs": "jobs", "Income": "income",
            "Veterans": "veterans", "CntyClass": "county classifications"}
    for r in csv.DictReader(open(src / "VariableNameLookup.csv", encoding="utf-8-sig")):
        code, name, cat = r["varShort"].strip(), r["varLong"].strip(), r["Category"].strip()
        if RURAL_DROP.match(code):
            dropped["already loaded / duplicate"] += 1; continue
        if cat == "People" and RURAL_COUNT_TWIN.search(code) and code != "Vets18ONum":
            dropped["count twin of a kept percent"] += 1; continue
        label, year = label_year(name)
        if year is None and re.search(r"(19|20)\d\d edition$", label):
            year = int(re.search(r"((?:19|20)\d\d) edition$", label).group(1))
        if year is None:
            year = {"HiAmenity": 1999, "Gas_Change": 2011, "Oil_Change": 2011,
                    "Oil_Gas_Change": 2011}.get(code)
        if year is None:
            dropped["no year"] += 1; print("  no year:", code, name); continue
        keep[code] = (year, label, name, cat)
    # Measures whose label differs only by period (five "Percent employment
    # change" codes) keep the period, or retrieval cannot tell them apart.
    seen = defaultdict(int)
    for c, (y, label, name, cat) in keep.items():
        seen[label] += 1
    for c, (y, label, name, cat) in list(keep.items()):
        text = name if seen[label] > 1 else label
        keep[c] = (y, f"{text} (USDA ERS Atlas of Rural and Small-Town America, {cats.get(cat, cat)})")
    rows = defaultdict(dict)
    for f in ("People.csv", "Jobs.csv", "Income.csv", "Veterans.csv", "CountyClassifications.csv"):
        rd = csv.reader(open(src / f, encoding=detect(src / f)))
        next(rd)
        for rec in rd:
            if len(rec) < 5:
                continue
            g, attr, val = fips5(rec[0]), rec[3].strip(), num(rec[4])
            if attr not in keep or g is None or val is None:
                continue
            rows[(g, keep[attr][0])][attr] = val
    measures = {c: (d, units_for(c)) for c, (y, d) in keep.items()}
    print("rural dropped variables:", dict(dropped))
    head = f"""# USDA ERS Atlas of Rural and Small-Town America, 2024 release.
# Prepared by etl/prep_ers_atlases.py rural: variables already loaded from the
# ERS county files (population, employment, poverty, income, education, metro
# codes) dropped as duplicates; percents kept over counts.
id: ers_rural_atlas
name: "Atlas of Rural and Small-Town America"
kind: table
level: county
geo_column: GEOID
year_column: YEAR
description: "County socioeconomic indicators from the USDA ERS Atlas of Rural and Small-Town America: race and ethnicity, age, foreign-born population by region of birth, households, home ownership, population change, employment by industry, deep poverty and per capita income, veterans (share, disability, poverty, service era), and ERS county typologies (farming-, mining-, manufacturing-, government- and recreation-dependent, retirement destination, low education, low employment, population loss, natural amenities)."
originator: USDA Economic Research Service
source_url: https://www.ers.usda.gov/data-products/atlas-of-rural-and-small-town-america/download-the-data
license: public domain
probe: "which counties are retirement destinations"
"""
    write("ers_rural_atlas", rows, measures, head)


def units_for(code: str) -> str:
    c = code.lower()
    if "pct" in c or "rate" in c or c.endswith("pct"):
        return "percent"
    if c.startswith("type_2015") or "_update" in c or c.endswith("2000") or c.endswith("2003") \
            or c in ("hiamenity", "hicreativeclass2000"):
        return "code"
    if "inc" in c:
        return "dollars"
    if c.endswith("_change"):
        return "code"  # ERS change class (0 / 2 / 9), not dollars
    if c.startswith("deep_pov"):
        return "percent"
    if c == "avghhsize":
        return "people per household"
    return "count"


if __name__ == "__main__":
    {"fea": fea, "rural": rural}[sys.argv[1]]()
