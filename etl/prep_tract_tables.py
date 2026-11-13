"""Prepare three tract / block-group tables for `make ingest`.

    python etl/prep_tract_tables.py fara        # USDA Food Access Research Atlas, 2025 SRAM release
    python etl/prep_tract_tables.py ejscreen    # EPA EJScreen 2024 (v2.32), tract, national percentiles
    python etl/prep_tract_tables.py ejscreen_bg # the same, block group
    python etl/prep_tract_tables.py sld         # EPA Smart Location Database v3, block group

Each writes deploy/incoming/<folder>/<folder>.csv (GEOID + selected columns) and
a sidecar <folder>.meta.yaml, then prints min / mean / max per measure so the
`units:` written into the sidecar can be checked against the data. What was
kept, dropped and why is recorded in docs/DATA_CARPENTRY.md.

Sources are read from the folders the downloads were unpacked to; adjust the
paths at the top if yours differ. The SLD export needs GDAL, which lives in the
etl-geo container (see sld_export()); /incoming is read-only there, so the CSV
is streamed out through stdout.
"""
import csv
import json
import statistics
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INC = ROOT / "deploy" / "incoming"
q = json.dumps


def dec(line):
    """Federal CSVs are a mix of UTF-8 and cp1252 (Dona Ana's n-tilde); county names are not kept."""
    try:
        return line.decode("utf-8-sig")
    except UnicodeDecodeError:
        return line.decode("cp1252")


def write_sidecar(folder, head, columns, probe):
    cols = "\n".join(f"  {k}: {{desc: {q(d)}, units: {q(u)}}}" for k, (d, u) in columns.items())
    (INC / folder / f"{folder}.meta.yaml").write_text(
        head.rstrip() + f"\ncolumns:\n{cols}\nprobe: {q(probe)}\n", encoding="utf-8")


def write_table(folder, rows_iter, geo_col, keep, geo_len, drop_label):
    """rows_iter yields dicts. Writes GEOID + keep; returns stats for printing."""
    out = INC / folder / f"{folder}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    vals = {k: [] for k in keep}
    n = dropped = 0
    with open(out, "w", newline="", encoding="utf-8") as g:
        w = csv.writer(g)
        w.writerow(["GEOID"] + keep)
        for row in rows_iter:
            gid = (row.get(geo_col) or "").strip()
            if len(gid) != geo_len:
                dropped += 1
                continue
            rec = []
            for k in keep:
                v = (row.get(k) or "").strip()
                try:
                    vals[k].append(float(v))
                except ValueError:
                    v = ""
                rec.append(v)
            w.writerow([gid] + rec)
            n += 1
    print(f"{folder}: {n:,} rows written, {dropped:,} dropped ({drop_label})")
    for k in keep:
        v = vals[k]
        if v:
            print(f"   {k:34s} n={len(v):>7,} min={min(v):<12.4g} mean={statistics.fmean(v):<12.4g} max={max(v):.4g}")
        else:
            print(f"   {k:34s} NO NUMERIC VALUES")


# ---------------------------------------------------------------- FARA (tract, 2020 boundaries)
FARA_ZIP = INC / "FARA" / "2025-sram-fara-data.zip"
FARA_GENERAL = {  # field -> (description, units), from the release's variable lookup
    "Urban": ("Urban tract flag (1 = urban)", "flag 1/0"),
    "LowIncomeTracts": ("Low income tract flag (1 = low income tract)", "flag 1/0"),
    "TractLOWI": ("Low-income population of the tract, number", "persons"),
    "TractKids": ("Children age 0-17 in the tract, number", "persons"),
    "TractSeniors": ("Seniors age 65 and older in the tract, number", "persons"),
    "TractHUNV": ("Housing units without a vehicle in the tract, number", "housing units"),
    "TractSNAP": ("Housing units receiving SNAP benefits in the tract, number", "housing units"),
    "TractVeteran": ("Veteran population of the tract, number", "persons"),
}
# the driving-distance variables kept; descriptions come from the lookup's LongName
FARA_DD = ["LILATracts_1And10", "LILATracts_halfAnd10", "LILATracts_1And20", "LILATracts_Vehicle",
           "HUNVFlag", "LA1and10", "LATracts_half", "LATracts1", "LATracts10", "LATracts20",
           "LATractsVehicle_20", "LAPOP1_10", "LAPOP1_20", "LALOWI1_10", "lapophalf", "lapophalfshare",
           "lalowihalf", "lalowihalfshare", "lakidshalfshare", "laseniorshalfshare"]
