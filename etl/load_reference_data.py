#!/usr/bin/env python3
"""
Load the reference data the planner needs, and build the catalog->physical link.

Phase 3 could not start without this. A catalog search returns an `attr_id`; to
execute anything you must know which table and column that attribute lives in,
and nothing recorded that. `attribute_source` is the answer.

Loads:
  county_geom        3,233 county polygons (from the SPA's counties.geojson)
  acs_variables      the ACS code -> description dictionary
  acs_county_values  long-format values (wide is impossible: 3,982 ACS columns
                     exceeds Postgres' 1600-column ceiling)
  attribute_source   catalog attr_id -> physical location

Usage:
    python3 etl/load_reference_data.py --acs-csv ../geospatial_database_data/fips_merged_ACS_data.csv
    python3 etl/load_reference_data.py --dry-run     # report the join rate only
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from pathlib import Path

import psycopg2

csv.field_size_limit(10**9)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GEOJSON = ROOT / "frontend" / "public" / "counties.geojson"
DEFAULT_CATALOG = ROOT / "backend" / "geoark_attributes.csv"


def connect(args):
    return psycopg2.connect(
        host=args.host, port=args.port, dbname=args.dbname,
        user=args.user, password=args.password,
    )


def classify(code: str) -> str:
    """ACS suffix conventions: E estimate, M margin, PE/PM percent forms."""
    if code.endswith("PE"):
        return "percent"
    if code.endswith("PM"):
        return "percent_margin"
    if code.endswith("E"):
        return "estimate"
    if code.endswith("M"):
        return "margin_of_error"
    return "other"


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #

def load_counties(conn, geojson_path: Path) -> int:
    print(f"  counties: reading {geojson_path.name}")
    gj = json.loads(geojson_path.read_text())
    rows = []
    for feat in gj["features"]:
        p = feat["properties"]
        fips = (p.get("FIPS") or p.get("GEOID") or "").strip()
        if len(fips) != 5:
            continue
        rows.append((
            fips, p.get("NAME"), p.get("STATEFP"),
            p.get("ALAND"), p.get("AWATER"), json.dumps(feat["geometry"]),
        ))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE county_geom")
        cur.executemany(
            """
            INSERT INTO county_geom (fips, name, state_fp, aland, awater, geom)
            VALUES (%s, %s, %s, %s, %s,
                    -- ST_Multi normalizes Polygon and MultiPolygon into one
                    -- column type so downstream spatial ops never special-case.
                    ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)))
            ON CONFLICT (fips) DO NOTHING
            """,
            rows,
        )
    conn.commit()
    print(f"  counties: {len(rows)} loaded")
    return len(rows)


# --------------------------------------------------------------------------- #
# ACS
# --------------------------------------------------------------------------- #

def load_acs(conn, acs_csv: Path) -> tuple[int, int]:
    print(f"  acs: reading {acs_csv.name} ({acs_csv.stat().st_size / 1e6:.0f} MB)")
    fh = acs_csv.open(newline="", encoding="utf-8")
    reader = csv.reader(fh)
    header = next(reader)

    # Headers look like "S2201_C01_001E | Estimate!!Total!!Households".
    codes: list[str | None] = []
    variables: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    fips_idx = None
    for i, h in enumerate(header):
        if h.strip().upper() == "FIPS":
            fips_idx = i
            codes.append(None)
            continue
        if "|" in h:
            code, _, desc = h.partition("|")
            code, desc = code.strip(), desc.strip()
        else:
            code, desc = h.strip(), h.strip()
        if not code or code in seen:
            codes.append(None)      # skip duplicates: PK is (fips, census_code)
            continue
        seen.add(code)
        codes.append(code)
        variables.append((code, desc, classify(code)))

    if fips_idx is None:
        sys.exit("no FIPS column in the ACS csv")
    print(f"  acs: {len(variables)} distinct variables")

    with conn.cursor() as cur:
        cur.execute("TRUNCATE acs_variables")
        cur.executemany(
            "INSERT INTO acs_variables (census_code, description, kind) VALUES (%s,%s,%s)",
            variables,
        )
        conn.commit()

        # COPY through an in-memory buffer, flushed per row-block. Row-by-row
        # INSERT of ~12M values would take far longer than the whole rest of
        # this script.
        cur.execute("TRUNCATE acs_county_values")
        buf = io.StringIO()
        n_vals = n_rows = 0
        for row in reader:
            fips = row[fips_idx].strip().zfill(5)
            if len(fips) != 5:
                continue
            n_rows += 1
            for i, code in enumerate(codes):
                if code is None or i >= len(row):
                    continue
                raw = row[i].strip()
                # ACS suppression markers: -, (X), N, **, null
                if not raw or raw in {"-", "(X)", "N", "**", "null", "*"}:
                    continue
                try:
                    val = float(raw.replace(",", "").rstrip("+-"))
                except ValueError:
                    continue
                buf.write(f"{fips}\t{code}\t{val}\n")
                n_vals += 1
            if n_rows % 250 == 0:
                buf.seek(0)
                cur.copy_from(buf, "acs_county_values",
                              columns=("fips", "census_code", "value"))
                buf = io.StringIO()
                print(f"    {n_rows} counties, {n_vals:,} values", end="\r")
        buf.seek(0)
        cur.copy_from(buf, "acs_county_values",
                      columns=("fips", "census_code", "value"))
    conn.commit()
    fh.close()
    print(f"\n  acs: {n_rows} counties, {n_vals:,} values loaded")
    return len(variables), n_vals


# --------------------------------------------------------------------------- #
# the link
# --------------------------------------------------------------------------- #

def acs_codes_from_header(acs_csv: Path) -> set[str]:
    """Read just the header, so --dry-run can report the join rate without a load."""
    with acs_csv.open(newline="", encoding="utf-8") as fh:
        header = next(csv.reader(fh))
    return {h.partition("|")[0].strip() for h in header if h.strip()}


def build_attribute_source(conn, catalog_csv: Path, dry_run: bool,
                           acs_csv: Path | None = None) -> dict:
    """
    Map each catalog attribute to where its values physically live.

    ACS attributes carry the census code in `attr_orig`, which is what makes
    this join possible at all.
    """
    print(f"  link: reading {catalog_csv.name}")
    catalog = list(csv.DictReader(catalog_csv.open(encoding="utf-8")))

    with conn.cursor() as cur:
        cur.execute("SELECT census_code FROM acs_variables")
        known = {r[0] for r in cur.fetchall()}
    if not known and acs_csv:
        # Nothing loaded yet (a --dry-run before the first real load). Fall back
        # to the CSV header so the reported rate is still the true one.
        known = acs_codes_from_header(acs_csv)
        print("  link: acs_variables empty; using the CSV header for the estimate")

    resolved, unresolved = [], []
    for r in catalog:
        attr_id = (r.get("attr_label") or "").strip()
        code = (r.get("attr_orig") or "").strip()
        if not attr_id:
            continue
        if code and code in known:
            resolved.append((
                attr_id, r.get("dataset_id", ""), r.get("attr_desc", ""),
                "acs_long", "acs_county_values", None, code,
                r.get("entity_type", ""), "fips", "county_geom",
            ))
        else:
            unresolved.append((attr_id, r.get("dataset_clean", ""), code))

    stats = {
        "catalog_rows": len(catalog),
        "resolved": len(resolved),
        "unresolved": len(unresolved),
        "rate": len(resolved) / len(catalog) if catalog else 0.0,
    }

    if not dry_run:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE attribute_source")
            cur.executemany(
                """INSERT INTO attribute_source
                   (attr_id, dataset_id, description, source_kind, table_name,
                    value_column, census_code, entity_type, join_column, geom_table)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (attr_id) DO NOTHING""",
                resolved,
            )
        conn.commit()

    print(f"  link: {stats['resolved']:,} / {stats['catalog_rows']:,} "
          f"attributes resolvable ({stats['rate']:.1%})")

    by_dataset: dict[str, int] = {}
    for _, ds, _ in unresolved:
        by_dataset[ds] = by_dataset.get(ds, 0) + 1
    print("  link: largest unresolved groups (no physical table loaded yet):")
    for ds, n in sorted(by_dataset.items(), key=lambda kv: -kv[1])[:6]:
        print(f"          {n:5d}  {ds[:56] or '(blank)'}")
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("PGHOST", "localhost"))
    ap.add_argument("--port", default=os.environ.get("PGPORT", "5432"))
    ap.add_argument("--dbname", default=os.environ.get("PGDATABASE", "mygisdb"))
    ap.add_argument("--user", default=os.environ.get("PGUSER", "geoark"))
    ap.add_argument("--password", default=os.environ.get("PGPASSWORD", ""))
    ap.add_argument("--acs-csv", type=Path, required=True)
    ap.add_argument("--geojson", type=Path, default=DEFAULT_GEOJSON)
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    ap.add_argument("--schema", type=Path, default=Path(__file__).parent / "schema_reference.sql")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the catalog join rate without writing")
    args = ap.parse_args()

    conn = connect(args)
    print("connected")

    with conn.cursor() as cur:
        cur.execute(args.schema.read_text())
    conn.commit()
    print("  schema applied")

    if not args.dry_run:
        load_counties(conn, args.geojson)
        load_acs(conn, args.acs_csv)
    build_attribute_source(conn, args.catalog, args.dry_run, args.acs_csv)

    conn.close()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
