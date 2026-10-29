#!/usr/bin/env python3
"""
Ingest one dataset, end to end.

    # a dataset FOLDER: the data, plus an optional *.meta.yaml and/or official XML
    python3 etl/ingest.py --dir /incoming/hydrants              # dry run, writes nothing
    python3 etl/ingest.py --dir /incoming/hydrants --commit

    # a single file, named on the command line (the original form, still works)
    python3 etl/ingest.py --file /incoming/hydrants.geojson --name "Fire Hydrants" --commit

Metadata comes from the sidecar, then the XML, then the model; see
etl/dataset_meta.py and etl/templates/dataset.meta.yaml. Every committed load is
recorded in etl/data_manifest.yaml, which is what lets the server repeat it.

WHY THIS EXISTS

Adding a dataset used to mean: drop the file somewhere, hand-edit
backend/geoark_attributes.csv with one row per column, hand-edit
etl/facility_table_map.csv to match, run a 70-minute `make load-geo` that
rescans everything, relink, re-embed. Every step was manual and the two CSVs
had to agree exactly or the attribute resolved to nothing.

This does the whole thing for one file and refuses clearly when it cannot.

WHAT IT WILL NOT DO (YET)

Tables without geometry (Phase 3) and rasters (Phase 4) of
docs/DATA_LOADING_PLAN.md. Both are recognised and refused with that reason,
rather than loaded wrongly.

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

import dataset_meta
import load_table

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

# The catalog's columns are read from its header at write time, not listed
# here. A hardcoded list went stale once already: the catalog gained `gen_desc`
# (etl/backfill_gen_desc.py) and rows appended from the old list silently
# lacked it.
FEATURE_MAP_COLUMNS = ["attr_label", "dataset_clean", "attr_orig", "table_name"]

# CSVs: GDAL only builds point geometry from coordinate columns it is told
# about. Without these, "CSV with lat/lon" loaded as a table with no geometry.
CSV_OPEN_OPTIONS = [
    "X_POSSIBLE_NAMES=longitude,lon,long,lng,x",
    "Y_POSSIBLE_NAMES=latitude,lat,y",
    "KEEP_GEOM_COLUMNS=YES",
    "AUTODETECT_TYPE=YES",
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

def raster_info(path: Path) -> dict | None:
    """
    {width, height, bands} when the file is a raster, else None.

    Rasters are not refused here any more; they are recognised, and the
    dispatcher in main() says what happens to them. Everything downstream of
    this script assumes vector: attribute_source maps an attribute to a COLUMN,
    the ops compose over (fips, value), and the compiler emits ST_Intersects and
    ST_AsGeoJSON. A raster becomes usable through zonal statistics and a grid
    pyramid, which is Phase 4 of docs/DATA_LOADING_PLAN.md, not an ingest flag.
    """
    if path.is_dir() or path.suffix.lower() not in dataset_meta.RASTER_EXT:
        return None
    try:
        ds = gdal.OpenEx(str(path), gdal.OF_RASTER)
    except Exception:
        return None
    if ds is None:
        return None
    info = {"width": ds.RasterXSize, "height": ds.RasterYSize, "bands": ds.RasterCount}
    ds = None
    return info


def open_vector(path: Path):
    """A GDAL dataset, with the coordinate-column hints a CSV needs."""
    opts = CSV_OPEN_OPTIONS if path.suffix.lower() == ".csv" else []
    return gdal.OpenEx(str(path), gdal.OF_VECTOR, open_options=opts)


def inspect(path: Path) -> dict:
    """Open the file and report what is in it, without changing anything."""
    try:
        ds = open_vector(path)
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
            "has_geometry": defn.GetGeomType() != ogr.wkbNone,
            "features": layer.GetFeatureCount(),
            "epsg": epsg,
            "fields": fields,
        })
    driver = ds.GetDriver().ShortName   # a gdal.Driver, not ogr: no GetName()
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


def generate_tags(dataset_name: str, column: str, sample: list[str],
                  known_desc: str = "") -> tuple[list[str], str]:
    """
    Tags and a one-line description for one column, from the same model and
    settings PROVENANCE.md records for the existing catalog: gemma3:4b,
    temperature 0.1, constrained JSON.

    Using a different tagger produces a catalog that is internally inconsistent
    in a way retrieval cannot report.

    `known_desc` is the column's description from the sidecar or XML, when there
    is one. It is the same tagger with more context, not a different tagger: a
    column called RPL_THEMES is untaggable from its name alone, and with
    "Overall vulnerability percentile" beside it the keywords become usable.
    The line is omitted when there is no description, so the prompt for a
    dataset without metadata is byte-identical to before.
    """
    examples = ", ".join(str(s) for s in sample[:5] if s not in (None, ""))
    prompt = (
        f"Dataset: {dataset_name}\n"
        f"Column: {column}\n"
        + (f"Description: {known_desc}\n" if known_desc else "")
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
        open_vector(path),
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
                # finalize_table builds the GIST index. ogr2ogr's default one
                # on top of it was a second identical index on every layer.
                "SPATIAL_INDEX=NONE",
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


def one_line(text) -> str:
    """
    Collapse whitespace so every ingested row is ONE physical CSV line.

    --replace removes a dataset's earlier rows by line prefix. That is only
    safe if none of its fields can carry a newline, and gen_desc is model
    output, so it is not guaranteed.
    """
    return re.sub(r"\s+", " ", str(text or "")).strip()


def describe(meta: dict, column: str) -> tuple[str, str]:
    """
    (attr_desc, where it came from) for one column.

    attr_desc stays the title-cased column name when nothing better is known,
    matching how the existing facility rows read ("Objectid", "Website"); the
    model's sentence goes into gen_desc instead. gen_desc is NOT searched by
    default: embedding it per column cost 25pp of known-item recall@1
    (EMBED_GEN_DESC in deploy/embedder/app.py, CLAUDE.md). A real description
    from the sidecar or XML
    replaces attr_desc, with units appended because "Expected annual loss" and
    "Expected annual loss (USD)" are different answers to "how much".
    """
    spec = dataset_meta.column_meta(meta, column)
    desc = one_line(spec.get("desc"))
    units = one_line(spec.get("units"))
    if desc:
        if units and units.lower() not in desc.lower():
            desc = f"{desc} ({units})"
        return desc, spec.get("_from", "sidecar")
    return column.replace("_", " ").title(), "column name"


def build_rows(meta: dict, dsid: str, table: str, columns: list[str],
               entity_type: str, spatial_rep: str, tagger, conn
               ) -> tuple[list[dict], list[dict]]:
    """One catalog row and one feature-map row per usable column."""
    name = meta["name"]
    start = str(meta.get("start_year") or "")
    end = str(meta.get("end_year") or "")
    catalog_rows, map_rows = [], []
    for i, col in enumerate(columns, start=1):
        attr_label = f"{dsid}_{i:02d}"
        try:
            sample = sample_values(conn, table, col) if conn else []
        except psycopg2.Error:
            sample = []
        attr_desc, origin = describe(meta, col)
        known = attr_desc if origin != "column name" else ""
        tags, gen_desc = tagger(name, col, sample, known)
        catalog_rows.append({
            "dataset_id": dsid,
            "dataset_clean": one_line(name),
            "attr_label": attr_label,
            "attr_orig": col,
            "attr_desc": one_line(attr_desc),
            "attr_id": "",
            # Years are embedded as text ("2018 to 2022"): users ask for "2015"
            # or "recent", and an empty date is invisible to both retrieval paths.
            "start_date": start, "end_date": end, "attr_dtype": "",
            "iso_key": "", "iso_key_add": "", "scale": "",
            "positional_accuracy": "", "spatial_rep": spatial_rep, "datum": "",
            "coordinate_system": "", "entity_type": entity_type,
            "tags": str(tags),
            "originator_id": "",
            "gen_desc": one_line(gen_desc),
        })
        map_rows.append({
            "attr_label": attr_label,
            "dataset_clean": one_line(name),
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


def csv_header(path: Path) -> list[str]:
    with path.open(encoding="utf-8", newline="") as fh:
        return next(csv.reader(fh))


def existing_rows(path: Path, prefix: str) -> int:
    """Physical lines starting with `prefix` (a dataset_id or attr_label stem)."""
    with path.open(encoding="utf-8", newline="") as fh:
        return sum(1 for line in fh if line.startswith(prefix))


def write_rows(path: Path, rows: list[dict], replace_prefix: str | None = None) -> Path:
    """
    Append rows, after taking a timestamped backup; with `replace_prefix`, first
    drop the lines an earlier load of the same dataset wrote.

    The catalog is the single most load-bearing file here: the API and the
    embedder both read it and assert matching row counts, so a bad write breaks
    both. The backup is the undo.

    Rows are written in the FILE's own column order, read from its header.
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
    columns = csv_header(path)

    if replace_prefix:
        # Line-based on purpose: rewriting the file through the csv module
        # would re-quote every unrelated row and turn a one-dataset change into
        # a whole-file diff. Ingested rows are one line each (one_line()), and
        # their ids are ours, so a prefix match is exact.
        with path.open("rb") as fh:
            lines = fh.read().splitlines(keepends=True)
        prefix = replace_prefix.encode()
        kept = [l for l in lines if not l.startswith(prefix)]
        if kept and not kept[-1].endswith(b"\n"):
            kept[-1] += terminator.encode()
        path.write_bytes(b"".join(kept))

    with path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, lineterminator=terminator,
                                extrasaction="ignore")
        for r in rows:
            writer.writerow(r)
    return backup


