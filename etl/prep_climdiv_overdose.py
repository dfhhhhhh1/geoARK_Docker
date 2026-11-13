"""Prepare NOAA nClimDiv county climate and CDC VSRR county overdose deaths for `make ingest`.

    python etl/prep_climdiv_overdose.py climdiv
    python etl/prep_climdiv_overdose.py overdose

Both write deploy/incoming/<id>/<id>.csv (GEOID, YEAR, measures) and a sidecar.
What was kept, dropped and why is in docs/DATA_CARPENTRY.md.

climdiv: the county files are fixed width, one row per (county, element, year)
with 12 monthly values (format in county-readme.txt). The first two characters
are NOAA's OWN state code (01 Alabama, 02 Arizona ... 49 Hawaii, 50 Alaska), not
the FIPS code, so they are mapped by state name. A year is kept only if all 12
months are present (the latest year is partial). Annual values: precipitation
and degree days are summed, temperatures and the Palmer Drought Severity Index
are averaged. The "normal" measures are 1991-2020 averages of the annual values
computed HERE; the normals files in the download were not used because their
layout is undocumented in the files supplied (the normals readme was not
downloaded).

overdose: 12-month-ending provisional counts, one row per county and month. The
December rows are the calendar-year counts and are the only ones kept. Counts
carry thousands commas ("1,308"), which a numeric loader would skip silently.
Counts of 1-9 are suppressed by NCHS, so small counties are missing.
"""
import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
q = json.dumps

# NOAA state code (county-readme.txt) -> FIPS. NOAA's order is alphabetical, FIPS's is not.
NOAA_TO_FIPS = {
    1: "01", 2: "04", 3: "05", 4: "06", 5: "08", 6: "09", 7: "10", 8: "12", 9: "13", 10: "16",
    11: "17", 12: "18", 13: "19", 14: "20", 15: "21", 16: "22", 17: "23", 18: "24", 19: "25",
    20: "26", 21: "27", 22: "28", 23: "29", 24: "30", 25: "31", 26: "32", 27: "33", 28: "34",
    29: "35", 30: "36", 31: "37", 32: "38", 33: "39", 34: "40", 35: "41", 36: "42", 37: "44",
    38: "45", 39: "46", 40: "47", 41: "48", 42: "49", 43: "50", 44: "51", 45: "53", 46: "54",
    47: "55", 48: "56", 49: "15", 50: "02",
}
SRC = INC / "climdiv"
FILES = {  # measure -> (file prefix, how to make the year, description, units)
    "precip_annual_in": ("climdiv-pcpncy", "sum", "Total annual precipitation: all rain plus the water in melted snow, in inches of water. It is not a measure of snowfall depth or of snow days", "inches"),
    "temp_avg_f": ("climdiv-tmpccy", "mean", "Average annual temperature", "degrees Fahrenheit"),
    "temp_max_avg_f": ("climdiv-tmaxcy", "mean", "Average annual daily maximum temperature", "degrees Fahrenheit"),
    "temp_min_avg_f": ("climdiv-tmincy", "mean", "Average annual daily minimum temperature", "degrees Fahrenheit"),
    "heating_degree_days": ("climdiv-hddccy", "sum", "Annual heating degree days (a measure of how cold the year was; higher means more heating needed)", "degree days"),
    "cooling_degree_days": ("climdiv-cddccy", "sum", "Annual cooling degree days (a measure of how hot the year was; higher means more cooling needed)", "degree days"),
    "pdsi_avg": ("climdiv-pdsicy", "mean", "Average annual Palmer Drought Severity Index (negative is drought, positive is wet)", "index"),
}
NORMALS = {  # measure -> source measure, 1991-2020 average of the annual values
    "precip_normal_1991_2020": ("precip_annual_in", "Average annual precipitation, 1991-2020 (rainfall normal): all rain plus the water in melted snow. Not a measure of snowfall depth", "inches"),
    "temp_normal_1991_2020": ("temp_avg_f", "Average annual temperature, 1991-2020 (temperature normal)", "degrees Fahrenheit"),
    "hdd_normal_1991_2020": ("heating_degree_days", "Average annual heating degree days, 1991-2020", "degree days"),
    "cdd_normal_1991_2020": ("cooling_degree_days", "Average annual cooling degree days, 1991-2020", "degree days"),
}


