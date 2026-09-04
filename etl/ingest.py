#!/usr/bin/env python3
"""
Ingest one dataset, end to end.

    # inspect and show what would happen, changing nothing
    python3 etl/ingest.py --file /data/incoming/hydrants.geojson --name "Fire Hydrants"

    # do it
    python3 etl/ingest.py --file /data/incoming/hydrants.geojson --name "Fire Hydrants" --commit

WHY THIS EXISTS

Adding a dataset used to mean: drop the file somewhere, hand-edit
backend/geoark_attributes.csv with one row per column, hand-edit
etl/facility_table_map.csv to match, run a 70-minute `make load-geo` that
rescans everything, relink, re-embed. Every step was manual and the two CSVs
had to agree exactly or the attribute resolved to nothing.

This does the whole thing for one file and refuses clearly when it cannot.

WHAT IT WILL NOT DO

Rasters. See check_raster() for the specific reason and what it would take.

THE PART THAT IS EASY TO GET WRONG

Tags. They are 38% of the embedded text and worth 41.7pp of known-item
recall@1 (etl/PROVENANCE.md). A dataset ingested without them, or with tags
from a different model, is searchable but measurably worse, and nothing about
the failure is visible. So tags are generated here with the model, prompt and
parameters PROVENANCE.md records, and ingest refuses to commit if the tagger
is unreachable rather than quietly writing empty tags.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

try:
    from osgeo import gdal, ogr, osr
    gdal.UseExceptions()
    ogr.UseExceptions()
except ImportError:  # pragma: no cover
    sys.exit("GDAL is required. Run this in the etl-geo container: "
             "docker compose --profile etl run --rm etl-geo python3 /app/etl/ingest.py ...")

CATALOG = Path(os.environ.get("CATALOG_CSV", "/app/backend/geoark_attributes.csv"))
FEATURE_MAP = Path(os.environ.get("FEATURE_MAP_CSV", "/app/etl/facility_table_map.csv"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
TAG_MODEL = os.environ.get("TAG_MODEL", "gemma3:4b")

CATALOG_COLUMNS = [
    "dataset_id", "dataset_clean", "attr_label", "attr_orig", "attr_desc",
    "attr_id", "start_date", "end_date", "attr_dtype", "iso_key", "iso_key_add",
    "scale", "positional_accuracy", "spatial_rep", "datum", "coordinate_system",
    "entity_type", "tags", "originator_id",
]

# Columns that carry no meaning for a reader and should not become searchable
# attributes: internal ids, geometry duplicates, and the shapefile bookkeeping
# that ogr2ogr brings along.
SKIP_COLUMNS = {
    "ogc_fid", "gid", "fid", "objectid", "shape_leng", "shape_length",
    "shape_area", "geom", "geometry", "wkb_geometry", "the_geom",
}

SAFE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


# --------------------------------------------------------------------------- #
# inspection
# --------------------------------------------------------------------------- #

def check_raster(path: Path) -> None:
    """
    Refuse rasters, with the reason rather than a stack trace.

    Everything downstream assumes vector: attribute_source maps an attribute to
    a COLUMN, the ops compose over (fips, value), and the compiler emits
    ST_Intersects and ST_AsGeoJSON. A GeoTIFF has none of that shape.

    Storing them is possible in principle -- postgis_raster 3.4.3 is available
    in the database image, just not installed -- but it needs raster2pgsql
    (absent from every image here), a new source_kind, ops for zonal statistics,
    and a tiling strategy. That is a project, not an ingest path.
    """
    try:
        ds = gdal.OpenEx(str(path), gdal.OF_RASTER)
    except Exception:
        return
    if ds is None:
        return
    bands, w, h = ds.RasterCount, ds.RasterXSize, ds.RasterYSize
    ds = None
    sys.exit(
        f"\n  REFUSED: {path.name} is a raster ({w}x{h}, {bands} band(s)).\n"
        f"  This pipeline ingests vector data only. Nothing downstream can read a\n"
        f"  raster: attribute_source maps attributes to table COLUMNS, and every op\n"
        f"  composes over per-county values or feature geometry.\n\n"
        f"  Supported: .shp .geojson .json .gpkg .gdb .kml .csv (with lat/lon)\n")


def inspect(path: Path) -> dict:
    """Open the file and report what is in it, without changing anything."""
    check_raster(path)

    try:
        ds = ogr.Open(str(path))
    except Exception as e:
        sys.exit(f"\n  REFUSED: GDAL could not open {path.name}: {e}\n")
    if ds is None:
        sys.exit(f"\n  REFUSED: no vector layers in {path.name}\n")

    layers = []
    for i in range(ds.GetLayerCount()):
        layer = ds.GetLayerByIndex(i)
        defn = layer.GetLayerDefn()
        srs = layer.GetSpatialRef()
        epsg = None
        if srs is not None:
            srs.AutoIdentifyEPSG()
            epsg = srs.GetAuthorityCode(None)
        fields = [
            (defn.GetFieldDefn(f).GetName(),
             ogr.GetFieldTypeName(defn.GetFieldDefn(f).GetType()))
            for f in range(defn.GetFieldCount())
        ]
        layers.append({
            "name": layer.GetName(),
            "geometry": ogr.GeometryTypeToName(defn.GetGeomType()),
            "features": layer.GetFeatureCount(),
            "epsg": epsg,
            "fields": fields,
        })
    driver = ds.GetDriver().GetName()
    ds = None
    return {"driver": driver, "layers": layers}


def safe_table_name(display_name: str) -> str:
    """
    A table name derived from the dataset name.

    Matches sanitize_table_name in geospatial_etl.py: lowercase, non-alphanumerics
    to underscore, must not start with a digit, capped at Postgres' 63-char limit.
    """
    name = re.sub(r"[^a-z0-9_]+", "_", display_name.lower()).strip("_")
    if not name:
        name = "layer"
    if name[0].isdigit():
        name = f"table_{name}"
    return name[:63]


# --------------------------------------------------------------------------- #
# tagging
# --------------------------------------------------------------------------- #

TAG_SCHEMA = {
    "type": "object",
    "properties": {
        "tags": {"type": "array", "items": {"type": "string"}},
        "gen_desc": {"type": "string"},
    },
    "required": ["tags", "gen_desc"],
}


def generate_tags(dataset_name: str, column: str, sample: list[str]) -> tuple[list[str], str]:
    """
    Tags and a one-line description for one column, from the same model and
    settings PROVENANCE.md records for the existing catalog: gemma3:4b,
    temperature 0.1, constrained JSON.

    Using a different tagger produces a catalog that is internally inconsistent
    in a way retrieval cannot report.
    """
    examples = ", ".join(str(s) for s in sample[:5] if s not in (None, ""))
    prompt = (
        f"Dataset: {dataset_name}\n"
        f"Column: {column}\n"
        + (f"Example values: {examples}\n" if examples else "")
        + "Give 3-5 short lowercase keywords someone might search for to find "
          "this column, and one sentence describing what it holds."
    )
    body = json.dumps({
        "model": TAG_MODEL,
        "prompt": prompt,
        "format": TAG_SCHEMA,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 100},
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=45) as r:
        payload = json.loads(r.read().decode())
    parsed = json.loads(payload.get("response", "{}"))
    tags = [str(t).strip() for t in parsed.get("tags", []) if str(t).strip()]
    return tags[:5], str(parsed.get("gen_desc", "")).strip()


def fallback_tags(dataset_name: str, column: str) -> list[str]:
    """Derived from the names when the tagger is unavailable for one column."""
    words = re.split(r"[^a-z0-9]+", f"{dataset_name} {column}".lower())
    return [w for w in dict.fromkeys(words) if len(w) > 2][:5]


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #

def load_to_postgis(path: Path, layer_name: str, table: str, dsn: str) -> None:
    """
    ogr2ogr into PostGIS, reprojected to 4326 with the geometry column the rest
    of the stack expects.

    4326 is not a preference: attribute_source records an srid, compile.js
    transforms the COUNTY side when they differ, and every loaded layer is
    currently 4326. Normalising on import keeps that true and keeps the facility
    GIST indexes usable.
    """
    gdal.VectorTranslate(
        f"PG:{dsn}",
        str(path),
        options=gdal.VectorTranslateOptions(
            format="PostgreSQL",
            layerName=table,
            layers=[layer_name],
            dstSRS="EPSG:4326",
            reproject=True,
            geometryType="PROMOTE_TO_MULTI",
            accessMode="overwrite",
            layerCreationOptions=[
                f"GEOMETRY_NAME=geom",
                "FID=ogc_fid",
                "PRECISION=NO",     # DBF numeric overflow, see PROVENANCE.md
            ],
        ),
    )


def finalize_table(conn, table: str) -> int:
    """Index and ANALYZE, then report the true row count."""
    with conn.cursor() as cur:
        cur.execute(f'CREATE INDEX IF NOT EXISTS "idx_{table[:50]}_geom" '
                    f'ON "{table}" USING GIST (geom)')
        # ANALYZE matters more than it looks: without it pg_class.reltuples stays
        # -1, which reads as "empty" to anything checking coverage. Four existing
        # layers looked empty for exactly this reason.
        cur.execute(f'ANALYZE "{table}"')
        cur.execute(f'SELECT count(*) FROM "{table}"')
        return cur.fetchone()[0]


def sample_values(conn, table: str, column: str, n: int = 5) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            f'SELECT DISTINCT "{column}"::text FROM "{table}" '
            f'WHERE "{column}" IS NOT NULL LIMIT %s', (n,))
        return [r[0] for r in cur.fetchall()]


# --------------------------------------------------------------------------- #
# catalog
# --------------------------------------------------------------------------- #

def dataset_id_for(name: str) -> str:
    """Stable, readable, and unlikely to collide with the hashed HSIP ids."""
    slug = re.sub(r"[^a-z0-9]+", "", name.lower())[:12] or "dataset"
    return f"ing_{slug}_01"


def build_rows(dataset_name: str, table: str, columns: list[str], entity_type: str,
               tagger, conn) -> tuple[list[dict], list[dict]]:
    """One catalog row and one feature-map row per usable column."""
    dsid = dataset_id_for(dataset_name)
    catalog_rows, map_rows = [], []
    for i, col in enumerate(columns, start=1):
        attr_label = f"{dsid}_{i:02d}"
        try:
            sample = sample_values(conn, table, col) if conn else []
        except psycopg2.Error:
            sample = []
        tags, gen_desc = tagger(dataset_name, col, sample)
        catalog_rows.append({
            "dataset_id": dsid,
            "dataset_clean": dataset_name,
            "attr_label": attr_label,
            "attr_orig": col,
            # Title-cased column name, matching how the existing facility rows
            # read ("Objectid", "Website"). gen_desc is richer but nothing
            # downstream consumes it yet -- see PROVENANCE.md on gen_desc.
            "attr_desc": col.replace("_", " ").title(),
            "attr_id": "",
            "start_date": "", "end_date": "", "attr_dtype": "",
            "iso_key": "", "iso_key_add": "", "scale": "",
            "positional_accuracy": "", "spatial_rep": "", "datum": "",
            "coordinate_system": "", "entity_type": entity_type,
            "tags": str(tags),
            "originator_id": "",
        })
        map_rows.append({
            "attr_label": attr_label,
            "dataset_clean": dataset_name,
            "attr_orig": col,
            "table_name": table,
        })
    return catalog_rows, map_rows


# Backups go here, NOT beside the file they copy.
#
# geoark_attributes.csv is bind-mounted as a single FILE. Writing a sibling
# inside the container therefore lands on the container's own filesystem and
# disappears when it exits: the first run of this script wrote a backup that
# was gone before it could be used. This directory is inside a mounted
# DIRECTORY, so it survives.
BACKUP_DIR = Path(os.environ.get("INGEST_BACKUP_DIR", "/app/etl/_backups"))


def append_csv(path: Path, rows: list[dict], columns: list[str]) -> Path:
    """
    Append, after taking a timestamped backup.

    The catalog is the single most load-bearing file here: the API and the
    embedder both read it and assert matching row counts, so a bad append breaks
    both. The backup is the undo.
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}"
    shutil.copy2(path, backup)

    # Match the file's existing line ending. The committed catalog is CRLF, and
    # appending LF rows would make every later tool see a mixed-ending file --
    # and, worse, the embedder's cache key covers the CSV BYTES, so rewriting
    # endings silently invalidates the vector cache for no reason.
    with path.open("rb") as fh:
        head = fh.read(65536)
    terminator = "\r\n" if b"\r\n" in head else "\n"

    with path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, lineterminator=terminator)
        for r in rows:
            writer.writerow(r)
    return backup


# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", type=Path, required=True, help="vector file to ingest")
    ap.add_argument("--name", required=True,
                    help='display name, e.g. "Fire Hydrants". Becomes dataset_clean '
                         "and is what a user's question has to match.")
    ap.add_argument("--layer", help="layer name, for multi-layer sources (.gdb, .gpkg)")
    ap.add_argument("--entity-type", default="COUNTY", choices=["COUNTY", "STATE"])
    ap.add_argument("--commit", action="store_true",
                    help="actually load. Without this, nothing is written.")
    ap.add_argument("--no-tags", action="store_true",
                    help="skip the tagger. Costs ~42pp of known-item recall; "
                         "for testing only.")
    args = ap.parse_args()

    if not args.file.exists():
        sys.exit(f"\n  no such file: {args.file}\n")

    info = inspect(args.file)
    layers = info["layers"]
    if not layers:
        sys.exit("\n  REFUSED: the file contains no vector layers\n")

    chosen = next((l for l in layers if l["name"] == args.layer), None) if args.layer \
        else layers[0]
    if chosen is None:
        names = ", ".join(l["name"] for l in layers)
        sys.exit(f"\n  no layer named {args.layer!r}. Available: {names}\n")

    table = safe_table_name(args.name)
    usable = [f for f, _ in chosen["fields"] if f.lower() not in SKIP_COLUMNS]

    print(f"\n  source     {args.file.name}  ({info['driver']})")
    print(f"  layer      {chosen['name']}")
    print(f"  geometry   {chosen['geometry']}  |  EPSG:{chosen['epsg'] or 'unknown'}"
          f"  ->  reprojected to 4326")
    print(f"  features   {chosen['features']:,}")
    print(f"  table      {table}")
    print(f"  entity     {args.entity_type}")
    print(f"  columns    {len(chosen['fields'])} present, "
          f"{len(usable)} become searchable attributes")
    if not SAFE_IDENT.match(table):
        sys.exit(f"\n  REFUSED: {table!r} is not a usable table name\n")
    if chosen["features"] == 0:
        sys.exit("\n  REFUSED: the layer has no features\n")
    if not usable:
        sys.exit("\n  REFUSED: every column is an internal id; nothing to search on\n")
    if chosen["epsg"] is None:
        print("\n  ! no CRS on the source layer. GDAL will assume it is already 4326,")
        print("    which is wrong for most projected data. Verify before trusting it.")

    if not args.commit:
        print(f"\n  {len(usable)} catalog rows would be added:")
        for c in usable[:12]:
            print(f"     {c}")
        if len(usable) > 12:
            print(f"     ... and {len(usable) - 12} more")
        print("\n  Nothing written. Re-run with --commit to load.\n")
        return 0

    dsn = (f"host={os.environ.get('PGHOST','db')} port={os.environ.get('PGPORT','5432')} "
           f"dbname={os.environ.get('PGDATABASE','mygisdb')} "
           f"user={os.environ.get('PGUSER','geoark')} "
           f"password={os.environ.get('PGPASSWORD','')}")

    print("\n  loading into PostGIS ...")
    load_to_postgis(args.file, chosen["name"], table, dsn)

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    rows = finalize_table(conn, table)
    print(f"  loaded {rows:,} rows into {table}, GIST index built, ANALYZEd")

    if args.no_tags:
        tagger = lambda d, c, s: (fallback_tags(d, c), "")
        print("  ! tags skipped; retrieval for this dataset will be measurably worse")
    else:
        # Fail before writing anything to the catalog, rather than silently
        # producing a dataset that is present but hard to find.
        try:
            generate_tags(args.name, usable[0], [])
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            conn.close()
            sys.exit(f"\n  the tagger at {OLLAMA_URL} is unreachable ({e}).\n"
                     f"  Tags are worth 41.7pp of known-item recall, so this stops here.\n"
                     f"  Start the stack, or pass --no-tags if you accept the cost.\n")

        def tagger(d, c, s):
            try:
                tags, desc = generate_tags(d, c, s)
                return (tags or fallback_tags(d, c)), desc
            except Exception:
                return fallback_tags(d, c), ""
        print(f"  tagging {len(usable)} columns with {TAG_MODEL} ...")

    catalog_rows, map_rows = build_rows(
        args.name, table, usable, args.entity_type, tagger, conn)
    conn.close()

    cat_backup = append_csv(CATALOG, catalog_rows, CATALOG_COLUMNS)
    map_backup = append_csv(FEATURE_MAP, map_rows,
                            ["attr_label", "dataset_clean", "attr_orig", "table_name"])
    print(f"  catalog    +{len(catalog_rows)} rows  (backup: {cat_backup.name})")
    print(f"  table map  +{len(map_rows)} rows  (backup: {map_backup.name})")

    print("\n  Loaded. Two steps remain, both fast:")
    print("     make relink     link the new attributes to the table")
    print("     make reindex    re-embed the catalog so search can find them")
    print("  Then restart the API so it picks up the new corpus.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
