#!/usr/bin/env python3
"""
Load county measures from public CSV releases into the year-aware value store.

    python3 etl/load_county_values.py --source-dir /incoming            # dry run
    python3 etl/load_county_values.py --source-dir /incoming --commit

WHY THIS IS NOT A GENERIC CSV LOADER
------------------------------------
The three sources this handles are all "county CSVs" and all differently
shaped, and a loader that guessed would corrupt data rather than fail:

  USDA ERS     long, with the YEAR BURIED IN THE ATTRIBUTE NAME, in four
               different conventions across four files:
                 Civilian_labor_force_2000   POVALL_2023
                 "Less than a high school diploma, 1970"   CENSUS_2020_POP
               The FIPS column is variously FIPS_Code / FIPS Code / FIPStxt,
               and the state column State / Stabr.

  CDC PLACES   long, with an explicit Year column, and TWO rows per county and
               measure -- crude and age-adjusted prevalence. Loading both under
               one code would double every county silently.

  County       WIDE, with a TWO-ROW HEADER: row 1 is human labels ("Premature
  Health       Death raw value"), row 2 is machine codes (v001_rawvalue). Read
  Rankings     naively, row 2 becomes a data row of pure garbage.

ENCODING IS NOT UNIFORM AND FAILS LATE. Education2023.csv and
PopulationEstimates.csv are cp1252, not UTF-8, and the first bad byte is 13.5 MB
and 5.5 MB in -- "Añasco Municipio" and "Doña Ana County". Sniffing the first
chunk calls them UTF-8 and the load then dies most of the way through, or worse
survives with errors="replace" and silently mangles county names. So encoding is
detected over the WHOLE file, once, before anything is read.

ONE CATALOG ENTRY PER MEASURE, NOT PER MEASURE-YEAR. Unemployment2023.csv has
101 attribute names that are really 9 measures over 24 years. Registering 101
attributes would bloat the corpus -- which is already the limiting factor on
retrieval quality -- for no gain. The year becomes a column, not a row.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

# psycopg2 is imported lazily, inside the commit path. The catalog-only mode
# runs on the host, where the catalog file is bind-mounted read-only into the
# containers and therefore cannot be written from inside one.

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

# Years plausible in a county release. Anything outside is part of a measure
# name, not a date: "Under 18" must never be read as a year.
YEAR_RE = re.compile(r"(?<!\d)(19[5-9]\d|20[0-4]\d)(?!\d)")

# ERS also uses ACS-style RANGES -- "2008-12", "2019-23" -- for its 5-year
# estimates. Matching only the leading year left "-12" glued to the measure
# name, which split one measure into three ("Bachelor's degree or higher",
# "...-12", "...-23") with garbage labels and no way for retrieval to tell they
# were the same thing. The range is matched FIRST and dated by its END year,
# which is the convention ACS itself uses for a 5-year estimate.
YEAR_RANGE_RE = re.compile(r"(?<!\d)(19[5-9]\d|20[0-4]\d)\s*-\s*(\d{2})(?!\d)")


def year_and_measure(attr: str):
    """Split an ERS attribute name into (year, measure). None if undated."""
    m = YEAR_RANGE_RE.search(attr)
    if m:
        century = int(m.group(1)) // 100
        end = century * 100 + int(m.group(2))
        # "2019-23" is 2023, but a wrapped range like "1999-03" is 2003.
        if end < int(m.group(1)):
            end += 100
        return end, YEAR_RANGE_RE.sub("", attr).strip(" ,_-()")
    years = YEAR_RE.findall(attr)
    if not years:
        return None, attr
    return int(years[-1]), YEAR_RE.sub("", attr).replace("()", "").strip(" ,_-")

# A measure below this many counties cannot answer a national question at all.
MIN_COUNTIES = int(os.environ.get("MIN_COUNTIES", "500"))
# Below this, coverage is stated in the description rather than withheld.
PARTIAL_COUNTIES = int(os.environ.get("PARTIAL_COUNTIES", "3000"))

FIPS_KEYS = ("fips_code", "fips code", "fipstxt", "fips", "fipscode",
             "5-digit fips code", "locationid", "countyfips")
STATE_KEYS = ("state", "stabr", "state_abbr", "stateabbr")
AREA_KEYS = ("area_name", "area name", "county", "locationname", "name")


def detect_encoding(path: Path) -> str:
    """Decode the WHOLE file. A chunk is not evidence -- see the module note."""
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        # cp1252 decodes every byte, so this cannot fail later mid-load.
        return "cp1252"


def norm(s: str) -> str:
    return (s or "").strip().lower()


def pick(fieldnames, candidates):
    for want in candidates:
        for f in fieldnames:
            if norm(f) == want:
                return f
    return None


def clean_fips(raw: str) -> str | None:
    """Five digits, zero-padded. Rows for the US and for whole states are
    dropped: they are aggregates, not counties, and would sit in a county table
    looking like counties."""
    s = re.sub(r"[^0-9]", "", str(raw or ""))
    if not s:
        return None
    s = s.zfill(5)
    if len(s) != 5 or s == "00000" or s.endswith("000"):
        return None
    return s


def to_float(raw):
    s = str(raw or "").strip().replace(",", "").replace("$", "").replace("%", "")
    if s in ("", ".", "NA", "N/A", "null", "None", "*", "**"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def slug(s: str, limit: int = 44) -> str:
    out = re.sub(r"[^A-Za-z0-9]+", "_", s or "").strip("_").upper()
    return out[:limit] or "MEASURE"


# --------------------------------------------------------------------- readers
# Each yields (measure_code, measure_label, fips, year, value) and a per-source
# dataset name. They are separate functions rather than one parameterised reader
# because the three shapes share nothing but the word "county".

def read_ers(path: Path, enc: str):
    """Long, year encoded in the attribute name."""
    with path.open(encoding=enc, newline="") as fh:
        rd = csv.DictReader(fh)
        f_fips = pick(rd.fieldnames, FIPS_KEYS)
        f_attr = pick(rd.fieldnames, ("attribute",))
        f_val = pick(rd.fieldnames, ("value",))
        if not (f_fips and f_attr and f_val):
            raise ValueError(f"{path.name}: expected FIPS/Attribute/Value columns, "
                             f"got {rd.fieldnames}")
        for row in rd:
            fips = clean_fips(row[f_fips])
            if not fips:
                continue
            attr = (row[f_attr] or "").strip()
            year, measure = year_and_measure(attr)
            if year is None:
                # Undated measures exist (e.g. a 2020 census base). Skipping
                # them loses little and stamping them with a guess would be
                # inventing a date.
                continue
            # Collapse the double underscore a stripped infix year leaves
            # behind: "CENSUS_2020_POP" must not become "CENSUS__POP".
            measure = re.sub(r"[_\s]{2,}", "_", measure).strip(" ,_-")
            value = to_float(row[f_val])
            if value is None:
                continue
            yield slug(measure), measure, fips, year, value


def read_places(path: Path, enc: str):
    """Long, explicit Year, two value types per measure."""
    with path.open(encoding=enc, newline="") as fh:
        rd = csv.DictReader(fh)
        need = ("Year", "LocationID", "MeasureId", "Data_Value", "DataValueTypeID")
        if any(c not in rd.fieldnames for c in need):
            raise ValueError(f"{path.name}: not a PLACES county file")
        for row in rd:
            fips = clean_fips(row["LocationID"])
            value = to_float(row["Data_Value"])
            if not fips or value is None:
                continue
            try:
                year = int(row["Year"])
            except (TypeError, ValueError):
                continue
            # Crude and age-adjusted are DIFFERENT measures. Collapsing them
            # would put two values in one (fips, code, year) slot, and the last
            # one written would win silently.
            kind = row["DataValueTypeID"]
            code = f"PLACES_{row['MeasureId']}_{kind}"
            label = f"{row.get('Measure') or row['MeasureId']} ({'age-adjusted' if kind == 'AgeAdjPrv' else 'crude'} prevalence)"
            yield code, label, fips, year, value


def read_chr(path: Path, enc: str):
    """Wide, two-row header: labels then machine codes."""
    with path.open(encoding=enc, newline="") as fh:
        rd = csv.reader(fh)
        labels = next(rd)
        codes = next(rd)
        by_code = {norm(c): i for i, c in enumerate(codes)}
        i_fips = next((by_code[k] for k in ("fipscode", "5-digit fips code")
                       if k in by_code), None)
        i_year = by_code.get("year")
        if i_fips is None:
            raise ValueError(f"{path.name}: no fipscode column in the second header row")
        # Only the headline value per measure. The numerator, denominator,
        # confidence bounds, flags and 8 race-stratified variants would multiply
        # the corpus by ~20 for measures nobody asks for by name.
        wanted = [(i, codes[i], labels[i]) for i in range(len(codes))
                  if norm(codes[i]).endswith("_rawvalue")]
        for row in rd:
            if len(row) <= i_fips:
                continue
            fips = clean_fips(row[i_fips])
            if not fips:
                continue
            year = None
            if i_year is not None and i_year < len(row):
                ys = YEAR_RE.findall(str(row[i_year]))
                year = int(ys[-1]) if ys else None
            if year is None:
                ys = YEAR_RE.findall(path.name)
                year = int(ys[-1]) if ys else None
            if year is None:
                continue
            for i, code, label in wanted:
                if i >= len(row):
                    continue
                value = to_float(row[i])
                if value is None:
                    continue
                clean_label = re.sub(r"\s*raw value\s*$", "", label, flags=re.I).strip()
                yield f"CHR_{slug(code, 28)}", clean_label or code, fips, year, value


def classify(path: Path, enc: str):
    """Which reader a file needs, decided by its header rather than its name."""
    with path.open(encoding=enc, newline="") as fh:
        first = fh.readline()
        second = fh.readline()
    head = norm(first)
    if "measureid" in head and "datavaluetypeid" in head:
        return "places", read_places, "CDC PLACES"
    if "attribute" in head and "value" in head:
        return "ers", read_ers, "USDA ERS"
    if "rawvalue" in norm(second):
        return "chr", read_chr, "County Health Rankings"
    return None, None, None


def append_catalog(catalog: Path, measures: dict) -> int:
    """
    Add one catalog row per measure, so retrieval can find them.

    The catalog is the corpus the embedder indexes. A measure in
    attribute_source but not here resolves fine and is never retrieved, which
    looks from outside exactly like the data not being loaded.

    Two things this has to get right, both learned the hard way:
      - the file is CRLF, and rewriting it as LF changes the corpus hash, which
        silently invalidates the cached embedding matrix;
      - `tags` is load-bearing for retrieval (removing tags cost 41.7pp of
        known-item recall), so each row gets real tags rather than an empty cell.
    """
    with catalog.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        existing = {r[header.index("attr_id")] for r in reader if r}

    # COVERAGE GATE. County Health Rankings is published by the University of
    # Wisconsin and carries measures that exist only for Wisconsin -- "W-2
    # enrollment" is a Wisconsin welfare program. They look like any other
    # national measure, and a question answered with 72 of 3,221 counties is
    # the failure this project keeps finding: valid, executable, and quietly
    # answering something narrower than was asked.
    #
    # The values stay in the database; what is withheld is the CATALOG entry,
    # so retrieval can never surface them. Coverage splits cleanly -- 39
    # measures below 550 counties, 3,370 above 2,750 -- so the threshold is not
    # finely tuned and does not need to be.
    too_narrow = {c: m for c, m in measures.items()
                  if len(m.get("counties") or ()) < MIN_COUNTIES}
    if too_narrow:
        print(f"  {len(too_narrow)} measure(s) withheld from the catalog for "
              f"covering under {MIN_COUNTIES} counties:")
        for c, m in sorted(too_narrow.items(),
                           key=lambda kv: len(kv[1]["counties"]))[:6]:
            print(f"     {len(m['counties']):5d} counties  {m['label'][:48]}")

    new = {c: m for c, m in measures.items()
           if c not in existing and c not in too_narrow}
    if not new:
        return 0

    rows = []
    for code, m in sorted(new.items()):
        years = sorted(m["years"])
        words = [w.lower() for w in re.split(r"[^A-Za-z]+", m["label"]) if len(w) > 2]
        tags = sorted(set(words))[:12]
        # Partial coverage stated in the description, because a reader cannot
        # otherwise tell a national measure from one missing half the country.
        n = len(m.get("counties") or ())
        desc = m["label"]
        if n < PARTIAL_COUNTIES:
            desc = f"{desc} (covers {n:,} counties)"
        row = dict.fromkeys(header, "")
        row.update({
            "dataset_id": f"{slug(m['dataset'], 20)}_01_01",
            "dataset_clean": m["dataset"],
            "attr_label": code,
            "attr_orig": m["label"],
            "attr_desc": desc,
            "attr_id": code,
            "start_date": str(years[0]),
            "end_date": str(years[-1]),
            "entity_type": "COUNTY",
            "spatial_rep": "POLYGON",
            "tags": str(tags),
        })
        rows.append([row[c] for c in header])

    with catalog.open("a", encoding="utf-8", newline="") as fh:
        csv.writer(fh, lineterminator="\r\n").writerows(rows)
    return len(rows)


# ----------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", type=Path, required=True)
    ap.add_argument("--commit", action="store_true",
                    help="write; otherwise report what would load and stop")
    ap.add_argument("--catalog-only", action="store_true",
                    help="append to the catalog and skip the database. The "
                         "catalog is mounted read-only in the ETL containers, "
                         "so this half runs on the host.")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--catalog", type=Path,
                    help="geoark_attributes.csv to append new measures to. "
                         "Without this the measures resolve but are never "
                         "RETRIEVED: search indexes the catalog, not the "
                         "database, so an unlisted measure is invisible.")
    args = ap.parse_args()

    files = sorted(p for p in args.source_dir.iterdir()
                   if p.suffix.lower() == ".csv")
    if not files:
        print(f"no CSV files in {args.source_dir}")
        return 1

    # measure_code -> (label, dataset, set(years), row count)
    measures: dict[str, dict] = {}
    values: list[tuple] = []
    skipped: list[str] = []

    for path in files:
        enc = detect_encoding(path)
        kind, reader, dataset = classify(path, enc)
        if not kind:
            skipped.append(f"{path.name}: unrecognised shape")
            print(f"  SKIP  {path.name}  (unrecognised shape)")
            continue
        n = 0
        try:
            for code, label, fips, year, value in reader(path, enc):
                m = measures.setdefault(code, {"label": label, "dataset": dataset,
                                               "years": set(), "rows": 0,
                                               "counties": set()})
                m["years"].add(year)
                m["rows"] += 1
                m["counties"].add(fips)
                values.append((fips, code, year, value))
                n += 1
        except Exception as exc:                       # noqa: BLE001
            skipped.append(f"{path.name}: {exc}")
            print(f"  FAIL  {path.name}  {exc}")
            continue
        ys = sorted({y for c in measures.values() for y in c["years"]})
        print(f"  ok    {path.name[:52]:54s} {kind:6s} enc={enc:9s} "
              f"rows={n:>9,}")

    print(f"\n  {len(measures)} distinct measures, {len(values):,} values, "
          f"from {len(files) - len(skipped)} of {len(files)} files")
    per_ds = defaultdict(lambda: [0, set()])
    for code, m in measures.items():
        per_ds[m["dataset"]][0] += 1
        per_ds[m["dataset"]][1] |= m["years"]
    for ds, (count, years) in sorted(per_ds.items()):
        print(f"    {ds:26s} {count:4d} measures   {min(years)}-{max(years)} "
              f"({len(years)} years)")

    if args.catalog_only:
        if not args.catalog:
            print("--catalog-only needs --catalog", file=sys.stderr)
            return 2
        added = append_catalog(args.catalog, measures)
        print(f"\n  appended {added} rows to {args.catalog.name}"
              f"\n  next: make reindex, then restart the API")
        return 0

    if not args.commit:
        print("\n  dry run; nothing written. Re-run with --commit")
        return 0

    import psycopg2                                             # noqa: PLC0415
    from psycopg2.extras import execute_values                  # noqa: PLC0415

    # The ETL containers set PGHOST/PGDATABASE/PGUSER/PGPASSWORD rather than a
    # DSN, and libpq reads those itself, so connecting with no arguments is the
    # normal path here. DATABASE_URL stays supported for running this by hand.
    conn = psycopg2.connect(args.dsn) if args.dsn else psycopg2.connect()
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            # Only counties the geometry table knows about; anything else can
            # never be joined to a map and would inflate the row count while
            # answering nothing.
            cur.execute("SELECT fips FROM county_geom")
            known = {r[0].strip() for r in cur.fetchall()}
            kept = [v for v in values if v[0] in known]
            print(f"  {len(values) - len(kept):,} values dropped "
                  f"(fips not in county_geom)")

            execute_values(cur, """
                INSERT INTO acs_county_values (fips, census_code, year, value)
                VALUES %s
                ON CONFLICT (fips, census_code, year) DO UPDATE SET value = EXCLUDED.value
            """, kept, page_size=10_000)

            # Register each measure so retrieval can find it and the compiler
            # can resolve it. source_kind reuses the long-format path, which is
            # what these are -- see the note on the table's historical name.
            rows = [(code, f"{m['dataset']}::{code}", m["label"], "acs_long",
                     "acs_county_values", None, code, "COUNTY")
                    for code, m in measures.items()]
            execute_values(cur, """
                INSERT INTO attribute_source
                  (attr_id, dataset_id, description, source_kind, table_name,
                   value_column, census_code, entity_type)
                VALUES %s
                ON CONFLICT (attr_id) DO UPDATE SET
                  description = EXCLUDED.description,
                  census_code = EXCLUDED.census_code
            """, rows, page_size=1_000)
        conn.commit()
        print(f"\n  committed {len(kept):,} values and {len(rows)} attributes")
        if args.catalog:
            added = append_catalog(args.catalog, measures)
            print(f"  appended {added} rows to {args.catalog.name}"
                  f"  -> run `make reindex` and restart the API")
        else:
            print("  NOT registered for search: pass --catalog to make these "
                  "measures retrievable")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