# --------------------------------------------------------------------------- #

def refuse_kind(kind: str, data_path: Path, raster: dict | None) -> None:
    """The shapes this script recognises but does not load, and why."""
    if kind == "boundaries":
        sys.exit(
            "\n  Boundaries are not catalog datasets: they are what other data is\n"
            "  filtered BY or aggregated TO. Use  make boundaries  (place_geom) or\n"
            "  make geo-units  (geo_unit, every analysis level).\n")


def pg_dsn() -> str:
    return (f"host={os.environ.get('PGHOST','db')} port={os.environ.get('PGPORT','5432')} "
            f"dbname={os.environ.get('PGDATABASE','mygisdb')} "
            f"user={os.environ.get('PGUSER','geoark')} "
            f"password={os.environ.get('PGPASSWORD','')}")


def ensure_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute((Path(__file__).parent / "schema_geo.sql").read_text())
    conn.commit()


def record_db_load(entry_id: str, kind: str, files: list[dict], rows: int, via: str) -> None:
    """What THIS database now holds; `make replay` compares the ledger to it."""
    conn = psycopg2.connect(pg_dsn())
    ensure_schema(conn)
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO dataset_load (id, kind, files_sha, rows, via) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, files_sha = EXCLUDED.files_sha,
              rows = EXCLUDED.rows, via = EXCLUDED.via, loaded_at = now()
        """, (entry_id, kind, dataset_meta.files_sha(files), rows, via))
    conn.commit()
    conn.close()


def make_tagger(args, name: str, first_column: str):
    """The tagger, checked reachable before anything is written."""
    if args.no_tags:
        print("  ! tags skipped; retrieval for this dataset will be measurably worse")
        return lambda d, c, s, k: (fallback_tags(d, c), "")
    try:
        generate_tags(name, first_column, [])
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        sys.exit(f"\n  the tagger at {OLLAMA_URL} is unreachable ({e}).\n"
                 f"  Tags are worth 41.7pp of known-item recall, so this stops here.\n"
                 f"  Start the stack, or pass --no-tags if you accept the cost.\n")

    def tagger(d, c, s, k):
        try:
            tags, desc = generate_tags(d, c, s, k)
            return (tags or fallback_tags(d, c)), desc
        except Exception:
            return fallback_tags(d, c), ""
    return tagger


def ingest_table(args, meta: dict, data_path: Path) -> int:
    """
    kind: table. Values keyed by a geographic unit at any level; see
    etl/load_table.py for how the level is decided and where values go.
    """
    dsid = dataset_id_for(meta.get("id") or meta["name"])
    conn = psycopg2.connect(pg_dsn())
    ensure_schema(conn)
    p = load_table.plan(data_path, meta, conn, allow_wide=args.allow_wide)
    level = p["level"]
    entry_id = f"{dsid}@{level}"

    print(f"\n  source     {data_path.name}")
    print(f"  dataset_id {dsid}   (ledger entry {entry_id})")
    load_table.describe_plan(p)

    with conn.cursor() as cur:
        cur.execute("SELECT code FROM geo_measure WHERE dataset_id = %s AND level = %s",
                    (dsid, level))
        previous = [r[0] for r in cur.fetchall()]
    in_catalog = existing_rows(CATALOG, f"{dsid},") if level == "county" else 0
    if (previous or in_catalog) and not args.replace:
        conn.close()
        sys.exit(f"\n  REFUSED: {entry_id} is already loaded ({len(previous)} measures).\n"
                 f"  Re-run with --replace to load it again, or give it a different\n"
                 f"  id:  in the sidecar.\n")

    if level != "county":
        print(f"\n  {level} values go to geo_values. No catalog rows: nothing can plan over\n"
              f"  a {level} measure until ops are level-aware (Phase 6).")

    if not args.commit:
        conn.close()
        print("\n  Nothing written. Re-run with --commit to load.\n")
        return 0

    tagger = make_tagger(args, meta["name"], p["measures"][0]["column"]) \
        if level == "county" else None

    print("\n  writing values ...")
    result = load_table.write_values(conn, p, dsid, previous if args.replace else None)
    conn.close()
    print(f"  {result['rows']:,} values, {len(result['measures'])} measures")

    catalog_added = []
    if level == "county":
        rows, skipped = [], []
        print(f"  tagging {len(result['measures'])} measures with {TAG_MODEL} ...")
        for m in p["measures"]:
            st = result["measures"].get(m["code"])
            if not st:
                continue
            if st["units"] < load_table.MIN_COUNTIES:
                skipped.append(m["code"])
                continue
            desc, origin = describe(meta, m["column"])
            if st["units"] < 3000:
                desc = f"{desc} (covers {st['units']:,} counties)"
            known = desc if origin != "column name" else ""
            tags, gen_desc = tagger(meta["name"], m["column"], [], known)
            rows.append({
                "dataset_id": dsid, "dataset_clean": one_line(meta["name"]),
                # attr_label IS the measure code: that is how relink resolves
                # county-value rows (load_reference_data.build_attribute_source).
                "attr_label": m["code"], "attr_orig": m["column"],
                "attr_desc": one_line(desc), "attr_id": m["code"],
                "start_date": str(st["min_year"]), "end_date": str(st["max_year"]),
                "spatial_rep": "POLYGON", "entity_type": "COUNTY",
                "tags": str(tags), "gen_desc": one_line(gen_desc),
            })
        if skipped:
            print(f"  {len(skipped)} measures cover under {load_table.MIN_COUNTIES} counties:"
                  f" loaded, but not put in the catalog")
        backup = write_rows(CATALOG, rows, f"{dsid}," if in_catalog else None)
        catalog_added = [r["attr_label"] for r in rows]
        print(f"  catalog    +{len(rows)} rows  (backup: {backup.name})")

    extra = [x for x in (meta["sidecar_path"], meta["xml_path"]) if x]
    files = dataset_meta.file_records(data_path, extra)
    record_db_load(entry_id, "table", files, result["rows"], "ingest")
    dataset_meta.record_load({
        "id": entry_id,
        "dataset_id": dsid,
        "name": meta["name"],
        "kind": "table",
        "level": level,
        "files": files,
        "rows": result["rows"],
        "units": len({g for g in p["matched"]}),
        "unmatched_units": len(p["unmatched"]),
        "codes": sorted(result["measures"]),
        "catalog_labels": catalog_added,
        "tag_model": (None if args.no_tags else TAG_MODEL) if level == "county" else None,
        "metadata": {k: meta.get(k) for k in (
            "description", "originator", "source_url", "license", "keywords",
            "start_year", "end_year", "probe") if meta.get(k)},
        "dump": None,
    })
    print(f"  ledger     {dataset_meta.LEDGER.name}: {entry_id} recorded\n")
    return 0


def ingest_raster(args, meta: dict, data_path: Path) -> int:
    """
    kind: raster. Kept as a raster, summarised to `zonal_levels`, and built
    into a grid pyramid; see etl/load_raster.py.
    """
    import load_raster  # noqa: PLC0415
    info = load_raster.inspect(data_path)
    load_raster.check(info, meta)
    dsid = dataset_id_for(meta.get("id") or meta["name"])
    code = load_raster.code_for(meta)
    levels = meta.get("zonal_levels") or ["county"]
    fs = load_raster.factors(info)
    if not meta.get("end_year"):
        sys.exit("\n  REFUSED: no year; give  vintage:  in the sidecar\n")

    print(f"\n  source     {data_path.name}  ({info['dtype']})")
    print(f"  size       {info['width']:,} x {info['height']:,} pixels, "
          f"{abs(info['pixel_x']):.6f} deg  |  nodata {info['nodata']}")
    print(f"  aggregate  {meta['aggregate']}")
    print(f"  measure    {code}  (year {meta['end_year']})")
    print(f"  zonal to   {', '.join(levels)}")
    print(f"  pyramid    " + ", ".join(f"{lvl} = {f}x{f} pixels" for lvl, f in fs.items()))
    print(f"  dataset_id {dsid}")

    conn = psycopg2.connect(pg_dsn())
    ensure_schema(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM dataset_load WHERE id = %s", (dsid,))
        loaded = cur.fetchone() is not None
    if loaded and not args.replace:
        conn.close()
        sys.exit(f"\n  REFUSED: {dsid} is already loaded. Re-run with --replace.\n")
    if not args.commit:
        conn.close()
        print("\n  Nothing written. Re-run with --commit to load.\n")
        return 0

    tagger = make_tagger(args, meta["name"], code) if "county" in levels else None
    print("\n  loading ...")
    report = load_raster.load(conn, pg_dsn(), data_path, meta, dsid)
    conn.close()

    catalog_added = []
    if "county" in levels:
        desc, origin = describe(meta, meta.get("measure") or "value")
        if origin == "column name":
            desc = meta.get("measure_label") or meta.get("description") or meta["name"]
        tags, gen_desc = tagger(meta["name"], meta.get("measure") or "value", [], desc)
        row = {"dataset_id": dsid, "dataset_clean": one_line(meta["name"]),
               "attr_label": code, "attr_orig": meta.get("measure") or "value",
               "attr_desc": one_line(desc), "attr_id": code,
               "start_date": str(meta["end_year"]), "end_date": str(meta["end_year"]),
               "spatial_rep": "POLYGON", "entity_type": "COUNTY",
               "tags": str(tags), "gen_desc": one_line(gen_desc)}
        in_catalog = existing_rows(CATALOG, f"{dsid},")
        backup = write_rows(CATALOG, [row], f"{dsid}," if in_catalog else None)
        catalog_added = [code]
        print(f"  catalog    +1 row  (backup: {backup.name})")

    extra = [x for x in (meta["sidecar_path"], meta["xml_path"]) if x]
    files = dataset_meta.file_records(data_path, extra)
    record_db_load(dsid, "raster", files, report["valid_pixels"], "ingest")
    dataset_meta.record_load({
        "id": dsid, "dataset_id": dsid, "name": meta["name"], "kind": "raster",
        "files": files, "table": report["table"], "code": code, "year": report["year"],
        "aggregate": meta["aggregate"], "rows": report["valid_pixels"],
        "tiles": report["tiles"], "total": round(report["total"], 3),
        "levels": {k: {kk: (round(vv, 3) if isinstance(vv, float) else vv)
                       for kk, vv in v.items()} for k, v in report["levels"].items()},
        "catalog_labels": catalog_added,
        "tag_model": (None if args.no_tags else TAG_MODEL) if catalog_added else None,
        "metadata": {k: meta.get(k) for k in (
            "description", "originator", "source_url", "license", "keywords",
            "start_year", "end_year", "probe") if meta.get(k)},
        "dump": None,
    })
    print(f"  ledger     {dataset_meta.LEDGER.name}: {dsid} recorded\n")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", type=Path,
                     help="dataset folder: data + optional *.meta.yaml + optional XML")
    src.add_argument("--file", type=Path, help="a single vector file")
    ap.add_argument("--name",
                    help='display name, e.g. "Fire Hydrants". Becomes dataset_clean '
                         "and is what a user's question has to match. Overrides "
                         "nothing: the sidecar's name, then the XML title, win.")
    ap.add_argument("--layer", help="layer name, for multi-layer sources (.gdb, .gpkg)")
    ap.add_argument("--entity-type", choices=["COUNTY", "STATE"],
                    help="default: the sidecar's entity_type, else COUNTY")
    ap.add_argument("--commit", action="store_true",
                    help="actually load. Without this, nothing is written.")
    ap.add_argument("--replace", action="store_true",
                    help="this dataset was loaded before: remove its catalog and "
                         "table-map rows and load it again")
    ap.add_argument("--allow-wide", action="store_true",
                    help=f"tables: allow more than {load_table.WIDE_LIMIT} measure columns")
    ap.add_argument("--no-tags", action="store_true",
                    help="skip the tagger. Costs ~42pp of known-item recall; "
                         "for testing only.")
    args = ap.parse_args()

    target = args.dir or args.file
    if not target.exists():
        sys.exit(f"\n  no such file or folder: {target}\n")

    meta = dataset_meta.resolve(target, args.name)
    if not meta["name"]:
        sys.exit("\n  REFUSED: the dataset has no name. Give it one with  name:  in the\n"
                 "  sidecar, or --name. It becomes dataset_clean, which is what a\n"
                 "  question has to match, so it is not optional.\n")
    data_path = meta["data_path"]
    if not data_path.exists():
        sys.exit(f"\n  no such file: {data_path}\n")

    raster = raster_info(data_path)
    info, chosen = None, None
    # Tables GDAL cannot open as layers (Census-API JSON), or that are tables by
    # declaration, skip the vector inspection entirely.
    table_file = (meta.get("kind") == "table" or load_table.is_census_json(data_path)
                  or data_path.suffix.lower() in (".xlsx", ".xlsm", ".tsv", ".txt"))
    if raster is None and not table_file:
        info = inspect(data_path)
        layers = info["layers"]
        if not layers:
            sys.exit("\n  REFUSED: the file contains no vector layers\n")
        layer_name = args.layer or meta.get("layer")
        chosen = next((l for l in layers if l["name"] == layer_name), None) if layer_name \
            else layers[0]
        if chosen is None:
            names = ", ".join(l["name"] for l in layers)
            sys.exit(f"\n  no layer named {layer_name!r}. Available: {names}\n")

    has_geometry = False if table_file else (chosen["has_geometry"] if chosen else None)
    kind = dataset_meta.infer_kind(meta, has_geometry, raster is not None)

    print(f"\n  dataset    {meta['name']}  [{meta['sources'].get('name')}]")
    for key in ("description", "originator", "source_url", "license"):
        if meta.get(key):
            print(f"  {key:<10} {str(meta[key])[:90]}  [{meta['sources'][key]}]")
    if meta.get("start_year"):
        yrs = meta["start_year"] if meta["start_year"] == meta["end_year"] \
            else f"{meta['start_year']}-{meta['end_year']}"
        print(f"  years      {yrs}  [{meta['sources']['years']}]")
    print(f"  metadata   sidecar: {meta['sidecar_path'].name if meta['sidecar_path'] else '-'}"
          f"   xml: {meta['xml_path'].name + ' (' + meta['xml_standard'] + ')' if meta['xml_path'] else '-'}")
    for w in meta["warnings"]:
        print(f"  ! {w}")
    print(f"  kind       {kind}")

    if kind == "table":
        return ingest_table(args, meta, data_path)
    if kind == "raster":
        return ingest_raster(args, meta, data_path)
    if kind != "features":
        refuse_kind(kind, data_path, raster)
        return 2

    entity_type = args.entity_type or meta.get("entity_type") or "COUNTY"
    if entity_type not in ("COUNTY", "STATE"):
        sys.exit(f"\n  REFUSED: entity_type {entity_type!r}; expected COUNTY or STATE\n")
    table = safe_table_name(meta.get("id") or meta["name"])
    dsid = dataset_id_for(meta.get("id") or meta["name"])
    present = [f for f, _ in chosen["fields"] if f.lower() not in SKIP_COLUMNS]
    usable = [f for f in present if dataset_meta.column_selected(meta, f)]
    described = [f for f in usable if describe(meta, f)[1] != "column name"]
    geom = chosen["geometry"].upper()
    spatial_rep = ("POINT" if "POINT" in geom else "LINE" if "LINE" in geom
                   else "POLYGON" if "POLYGON" in geom else "")

    print(f"\n  source     {data_path.name}  ({info['driver']})")
    print(f"  layer      {chosen['name']}")
    print(f"  geometry   {chosen['geometry']}  |  EPSG:{chosen['epsg'] or 'unknown'}"
          f"  ->  reprojected to 4326")
    print(f"  features   {chosen['features']:,}")
    print(f"  table      {table}")
    print(f"  dataset_id {dsid}")
    print(f"  entity     {entity_type}")
    print(f"  columns    {len(chosen['fields'])} present, {len(usable)} become searchable "
          f"attributes, {len(described)} with a real description")
    if len(present) != len(usable):
        print(f"             {len(present) - len(usable)} left out by include/exclude/skip")
    if not SAFE_IDENT.match(table):
        sys.exit(f"\n  REFUSED: {table!r} is not a usable table name\n")
    if chosen["features"] == 0:
        sys.exit("\n  REFUSED: the layer has no features\n")
    if not usable:
        sys.exit("\n  REFUSED: every column is an internal id or excluded; nothing to search on\n")
    if chosen["epsg"] is None:
        print("\n  ! no CRS on the source layer. GDAL will assume it is already 4326,")
        print("    which is wrong for most projected data. Verify before trusting it.")

    # A second load of the same dataset used to append a second copy of every
    # row: duplicate attr_labels, which validate_catalog calls an error because
    # attribute_source is keyed on them and later rows silently shadow earlier.
    already = existing_rows(CATALOG, f"{dsid},")
    if already and not args.replace:
        sys.exit(f"\n  REFUSED: {dsid} is already in the catalog ({already} rows).\n"
                 f"  Re-run with --replace to load it again (the old rows are\n"
                 f"  removed, after a backup), or give it a different  id:  in the sidecar.\n")

    if not args.commit:
        print(f"\n  {len(usable)} catalog rows would be "
              f"{'replaced' if already else 'added'}:")
        for c in usable[:12]:
            desc, origin = describe(meta, c)
            print(f"     {c:<24} {desc[:60]}  [{origin}]")
        if len(usable) > 12:
            print(f"     ... and {len(usable) - 12} more")
        print("\n  Nothing written. Re-run with --commit to load.\n")
        return 0

    dsn = pg_dsn()

    # Fail before writing anything, rather than silently producing a dataset
    # that is present but hard to find.
    tagger = make_tagger(args, meta["name"], usable[0])

    print("\n  loading into PostGIS ...")
    load_to_postgis(data_path, chosen["name"], table, dsn)

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    rows = finalize_table(conn, table)
    print(f"  loaded {rows:,} rows into {table}, GIST index built, ANALYZEd")
    if not args.no_tags:
        print(f"  tagging {len(usable)} columns with {TAG_MODEL} ...")

    catalog_rows, map_rows = build_rows(
        meta, dsid, table, usable, entity_type, spatial_rep, tagger, conn)
    conn.close()

    replace = f"{dsid}," if already else None
    cat_backup = write_rows(CATALOG, catalog_rows, replace)
    map_backup = write_rows(FEATURE_MAP, map_rows, f"{dsid}_" if already else None)
    print(f"  catalog    +{len(catalog_rows)} rows  (backup: {cat_backup.name})")
    print(f"  table map  +{len(map_rows)} rows  (backup: {map_backup.name})")

    extra = [p for p in (meta["sidecar_path"], meta["xml_path"]) if p]
    files = dataset_meta.file_records(data_path, extra)
    record_db_load(dsid, "features", files, rows, "ingest")
    dataset_meta.record_load({
        "id": dsid,
        "name": meta["name"],
        "kind": "features",
        "entity_type": entity_type,
        "files": files,
        "layer": chosen["name"],
        "table": table,
        "rows": rows,
        "geometry": chosen["geometry"],
        "catalog_labels": [r["attr_label"] for r in catalog_rows],
        "tag_model": None if args.no_tags else TAG_MODEL,
        "metadata": {k: meta.get(k) for k in (
            "description", "originator", "source_url", "license", "keywords",
            "start_year", "end_year", "probe") if meta.get(k)},
        "dump": None,
    })
    print(f"  ledger     {dataset_meta.LEDGER.name}: {dsid} recorded")

    print("\n  Loaded. Remaining (make ingest does these for you):")
    print("     make relink         link the new attributes to the table")
    print("     make reindex        re-embed the catalog so search can find them")
    print("     make reload-corpus  the API picks up the new corpus, no restart\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