FARA_DD_FLAGS = {"LILATracts_1And10", "LILATracts_halfAnd10", "LILATracts_1And20", "LILATracts_Vehicle",
                 "HUNVFlag", "LA1and10", "LATracts_half", "LATracts1", "LATracts10", "LATracts20",
                 "LATractsVehicle_20"}
FARA_SD = ["LILATracts_1And10", "LILATracts_Vehicle", "LATracts1"]  # straight-line, flags only


def fara():
    folder = "usda_fara"
    z = zipfile.ZipFile(FARA_ZIP)

    def read(name):
        with z.open(name) as f:
            return list(csv.DictReader((dec(l) for l in f)))

    # the General Tract file drops the leading zero for states 01-09 (10 digits); the others do not
    gen = {r["CensusTract20"].strip().zfill(11): r for r in read("SRAM General Tract Characteristics Data.csv")}
    dd = {r["CensusTract20"].strip(): r for r in read("SRAM Driving Distance Data.csv")}
    sd = {r["CensusTract20"].strip(): r for r in read("SRAM Straight Line Distance Data.csv")}
    lk = {r["Field"]: r["LongName"] for r in read("SRAM Variable Lookup Driving Distance.csv")}
    lks = {r["Field"]: r["LongName"] for r in read("SRAM Variable Lookup Straight Line Distance.csv")}

    cols, keep = {}, []
    for k, (d, u) in FARA_GENERAL.items():
        cols[k] = (d, u)
    for k in FARA_DD:
        name = f"DD_SRAM_{k}"
        flag = k in FARA_DD_FLAGS
        cols[name] = (lk[name].rstrip(". ") + ".", "flag 1/0" if flag else ("percent" if k.endswith("share") else "persons"))
    for k in FARA_SD:
        name = f"SD_SRAM_{k}"
        cols[name] = (lks[name].rstrip(". ") + ".", "flag 1/0")
    keep = list(cols)

    def rows():
        for gid in gen:
            r = {"GEOID": gid}
            r.update(gen[gid])
            r.update(dd.get(gid, {}))
            r.update(sd.get(gid, {}))
            yield r

    write_table(folder, rows(), "GEOID", keep, 11, "non-11-digit ids")
    write_sidecar(folder, f"""# USDA ERS Food Access Research Atlas, SNAP-authorized Retailer Access Map (SRAM) release, July 2026.
# Prepared by etl/prep_tract_tables.py fara: three tract tables joined on CensusTract20, selected columns only.
id: usda_fara
name: "USDA Food Access Research Atlas"
kind: table
level: tract
geo_column: GEOID
vintage: 2025
description: "Food access for every 2020 census tract: low-income and low-access (food desert) flags measured by driving distance and straight-line distance to a SNAP-authorized retailer, vehicle access, and the low-access population. Distances are to SNAP-authorized retailers, not only supermarkets."
originator: USDA Economic Research Service
source_url: https://www.ers.usda.gov/data-products/food-access-research-atlas/
license: public domain""", cols, "which census tracts are low-income and low-access food deserts")


