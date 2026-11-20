"""Prepare CDC county heart disease and stroke mortality (the data behind the
Interactive Atlas of Heart Disease and Stroke) for `make ingest`.

    python etl/prep_cdc_heart_stroke.py

Raw files (deploy/incoming/cdc_heart_stroke_raw/), downloaded 2026-11-20 from
data.cdc.gov (Socrata, no key):
    mri7-5jtw  Heart Disease Mortality Data Among US Adults (35+) by State/Territory and County, 2022-2024
    y5ii-knwc  Stroke Mortality Data Among US Adults (35+) by State/Territory and County, 2022-2024

Each holds one row per county x sex x race/ethnicity: an age-adjusted, spatially
smoothed, 3-year average death rate per 100,000 adults 35+. CDC's `Year` column
says 2023 (the middle year); the value is dated 2024, the END of the 3-year
window, the convention the rest of the catalog uses for ranges.

Kept: all adults; men; women; and each race/ethnicity group (both sexes). The
sex x race cross-tabulations are dropped (10 measures per topic instead of 24;
most cells are "Insufficient Data" anyway). State and national rows are dropped.
Values CDC marks "Insufficient Data" are empty in the source and stay missing.
"""
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
SRC = INC / "cdc_heart_stroke_raw"
OUT_ID = "cdc_heart_stroke"
YEAR = 2024
q = json.dumps

FILES = {"heart": ("mri7-5jtw.csv", "Heart disease"), "stroke": ("y5ii-knwc.csv", "Stroke")}
RACE = {"White": "white", "Black": "black", "Hispanic": "hispanic",
        "American Indian or Alaska Native": "aian", "Asian": "asian",
        "Native Hawaiian or Other Pacific Islander": "nhpi", "More than one race": "multiracial"}


def main():
    rows = defaultdict(dict)
    measures = {}
    for key, (fname, label) in FILES.items():
        with open(SRC / fname, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                if r["GeographicLevel"] != "County":
                    continue
                g = re.sub(r"\D", "", r["LocationID"]).zfill(5)
                sex, race = r["Stratification1"], r["Stratification2"]
                if sex == "Overall" and race == "Overall":
                    code, who = f"{key}_death_rate", "adults 35 and older"
                elif race == "Overall" and sex in ("Male", "Female"):
                    code, who = f"{key}_death_rate_{sex.lower()}", f"{'men' if sex == 'Male' else 'women'} 35 and older"
                elif sex == "Overall" and race in RACE:
                    code, who = f"{key}_death_rate_{RACE[race]}", f"{race} adults 35 and older"
                else:
                    continue
                measures[code] = (f"{label} death rate among {who}, age-adjusted, per 100,000 "
                                  f"(3-year average 2022-2024, spatially smoothed, CDC)")
                v = r["Data_Value"].strip()
                if v:
                    rows[g][code] = v
    out = INC / OUT_ID
    out.mkdir(exist_ok=True)
    codes = sorted(measures)
    with open(out / f"{OUT_ID}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["GEOID", "YEAR"] + codes)
        for g in sorted(rows):
            w.writerow([g, YEAR] + [rows[g].get(c, "") for c in codes])
    print(f"{OUT_ID}: {len(codes)} measures, {len(rows)} counties")
    lines = [
        "# CDC county heart disease and stroke mortality, adults 35+, 2022-2024 (data behind the",
        "# Interactive Atlas of Heart Disease and Stroke). Prepared by etl/prep_cdc_heart_stroke.py.",
        f"id: {OUT_ID}",
        'name: "CDC heart disease and stroke mortality"',
        "kind: table",
        "level: county",
        "geo_column: GEOID",
        "year_column: YEAR",
        "description: " + q("Age-adjusted death rates from heart disease and from stroke among adults 35 and older in each county, per 100,000, as a spatially smoothed 3-year average (2022-2024), overall and by sex and race/ethnicity. From CDC's National Vital Statistics System via the Interactive Atlas of Heart Disease and Stroke."),
        "originator: CDC Division for Heart Disease and Stroke Prevention",
        "source_url: https://www.cdc.gov/heart-disease-stroke-atlas/",
        "license: public domain",
        'probe: "which counties have the highest heart disease death rates"',
        "columns:",
    ]
    for c in codes:
        lines.append(f"  {c}: {{desc: {q(measures[c])}, units: \"deaths per 100,000\"}}")
    (out / f"{OUT_ID}.meta.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