def read_file(prefix):
    path = next(SRC.glob(f"{prefix}-v*"), None)
    if path is None:
        sys.exit(f"no file {prefix}-v* in {SRC}")
    out = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if len(line) < 95:
            continue
        st, cty, year = int(line[0:2]), line[2:5], int(line[7:11])
        if st not in NOAA_TO_FIPS:
            continue
        vals = [float(line[11 + 7 * i: 18 + 7 * i]) for i in range(12)]
        out[(NOAA_TO_FIPS[st] + cty, year)] = vals
    return out


def climdiv():
    folder = "noaa_climdiv_county"
    annual, dropped = defaultdict(dict), defaultdict(int)
    for measure, (prefix, how, _, _) in FILES.items():
        for (geoid, year), vals in read_file(prefix).items():
            if any(v <= -9.99 for v in vals):  # -99.99 temperature / -9.99 precipitation = missing
                dropped[measure] += 1
                continue
            annual[(geoid, year)][measure] = round(sum(vals) if how == "sum" else statistics.fmean(vals), 3)
    keys = sorted(annual)
    # 1991-2020 normals, only where all 30 years exist, written on the 2020 row
    norm = {}
    for nm, (src, _, _) in NORMALS.items():
        by = defaultdict(dict)
        for (g, y), d in annual.items():
            if 1991 <= y <= 2020 and src in d:
                by[g][y] = d[src]
        for g, ys in by.items():
            if len(ys) == 30:
                norm[(g, nm)] = round(statistics.fmean(ys.values()), 3)
    cols = list(FILES) + list(NORMALS)
    out = INC / folder / f"{folder}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["GEOID", "YEAR"] + cols)
        for g, y in keys:
            d = annual[(g, y)]
            row = [d.get(m, "") for m in FILES]
            row += [norm.get((g, nm), "") if y == 2020 else "" for nm in NORMALS]
            w.writerow([g, y] + row)
    counties = {g for g, _ in keys}
    print(f"{folder}: {len(keys):,} county-year rows, {len(counties):,} counties, years {keys[0][1]}-{keys[-1][1]}")
    print(f"   months missing (rows dropped): {dict(dropped)}")
    print(f"   normals: {len({g for g, _ in norm}):,} counties with a complete 1991-2020")
    for m in FILES:
        v = [d[m] for d in annual.values() if m in d]
        print(f"   {m:22s} n={len(v):>7,} min={min(v):<9.4g} mean={statistics.fmean(v):<9.4g} max={max(v):.4g}")
    cols_yaml = {m: (d, u) for m, (_, _, d, u) in FILES.items()}
    cols_yaml.update({m: (d, u) for m, (_, d, u) in NORMALS.items()})
    sidecar(folder, f"""# NOAA NCEI nClimDiv county temperature, precipitation, degree days and Palmer Drought Severity Index.
# Prepared by etl/prep_climdiv_overdose.py climdiv: fixed-width monthly files reshaped to annual values per
# county and year; NOAA state codes mapped to FIPS; years with any missing month dropped.
id: noaa_climdiv
name: "NOAA nClimDiv county climate"
kind: table
level: county
geo_column: GEOID
year_column: YEAR
description: "Annual precipitation (rainfall), temperature, heating and cooling degree days and drought index for each county, 1895 to the latest complete year, from NOAA's nClimDiv county dataset (grid-based, area-weighted). Covers all 50 states. The 1991-2020 normals are averages computed from the annual values."
originator: NOAA National Centers for Environmental Information
source_url: https://www.ncei.noaa.gov/products/land-based-station/nclimdiv
license: public domain""", cols_yaml, "which counties get the most rainfall")