# ---------------------------------------------------------------- EJScreen 2024 v2.32 (tract)
EJ_ZIP = INC / "epa_ejscreen/2024/2024/2.32_August_UseMe/EJScreen_2024_Tract_with_AS_CNMI_GU_VI.csv.zip"
EJ = {
    "PM25": ("Annual average fine particulate matter (PM2.5) concentration", "micrograms per cubic meter"),
    "OZONE": ("Summer seasonal average of daily maximum 8-hour ozone concentration", "parts per billion"),
    "DSLPM": ("Diesel particulate matter concentration in air", "micrograms per cubic meter"),
    "RSEI_AIR": ("Toxic releases to air: modeled toxicity-weighted concentration (EPA RSEI)", "toxicity-weighted concentration"),
    "PTRAF": ("Traffic proximity and volume: count of vehicles per day at major roads divided by distance", "vehicles per day per meter"),
    "PRE1960PCT": ("Lead paint indicator: share of housing units built before 1960", "share 0-1"),
    "PNPL": ("Proximity to Superfund National Priorities List sites: count of sites within 5 km weighted by distance", "sites per kilometer"),
    "PRMP": ("Proximity to Risk Management Plan facilities: count within 5 km weighted by distance", "facilities per kilometer"),
    "PTSDF": ("Proximity to hazardous waste facilities (TSDFs): count within 5 km weighted by distance", "facilities per kilometer"),
    "UST": ("Underground storage tanks and leaking tanks: weighted count within 1,500 feet", "tanks per square kilometer"),
    "PWDIS": ("Wastewater discharge: toxicity-weighted concentration in stream segments within 500 meters", "toxicity-weighted concentration"),
    "NO2": ("Annual average nitrogen dioxide (NO2) concentration", "parts per billion"),
    "DWATER": ("Drinking water non-compliance: weighted violations of drinking water standards", "score"),
    "PEOPCOLORPCT": ("Share of residents who are people of color", "share 0-1"),
    "LOWINCPCT": ("Share of residents with household income under twice the poverty level (low income)", "share 0-1"),
    "UNEMPPCT": ("Unemployment rate", "share 0-1"),
    "DISABILITYPCT": ("Share of civilian non-institutionalized persons with a disability", "share 0-1"),
    "LINGISOPCT": ("Share of households that are linguistically isolated (limited English speaking)", "share 0-1"),
    "LESSHSPCT": ("Share of adults 25 and older without a high school diploma", "share 0-1"),
    "UNDER5PCT": ("Share of residents under age 5", "share 0-1"),
    "OVER64PCT": ("Share of residents over age 64", "share 0-1"),
    "LIFEEXPPCT": ("Share low life expectancy: relative life expectancy indicator (higher means shorter life expectancy)", "share 0-1"),
    "DEMOGIDX_2": ("EJScreen Demographic Index: average of the low-income and people-of-color shares", "index"),
    "DEMOGIDX_5": ("EJScreen Supplemental Demographic Index: average of five demographic indicators", "index"),
}
EJ_D2 = {"PM25": "fine particulate matter (PM2.5)", "OZONE": "ozone", "DSLPM": "diesel particulate matter",
         "RSEI_AIR": "toxic releases to air", "PTRAF": "traffic proximity", "LDPNT": "lead paint",
         "PNPL": "Superfund proximity", "PRMP": "Risk Management Plan facility proximity",
         "PTSDF": "hazardous waste proximity", "UST": "underground storage tanks",
         "PWDIS": "wastewater discharge", "NO2": "nitrogen dioxide (NO2)", "DWATER": "drinking water non-compliance"}


EJ_ZIP_BG = INC / "epa_ejscreen/2024/2024/2.32_August_UseMe/EJSCREEN_2024_BG_with_AS_CNMI_GU_VI.csv.zip"


