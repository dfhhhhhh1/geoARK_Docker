"""Prepare CDC/NCHS USALEEP tract life expectancy for `make ingest`.

US_A.CSV carries the tract id as a number with no leading zero
(`1001020100`), plus state / county / tract parts and the abridged-life-table
flag. This writes deploy/incoming/usaleep/usaleep_tract.csv with an 11-digit
GEOID and the two measures the sidecar describes, and drops rows with no
estimate. Recorded in docs/DATA_CARPENTRY.md.

    python etl/prep_usaleep.py
"""
import csv
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
SRC = INC / "CDCNCHS_USALEEP" / "US_A.CSV"
OUT = INC / "usaleep" / "usaleep_tract.csv"

OUT.parent.mkdir(parents=True, exist_ok=True)
kept = dropped = 0
with open(SRC, encoding="utf-8-sig", newline="") as f, open(OUT, "w", newline="", encoding="utf-8") as g:
    w = csv.writer(g)
    w.writerow(["GEOID", "life_expectancy", "life_expectancy_se"])
    for row in csv.DictReader(f):
        value, se = row["e(0)"].strip(), row["se(e(0))"].strip()
        if not value:
            dropped += 1
            continue
        w.writerow([row["Tract ID"].strip().zfill(11), value, se])
        kept += 1
print(f"usaleep: {kept:,} rows written, {dropped:,} without an estimate")
