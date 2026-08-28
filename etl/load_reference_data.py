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
# The recovered facility mapping, extracted from GeoARK_data/combine_csv_tags/
# attributeNew.csv and committed so the pipeline does not depend on a directory
# outside the repo. See PROVENANCE.md.
DEFAULT_FEATURE_MAP = Path(__file__).resolve().parent / "facility_table_map.csv"


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


def link_feature_tables(conn, attributes_csv: Path, catalog_csv: Path) -> dict:
    """
    Recover the catalog -> PostGIS table mapping for facility datasets.

    `merge_geospatial_attrs.py` drops "extra" columns when merging into the
    catalog schema, and `table_name` was collateral damage -- the target schema
    came from an ACS-only catalog that never had one. Without it a facility
    attribute cannot be resolved to anything physical.

    It is fully recoverable: attributeNew.csv keys on the same attr_label and
    carries table_name for all 2,305 facility rows.

    These are registered as source_kind='feature_table', NOT 'table_column'.
    They are point/polygon collections with no county key, so they only become a
    (fips, value) series through the planner's count_features op.
    """
    import csv as _csv
    _csv.field_size_limit(10**9)

    attrs = {(_r.get("attr_label") or "").strip(): _r
             for _r in _csv.DictReader(attributes_csv.open(encoding="utf-8", errors="replace"))}
    catalog = list(_csv.DictReader(catalog_csv.open(encoding="utf-8")))

    # Only map onto tables that actually exist -- a mapping to a table the
    # geospatial ETL never created would fail at execution instead of here.
    with conn.cursor() as cur:
        cur.execute("""SELECT table_name FROM information_schema.tables
                        WHERE table_schema = 'public'""")
        present = {r[0] for r in cur.fetchall()}
        cur.execute("""SELECT f_table_name, f_geometry_column, srid
                         FROM geometry_columns WHERE f_table_schema = 'public'""")
        geom_of = {r[0]: (r[1], r[2]) for r in cur.fetchall()}

    rows, missing_table, no_mapping = [], set(), 0
    for r in catalog:
        label = (r.get("attr_label") or "").strip()
        if not label or r.get("dataset_clean") in ("ACS_combined", ""):
            continue
        src = attrs.get(label)
        table = (src or {}).get("table_name", "").strip()
        if not table:
            no_mapping += 1
            continue
        if table not in present:
            missing_table.add(table)
            continue
        geom_col, srid = geom_of.get(table, ("geom", 4326))
        rows.append((label, r.get("dataset_id", ""), r.get("attr_desc", ""),
                     "feature_table", table, r.get("attr_orig", ""), None,
                     r.get("entity_type", ""), "fips", "county_geom", geom_col, srid))

    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO attribute_source
               (attr_id, dataset_id, description, source_kind, table_name,
                value_column, census_code, entity_type, join_column, geom_table,
                geom_column, srid)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (attr_id) DO NOTHING""", rows)
    conn.commit()

    stats = {"linked": len(rows), "no_mapping": no_mapping,
             "tables_not_loaded": len(missing_table)}
    print(f"  features: {len(rows):,} facility attributes linked to PostGIS tables")
    if missing_table:
        print(f"  features: {len(missing_table)} referenced table(s) are not in the "
              f"database yet -- run the geospatial ETL (make load-geo) first")
        for t in sorted(missing_table)[:4]:
            print(f"              {t[:64]}")
    if no_mapping:
        print(f"  features: {no_mapping} facility attribute(s) had no table_name in "
              f"{attributes_csv.name}")
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
    ap.add_argument("--attributes-csv", type=Path, default=DEFAULT_FEATURE_MAP,
                    help="facility attr_label -> table_name map (default: the "
                         "committed etl/facility_table_map.csv)")
    ap.add_argument("--no-features", action="store_true",
                    help="skip linking facility feature tables")
    ap.add_argument("--features-only", action="store_true",
                    help="only (re)link facility feature tables. Use after a "
                         "geospatial load: relinking should not require "
                         "reloading 10.7M ACS values.")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the catalog join rate without writing")
    args = ap.parse_args()

    conn = connect(args)
    print("connected")

    with conn.cursor() as cur:
        cur.execute(args.schema.read_text())
    conn.commit()
    print("  schema applied")

    if not args.dry_run and not args.features_only:
        load_counties(conn, args.geojson)
        load_acs(conn, args.acs_csv)
    if not args.features_only:
        build_attribute_source(conn, args.catalog, args.dry_run, args.acs_csv)

    if args.features_only:
        # Re-linking is idempotent: rows are keyed on attr_id with ON CONFLICT
        # DO NOTHING, so this only ever adds tables that have since appeared.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM attribute_source WHERE source_kind = 'feature_table'")
        conn.commit()

    if args.attributes_csv and not args.dry_run and not args.no_features:
        link_feature_tables(conn, args.attributes_csv, args.catalog)
        with conn.cursor() as cur:
            cur.execute("""SELECT source_kind, count(*) FROM attribute_source
                            GROUP BY source_kind ORDER BY 2 DESC""")
            print("\n  attribute_source by kind:")
            total = 0
            for kind, n in cur.fetchall():
                print(f"     {n:6d}  {kind}")
                total += n
            print(f"     {total:6d}  TOTAL executable")

    conn.close()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