def ejscreen(bg=False):
    folder = "epa_ejscreen_bg" if bg else "epa_ejscreen_tract"
    cols = dict(EJ)
    for k, label in EJ_D2.items():
        cols[f"D2_{k}"] = (f"EJScreen environmental justice index for {label}: Demographic Index times the national percentile of the indicator", "index")
    keep = list(cols)
    z = zipfile.ZipFile(EJ_ZIP_BG if bg else EJ_ZIP)
    with z.open(z.namelist()[0]) as f:
        rows = list(csv.DictReader((dec(l) for l in f)))
    write_table(folder, iter(rows), "ID", keep, 12 if bg else 11, "territory units (AS, GU, MP, VI)")
    write_sidecar(folder, """# EPA EJScreen 2024 (version 2.32, August 2024), {level_word} level, national percentile file.
# EPA removed EJScreen from its site in 2025; this is the archived release.
# Prepared by etl/prep_tract_tables.py ejscreen: ID written as GEOID, 11-digit rows only, selected columns only.
id: epa_ejscreen
name: "EPA EJScreen"
kind: table
level: tract
geo_column: GEOID
vintage: 2024
description: "Environmental justice screening for every census tract: air pollution (PM2.5, ozone, diesel, NO2), traffic, toxic releases, proximity to Superfund sites and hazardous waste facilities, lead paint, wastewater and drinking water violations, demographic indicators, and the EJ indexes that combine them."
originator: US EPA Office of Environmental Justice and External Civil Rights
source_url: https://www.epa.gov/ejscreen
license: public domain""".replace("{level_word}", "block group" if bg else "tract").replace("level: tract", "level: bg" if bg else "level: tract")
        .replace("11-digit rows only", "12-digit rows only" if bg else "11-digit rows only")
        .replace("for every census tract", "for every census block group" if bg else "for every census tract"), cols,
        "which block groups have the highest air pollution and the most low-income residents" if bg else
        "which census tracts have the highest air pollution and the most low-income residents")


# ---------------------------------------------------------------- SLD v3 (block group)
SLD_GDB = "/incoming/epa_smart_location/SmartLocationDatabase.gdb"
SLD = {
    "NatWalkInd": ("National Walkability Index score: 1 (least walkable) to 20 (most walkable)", "score 1-20"),
    "D1A": ("Gross residential density: housing units per acre on unprotected land", "housing units per acre"),
    "D1C": ("Gross employment density: jobs per acre on unprotected land", "jobs per acre"),
    "D1D": ("Gross activity density: jobs plus housing units per acre on unprotected land", "per acre"),
    "D2A_JPHH": ("Jobs per household", "jobs per household"),
    "D2A_EPHHM": ("Employment and household entropy: mix of jobs and housing, 0 (single use) to 1 (balanced)", "index 0-1"),
    "D2B_E8MIXA": ("Employment entropy: diversity of eight job types, 0 to 1", "index 0-1"),
    "D3A": ("Total road network density: miles of road facility per square mile", "miles per square mile"),
    "D3AAO": ("Auto-oriented road network density: miles of auto-oriented links per square mile", "miles per square mile"),
    "D3APO": ("Pedestrian-oriented network density: miles of pedestrian-oriented links per square mile", "miles per square mile"),
    "D3B": ("Street intersection density, auto-oriented intersections excluded", "intersections per square mile"),
    "D4A": ("Distance from the population-weighted center of the block group to the nearest transit stop", "meters"),
    "D4B025": ("Proportion of employment within one quarter mile of a fixed-guideway transit stop", "share 0-1"),
    "D4B050": ("Proportion of employment within one half mile of a fixed-guideway transit stop", "share 0-1"),
    "D4C": ("Aggregate frequency of transit service within 0.25 miles of the block group, per hour during the evening peak", "trips per hour"),
    "D4D": ("Aggregate frequency of transit service per square mile", "trips per hour per square mile"),
    "D4E": ("Aggregate frequency of transit service per capita", "trips per hour per person"),
    "D5AR": ("Jobs within 45 minutes by car, weighted by travel time", "jobs"),
    "D5BR": ("Jobs within a 45-minute transit commute, weighted by distance", "jobs"),
    "D5CR": ("Regional accessibility by car: employment access as a share of total metro area accessibility", "ratio"),
    "D5DR": ("Regional accessibility by transit: employment access as a share of total metro area accessibility", "ratio"),
    "Pct_AO0": ("Share of households that own no automobile, 2018", "share 0-1"),
    "R_PCTLOWWAGE": ("Share of workers living in the block group who are low wage (earning $1,250 a month or less), 2017", "share 0-1"),
    "E_PctLowWage": ("Share of jobs in the block group that are low wage, 2017", "share 0-1"),
    "P_WrkAge": ("Share of the population of working age, 18 to 64", "share 0-1"),
    "TotEmp": ("Total employment: number of jobs in the block group, 2017", "jobs"),
    "E8_Hlth": ("Number of health care jobs in the block group (8-tier job classification)", "jobs"),
    "E8_Ed": ("Number of education jobs in the block group (8-tier job classification)", "jobs"),
    "E8_Ret": ("Number of retail jobs in the block group (8-tier job classification)", "jobs"),
    "E8_Ind": ("Number of industrial jobs in the block group (8-tier job classification)", "jobs"),
    "E8_off": ("Number of office jobs in the block group (8-tier job classification)", "jobs"),
    "VMT_per_worker": ("Mean total work-related vehicle miles traveled per worker per day, by workplace block group", "miles per day"),
    "Com_VMT_Per_Worker": ("Mean commute vehicle miles traveled per worker per day, by workplace block group", "miles per day"),
    "NonCom_VMT_Per_Worker": ("Mean non-commute vehicle miles traveled per worker per day, by workplace block group", "miles per day"),
    "GHG_per_worker": ("Estimated average daily greenhouse gas emissions generated by a worker at the workplace block group", "daily emissions (units per EPA SLD documentation)"),
    "Annual_GHG": ("Estimated annual greenhouse gas emissions generated by a worker (260 days) at the workplace block group", "annual emissions (units per EPA SLD documentation)"),
}


