#!/usr/bin/env python3
"""
Load TIGER administrative boundaries into place_geom.

    python3 etl/load_boundaries.py --source-dir /incoming            # what it would load
    python3 etl/load_boundaries.py --source-dir /incoming --commit

WHY THIS IS NOT ingest.py

ingest.py adds a dataset to the CATALOG: one searchable attribute per column,
tagged, so a question can find it. That is right for "Fire Stations" and wrong
for these. Nobody asks "how many Census Tracts are in each county" -- they say
"in Springfield", and expect the boundary to be used as a FILTER. Loading 32,000
places x 16 columns as catalog attributes would add half a million meaningless
rows to the corpus and make retrieval worse.

So these land in one reference table, keyed on (kind, geoid), the same way
county_geom holds county boundaries. What consumes them is filter_place, not
search.

THE NESTED DIRECTORY

TIGER .gdb archives unzip to a folder containing a folder of the same name, so
the real geodatabase is at foo.gdb/foo.gdb. Opening the outer one fails with
"unable to open", which reads like a corrupt download. resolve_gdb() handles it.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg2

try:
    from osgeo import gdal, ogr
    gdal.UseExceptions()
    ogr.UseExceptions()
except ImportError:  # pragma: no cover
    sys.exit("GDAL is required; run this in the etl-geo container.")

# (gdb stem, layer, kind, what it is)
#
# Census_Tract and Block_Group are deliberately absent. They are a different
# ANALYSIS UNIT, not a place you name: "poverty by census tract" needs the whole
# (fips, value) contract to change, which is a much larger piece of work than
# filtering. They can be added here the moment that exists.
LAYERS = [
    ("tlgdb_2026_us_substategeo", "Place", "place",
     "cities, towns and villages"),
    ("tlgdb_2026_us_nationgeo", "ZIP_Code_Tabulation_Area_5_Digit_20", "zcta",
     "ZIP code tabulation areas"),
    ("tlgdb_2026_us_nationgeo", "Core_Based_Statistical_Area", "cbsa",
     "metro and micro areas"),
    ("tlgdb_2026_us_nationgeo", "Urban_Area_20", "urban",
     "urbanized areas"),
]

STAGING = "_boundary_staging"


def resolve_gdb(root: Path, stem: str) -> Path | None:
    """
    The real geodatabase, accounting for the nested-folder unzip.

    Checks root/stem.gdb/stem.gdb first, then root/stem.gdb.
    """
    outer = root / f"{stem}.gdb"
    nested = outer / f"{stem}.gdb"
    for candidate in (nested, outer):
        if candidate.is_dir() and any(candidate.glob("*.gdbtable")):
            return candidate
    return None


def layer_count(gdb: Path, layer: str) -> int | None:
    try:
        ds = ogr.Open(str(gdb))
        if ds is None:
            return None
        lyr = ds.GetLayerByName(layer)
        return lyr.GetFeatureCount() if lyr is not None else None
    finally:
        ds = None


def load_layer(gdb: Path, layer: str, kind: str, dsn: str, conn) -> int:
    """
    Stage the layer, copy the four columns place_geom needs, drop the staging.

    Reprojected to 4326: TIGER ships EPSG:4269 (NAD83), and every other geometry
    here is 4326. Mixing them would make ST_Intersects either wrong or refuse.
    """
    gdal.VectorTranslate(
        f"PG:{dsn}",
        str(gdb),
        options=gdal.VectorTranslateOptions(
            format="PostgreSQL",
            layers=[layer],
            layerName=STAGING,
            dstSRS="EPSG:4326",
            reproject=True,
            geometryType="PROMOTE_TO_MULTI",
            accessMode="overwrite",
            layerCreationOptions=["GEOMETRY_NAME=geom", "PRECISION=NO"],
        ),
    )

    with conn.cursor() as cur:
        cur.execute(f'SELECT column_name FROM information_schema.columns '
                    f"WHERE table_schema='public' AND table_name=%s", (STAGING,))
        cols = {r[0].lower() for r in cur.fetchall()}

        # TIGER suffixes columns with the census vintage on some layers:
        # Place has GEOID and NAME, while ZCTA has GEOID20 and no NAME at all
        # (the ZIP code IS the name). Hardcoding the unsuffixed spelling failed
        # on ZCTA and Urban_Area_20 with "no GEOID column".
        def first(*candidates, default="NULL"):
            for c in candidates:
                if c in cols:
                    return c
            return default

        geoid = first("geoid", "geoid20", "geoid10")
        if geoid == "NULL":
            raise SystemExit(f"  {layer}: no GEOID-like column "
                             f"(found: {', '.join(sorted(cols))})")
        # Fall back to the geoid itself: a ZCTA's name is its number.
        name = first("name", "name20", "name10", "namelsad", "namelsad20",
                     "zcta5ce20", "zcta5ce10", default=geoid)
        state_expr = first("statefp", "statefp20", "statefp10")
        aland_expr = first("aland", "aland20", "aland10")
        aland_sql = f"{aland_expr}::bigint" if aland_expr != "NULL" else "NULL"

        cur.execute(f"""
            INSERT INTO place_geom (kind, geoid, name, state_fp, aland, geom)
            SELECT %s, {geoid}, {name}, {state_expr}, {aland_sql},
                   ST_Multi(ST_MakeValid(geom))
              FROM {STAGING}
             WHERE geom IS NOT NULL AND {geoid} IS NOT NULL
            ON CONFLICT (kind, geoid) DO UPDATE
               SET name = EXCLUDED.name, state_fp = EXCLUDED.state_fp,
                   aland = EXCLUDED.aland, geom = EXCLUDED.geom
        """, (kind,))
        inserted = cur.rowcount
        cur.execute(f'DROP TABLE IF EXISTS {STAGING}')
    return inserted


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", type=Path, default=Path("/incoming"))
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--only", help="load one kind only (place, zcta, cbsa, urban)")
    args = ap.parse_args()

    dsn = (f"host={os.environ.get('PGHOST','db')} port={os.environ.get('PGPORT','5432')} "
           f"dbname={os.environ.get('PGDATABASE','mygisdb')} "
           f"user={os.environ.get('PGUSER','geoark')} "
           f"password={os.environ.get('PGPASSWORD','')}")

    wanted = [l for l in LAYERS if not args.only or l[2] == args.only]
    plan = []
    for stem, layer, kind, desc in wanted:
        gdb = resolve_gdb(args.source_dir, stem)
        if gdb is None:
            print(f"  MISSING  {kind:<7} {stem}.gdb not found under {args.source_dir}")
            continue
        n = layer_count(gdb, layer)
        if n is None:
            print(f"  MISSING  {kind:<7} no layer {layer!r} in {gdb.name}")
            continue
        print(f"  ready    {kind:<7} {n:>7,} features  {desc}")
        plan.append((gdb, layer, kind, n))

    if not plan:
        sys.exit("\n  nothing to load\n")
    if not args.commit:
        print(f"\n  {sum(p[3] for p in plan):,} boundaries would be loaded into "
              f"place_geom. Nothing written; re-run with --commit.\n")
        return 0

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    schema = Path(__file__).parent / "schema_reference.sql"
    with conn.cursor() as cur:
        cur.execute(schema.read_text())

    total = 0
    for gdb, layer, kind, _ in plan:
        print(f"\n  loading {kind} ...")
        total += load_layer(gdb, layer, kind, dsn, conn)
        print(f"  {kind}: done")

    with conn.cursor() as cur:
        cur.execute("ANALYZE place_geom")
        cur.execute("SELECT kind, count(*) FROM place_geom GROUP BY kind ORDER BY 1")
        print("\n  place_geom now holds:")
        for kind, n in cur.fetchall():
            print(f"     {n:>7,}  {kind}")
    conn.close()
    print(f"\n  {total:,} boundaries loaded. filter_place can now use them.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
