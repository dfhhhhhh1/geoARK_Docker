"""Prepare USAFacts county COVID-19 cases and deaths for `make ingest`.

    python etl/prep_usafacts_covid.py

Raw files (deploy/incoming/usafacts_covid_raw/), downloaded 2026-11-20:
    https://static.usafacts.org/public/data/covid-19/covid_confirmed_usafacts.csv
    https://static.usafacts.org/public/data/covid-19/covid_deaths_usafacts.csv

Each is one row per county with a CUMULATIVE count for every day from
2020-01-22 to 2023-07-23, when USAFacts stopped updating. The original GeoARK
table carried ~575 daily columns per file; as search entries those are 575
near-identical rows, so they are reduced to one measure per concept with the
year as a column:

  covid_cases_cumulative / covid_deaths_cumulative
      the count on 31 December of each year 2020-2022, and on 2023-07-23 (the
      last day reported) for 2023.
  covid_cases_new / covid_deaths_new
      the count added during the calendar year (31 Dec minus the previous
      31 Dec; 2020 counts from zero). 2023 is NOT given an annual value: it
      covers only half the year and would rank as a fall in cases.

Rows with countyFIPS 0 ("Statewide Unallocated") and any code that is not a
county are dropped. A negative annual change (a data correction that removed
more cases than the year added) is left blank rather than loaded as negative.
"""
import csv
import json
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
SRC = INC / "usafacts_covid_raw"
OUT_ID = "usafacts_covid"
q = json.dumps

CUTS = {2020: "2020-12-31", 2021: "2021-12-31", 2022: "2022-12-31", 2023: "2023-07-23"}


def read(fname):
    out = {}
    with open(SRC / fname, encoding="utf-8-sig", newline="") as f:
        rd = csv.reader(f)
        head = [h.strip() for h in next(rd)]
        idx = {d: head.index(d) for d in CUTS.values()}
        for r in rd:
            try:
                code = int(float(r[0]))
            except ValueError:
                continue
            g = f"{code:05d}"
            if code == 0 or g.endswith("000") or len(g) != 5:
                continue
            vals = {}
            for y, d in CUTS.items():
                s = r[idx[d]].strip()
                vals[y] = int(float(s)) if s else None
            out[g] = vals
    return out


def main():
    cases, deaths = read("covid_confirmed_usafacts.csv"), read("covid_deaths_usafacts.csv")
    out = INC / OUT_ID
    out.mkdir(exist_ok=True)
    neg = 0
    cols = ["covid_cases_cumulative", "covid_cases_new", "covid_deaths_cumulative", "covid_deaths_new"]
    with open(out / f"{OUT_ID}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["GEOID", "YEAR"] + cols)
        for g in sorted(set(cases) | set(deaths)):
            for y in CUTS:
                row = [g, y]
                for series in (cases, deaths):
                    v = series.get(g, {})
                    cum = v.get(y)
                    new = None
                    if y != 2023 and cum is not None:
                        prev = 0 if y == 2020 else v.get(y - 1)
                        if prev is not None:
                            new = cum - prev
                            if new < 0:
                                neg += 1
                                new = None
                    row += ["" if cum is None else cum, "" if new is None else new]
                w.writerow(row)
    print(f"{OUT_ID}: {len(cases)} counties (cases), {len(deaths)} (deaths); {neg} negative annual changes blanked")
    meta = f"""# USAFacts county COVID-19 cases and deaths, 2020-01-22 to 2023-07-23 (reporting ended).
# Prepared by etl/prep_usafacts_covid.py: daily cumulative columns reduced to
# year-end cumulative and annual new counts; statewide-unallocated rows dropped.
id: usafacts_covid
name: "USAFacts COVID-19 cases and deaths"
kind: table
level: county
geo_column: GEOID
year_column: YEAR
description: "Confirmed COVID-19 cases and deaths in each county from USAFacts, compiled from state and local health departments. Cumulative totals at the end of 2020, 2021 and 2022 and on 23 July 2023 (when reporting ended), and the number added in each full calendar year. Counts, not rates: divide by population to compare counties."
originator: USAFacts
source_url: https://usafacts.org/visualizations/coronavirus-covid-19-spread-map/
license: "CC BY-SA 4.0 (USAFacts)"
probe: "which counties had the most COVID-19 deaths per person"
columns:
  covid_cases_cumulative: {{desc: {q("Cumulative confirmed COVID-19 cases since January 2020, as of 31 December of the year (23 July 2023 for 2023, when reporting ended)")}, units: "cases"}}
  covid_cases_new: {{desc: {q("New confirmed COVID-19 cases reported during the calendar year (2020-2022)")}, units: "cases"}}
  covid_deaths_cumulative: {{desc: {q("Cumulative COVID-19 deaths since January 2020, as of 31 December of the year (23 July 2023 for 2023, when reporting ended)")}, units: "deaths"}}
  covid_deaths_new: {{desc: {q("COVID-19 deaths reported during the calendar year (2020-2022)")}, units: "deaths"}}
"""
    (out / f"{OUT_ID}.meta.yaml").write_text(meta, encoding="utf-8")


if __name__ == "__main__":
    main()