def sld_export():
    """Stream the selected fields from the geodatabase to a raw CSV (GDAL is in etl-geo)."""
    out = INC / "_raw" / "sld_raw_export.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    select = ",".join(["GEOID20"] + list(SLD))
    with open(out, "wb") as f:
        subprocess.run(
            ["docker", "compose", "--profile", "etl", "run", "--rm", "-T", "--entrypoint", "ogr2ogr", "etl-geo",
             "-f", "CSV", "/vsistdout/", SLD_GDB, "EPA_SLD_Database_V3", "-select", select],
            cwd=ROOT / "deploy", stdout=f, stderr=subprocess.DEVNULL, check=True,
            env={**__import__("os").environ, "MSYS_NO_PATHCONV": "1"})
    return out


def sld():
    folder = "epa_sld_bg"
    raw = INC / "_raw" / "sld_raw_export.csv"
    if not raw.exists() or "--export" in sys.argv:
        raw = sld_export()
    with open(raw, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    keep = list(SLD)
    # SLD uses -99999 for "no data"
    for r in rows:
        for k in keep:
            if r.get(k) in ("-99999", "-99999.0"):
                r[k] = ""
    write_table(folder, iter(rows), "GEOID20", keep, 12, "non-12-digit ids")
    write_sidecar(folder, """# EPA Smart Location Database version 3.0 (block groups, 2018-2020 sources). EPA's
# SLD geodatabase field list supplied the descriptions. Prepared by etl/prep_tract_tables.py sld:
# selected fields exported with ogr2ogr, GEOID20 used as GEOID, -99999 treated as missing.
id: epa_sld
name: "EPA Smart Location Database"
kind: table
level: bg
geo_column: GEOID
vintage: 2018
description: "Built-environment measures for every census block group: walkability index, residential and employment density, street network density, transit access and frequency, job accessibility by car and transit, car ownership, and work-related vehicle travel and greenhouse gas emissions per worker."
originator: US EPA Smart Location Mapping
source_url: https://www.epa.gov/smartgrowth/smart-location-mapping
license: public domain""", SLD, "which block groups are the most walkable")


if __name__ == "__main__":
    which = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not which:
        sys.exit(__doc__)
    for w in which:
        {"fara": fara, "ejscreen": ejscreen, "ejscreen_bg": lambda: ejscreen(bg=True), "sld": sld}[w]()