def overdose():
    folder = "cdc_overdose_county"
    src = INC / "vsrr_cdc_overdose" / "VSRR_Provisional_County-Level_Drug_Overdose_Death_Counts_20261112.csv"
    # Some FIPS codes appear on two rows (Alleghany VA with the former city of Clifton Forge, merged
    # 2001; Bedford VA with Bedford city, merged 2013). They are one county now: sum the counts when
    # both are published, leave blank when either is suppressed (the total is then unknown).
    groups = defaultdict(list)
    with open(src, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if r["Month"].strip() != "12":
                continue
            raw = r["Provisional Drug Overdose Deaths"].replace(",", "").strip()
            groups[(r["FIPS"].strip().zfill(5), r["Year"].strip())].append(
                (raw, r["Percentage Of Records Pending Investigation"].strip()))
    rows, suppressed, kept, merged = [], 0, 0, 0
    for (fips, year), parts in sorted(groups.items()):
        if len(parts) > 1:
            merged += 1
        counts = [p[0] for p in parts]
        total = "" if any(c == "" for c in counts) else f"{sum(float(c) for c in counts):g}"
        pend = next((p[1] for p in parts if p[1]), "")
        if total == "":
            suppressed += 1
        else:
            kept += 1
        rows.append([fips, year, total, pend])
    out = INC / folder / f"{folder}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["GEOID", "YEAR", "overdose_deaths", "overdose_pct_pending"])
        w.writerows(rows)
    vals = [float(r[2]) for r in rows if r[2]]
    by_year = defaultdict(int)
    for r in rows:
        if r[2]:
            by_year[r[1]] += 1
    print(f"{folder}: {len(rows):,} county-year rows (December 12-month-ending), {kept:,} with a count, {suppressed:,} suppressed or blank, {merged} merged duplicate-FIPS rows")
    print(f"   counties with a count by year: {dict(sorted(by_year.items()))}")
    print(f"   deaths: n={len(vals):,} min={min(vals):g} mean={statistics.fmean(vals):.1f} max={max(vals):g}")
    sidecar(folder, """# CDC NCHS VSRR provisional county-level drug overdose death counts (12-month ending).
# Prepared by etl/prep_climdiv_overdose.py overdose: December rows only (calendar-year counts), thousands
# commas removed, FIPS padded to 5 digits. 2026 is partial and was not loaded. Rows sharing a FIPS
# code (merged VA cities) are combined.
id: cdc_overdose
name: "CDC provisional drug overdose deaths"
kind: table
level: county
geo_column: GEOID
year_column: YEAR
description: "Provisional counts of drug overdose deaths in each county for each calendar year, from CDC NCHS Vital Statistics Rapid Release. Counties with fewer than 10 deaths are suppressed, so small counties are missing and a ranking covers larger counties only. Counts, not rates: divide by population to compare counties."
originator: CDC National Center for Health Statistics
source_url: https://data.cdc.gov/NCHS/VSRR-Provisional-County-Level-Drug-Overdose-Death-Counts
license: public domain""", {
        "overdose_deaths": ("Provisional drug overdose deaths in the calendar year (12 months ending December); counts under 10 are suppressed", "deaths"),
        "overdose_pct_pending": ("Percent of overdose death records still pending investigation, so the count may be incomplete", "percent"),
    }, "which counties have the most drug overdose deaths")


def sidecar(folder, head, columns, probe):
    cols = "\n".join(f"  {k}: {{desc: {q(d)}, units: {q(u)}}}" for k, (d, u) in columns.items())
    (INC / folder / f"{folder}.meta.yaml").write_text(
        head.rstrip() + f"\ncolumns:\n{cols}\nprobe: {q(probe)}\n", encoding="utf-8")


if __name__ == "__main__":
    which = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not which:
        sys.exit(__doc__)
    for w in which:
        {"climdiv": climdiv, "overdose": overdose}[w]()
