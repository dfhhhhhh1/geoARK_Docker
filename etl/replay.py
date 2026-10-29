#!/usr/bin/env python3
"""
Repeat, on this machine, the loads recorded in etl/data_manifest.yaml.

    python3 etl/replay.py                     # what is loaded, stale, missing (writes nothing)
    python3 etl/replay.py --commit            # load everything stale, from raw files or dumps
    python3 etl/replay.py --dump ing_svi_01@tract       # write a dump of one dataset
    python3 etl/replay.py --commit --prefer-dump        # restore from dumps even if raw files exist

THE SPLIT THAT MAKES THIS SAFE. A load has two halves:

  the catalog half   catalog rows, tags, descriptions. Written ONCE, by ingest,
                     on the machine with the tagger, and carried by git.
  the data half      tables and values in Postgres. Repeated here, from the raw
                     files (scp'd into deploy/incoming/) or from a dump.

Replay only ever does the data half. It never runs the tagger and never writes
the catalog, so the server answers with exactly the tags that were tested, and
the 8 GB server card never has to hold the tagger beside a planner.

WHAT "STALE" MEANS. The ledger records the sha256 of every file a load read;
the database records the same hash in dataset_load when it loads. Equal hashes
mean up to date. A file whose bytes differ from the ledger is REFUSED, not
loaded: those are not the bytes the catalog rows were written from.

DUMPS. For data that is slow to rebuild, `--dump` writes /dumps/<id>/ and
records it in the ledger; replay restores from it when the raw files are
absent. Feature tables use pg_dump; table values (which share
acs_county_values / geo_values with everything else) are COPYed out by code.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).parent))
import dataset_meta  # noqa: E402

DUMP_ROOT = Path(os.environ.get("DUMP_ROOT", "/dumps"))


def conn():
    import ingest  # noqa: PLC0415  (GDAL import; only when needed)
    c = psycopg2.connect(ingest.pg_dsn())
    ingest.ensure_schema(c)
    return c


def safe(entry_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", entry_id)


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #

def file_state(entry: dict) -> tuple[str, list[str]]:
    """'ok' | 'missing' | 'changed', with the offending paths."""
    missing, changed = [], []
    for f in entry.get("files", []):
        p = dataset_meta.INCOMING_ROOT / f["path"]
        if not p.exists():
            missing.append(f["path"])
        elif p.stat().st_size != f["bytes"] or dataset_meta.sha256(p) != f["sha256"]:
            changed.append(f["path"])
    if changed:
        return "changed", changed
    if missing:
        return "missing", missing
    return "ok", []


def dump_state(entry: dict) -> str:
    d = entry.get("dump")
    if not d:
        return "none"
    for f in d.get("files", []):
        p = DUMP_ROOT / f["path"]
        if not p.exists():
            return "missing"
        if dataset_meta.sha256(p) != f["sha256"]:
            return "changed"
    return "ok"


def db_state(c, entry: dict) -> str:
    with c.cursor() as cur:
        cur.execute("SELECT files_sha FROM dataset_load WHERE id = %s", (entry["id"],))
        row = cur.fetchone()
    if row is None:
        return "absent"
    return "current" if row[0] == dataset_meta.files_sha(entry["files"]) else "stale"


# --------------------------------------------------------------------------- #
# loading from raw files (the data half of ingest, and nothing else)
# --------------------------------------------------------------------------- #

def data_path_of(entry: dict) -> Path:
    """The file ingest read: the one whose name is not the sidecar or XML."""
    for f in entry["files"]:
        low = f["path"].lower()
        if not (low.endswith((".meta.yaml", ".meta.yml", ".xml"))):
            p = dataset_meta.INCOMING_ROOT / f["path"]
            if p.suffix.lower() in (".shx", ".dbf", ".prj", ".cpg", ".sbn", ".sbx"):
                p = p.with_suffix(".shp")
            if ".gdb/" in f["path"]:
                p = dataset_meta.INCOMING_ROOT / (f["path"].split(".gdb/")[0] + ".gdb")
            return p
    raise SystemExit(f"  {entry['id']}: ledger lists no data file")


def load_features(c, entry: dict) -> int:
    import ingest  # noqa: PLC0415
    ingest.load_to_postgis(data_path_of(entry), entry["layer"], entry["table"], ingest.pg_dsn())
    c.commit()   # the state queries left a transaction open; autocommit cannot change inside one
    c.autocommit = True
    n = ingest.finalize_table(c, entry["table"])
    c.autocommit = False
    return n


def load_table_values(c, entry: dict) -> int:
    import load_table  # noqa: PLC0415
    path = data_path_of(entry)
    meta = dataset_meta.resolve(path.parent if path.parent != dataset_meta.INCOMING_ROOT
                                else path)
    meta["data_path"] = path
    p = load_table.plan(path, meta, c, allow_wide=True)
    if p["level"] != entry["level"]:
        raise SystemExit(f"  {entry['id']}: decided level {p['level']}, ledger says "
                         f"{entry['level']}. Refusing.")
    previous = list(entry.get("codes") or [])
    result = load_table.write_values(c, p, entry["dataset_id"], previous)
    return result["rows"]


def load_raster_data(c, entry: dict) -> int:
    """Tiles, zonal values and pyramid again; never the catalog row."""
    import ingest  # noqa: PLC0415
    import load_raster  # noqa: PLC0415
    path = data_path_of(entry)
    meta = dataset_meta.resolve(path.parent)
    meta["data_path"] = path
    report = load_raster.load(c, ingest.pg_dsn(), path, meta, entry["dataset_id"])
    if abs(report["total"] - entry.get("total", report["total"])) > 1e-6 * abs(report["total"]):
        print(f"    ! raster total {report['total']:,.3f} differs from the ledger's "
              f"{entry['total']:,.3f}")
    return report["valid_pixels"]


def record(c, entry: dict, rows: int, via: str) -> None:
    with c.cursor() as cur:
        cur.execute("""
            INSERT INTO dataset_load (id, kind, files_sha, rows, via) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET files_sha = EXCLUDED.files_sha, rows = EXCLUDED.rows,
              via = EXCLUDED.via, kind = EXCLUDED.kind, loaded_at = now()
        """, (entry["id"], entry["kind"], dataset_meta.files_sha(entry["files"]), rows, via))
    c.commit()


# --------------------------------------------------------------------------- #
# dumps
# --------------------------------------------------------------------------- #

def copy_specs(entry: dict) -> list[tuple]:
    """
    What a dataset owns inside the SHARED tables, as
    (file stem, table, columns, WHERE clause, params).

    The same clause selects the rows to dump and the rows to delete before a
    restore, so a restore can never remove anything the dump did not contain.
    Tables a dataset owns outright (a feature table, a raster table) go through
    pg_dump instead.
    """
    did = entry.get("dataset_id", entry["id"])
    if entry["kind"] == "table":
        if entry["level"] == "county":
            vals = ("acs_county_values", "acs_county_values", "fips, census_code, year, value",
                    "census_code = ANY(%s)", (entry["codes"],))
        else:
            vals = ("geo_values", "geo_values", "level, geoid, code, year, value",
                    "level = %s AND code = ANY(%s)", (entry["level"], entry["codes"]))
        return [vals, ("geo_measure", "geo_measure",
                       "code, level, dataset_id, label, description, units, min_year, "
                       "max_year, n_units", "dataset_id = %s AND level = %s",
                       (did, entry["level"]))]
    if entry["kind"] == "raster":
        rid = entry["table"].removeprefix("raster_")
        code, year = entry["code"], entry["year"]
        return [
            ("acs_county_values", "acs_county_values", "fips, census_code, year, value",
             "census_code = %s AND year = %s", (code, year)),
            ("geo_values", "geo_values", "level, geoid, code, year, value",
             "code = %s AND year = %s", (code, year)),
            ("geo_unit", "geo_unit",
             "level, geoid, name, state_fp, county_fips, aland, awater, pt, geom, "
             "geom_z6, geom_z9, geom_z12, source",
             "level LIKE 'grid%%' AND geoid LIKE %s", (rid + ":%",)),
            ("geo_measure", "geo_measure",
             "code, level, dataset_id, label, description, units, min_year, max_year, n_units",
             "dataset_id = %s", (did,)),
            ("raster_layer", "raster_layer",
             "id, table_name, dataset_id, code, aggregate, year, srid, origin_x, origin_y, "
             "pixel_x, pixel_y, width, height, nodata, tile_size, tiles, valid_pixels, total",
             "id = %s", (rid,)),
        ]
    return []


def copy_out(c, sql: str, params: tuple, path: Path) -> int:
    with c.cursor() as cur:
        q = cur.mogrify(sql, params).decode()
        buf = io.StringIO()
        cur.copy_expert(f"COPY ({q}) TO STDOUT WITH (FORMAT csv)", buf)
    data = buf.getvalue()
    with gzip.open(path, "wt", encoding="utf-8", newline="") as fh:
        fh.write(data)
    return data.count("\n")


def dump(c, entry: dict) -> dict:
    out = DUMP_ROOT / safe(entry["id"])
    out.mkdir(parents=True, exist_ok=True)
    made = []
    if entry["kind"] in ("features", "raster"):
        target = out / f"{entry['table']}.pgdump"
        subprocess.run(["pg_dump", "-Fc", "--no-owner", "-t", entry["table"], "-f", str(target)],
                       check=True)
        made.append(target)
    specs = copy_specs(entry)
    if entry["kind"] not in ("features", "raster", "table"):
        raise SystemExit(f"  {entry['id']}: no dump route for kind {entry['kind']!r}")
    for stem, table, cols, where, params in specs:
        path = out / f"{stem}.csv.gz"
        n = copy_out(c, f"SELECT {cols} FROM {table} WHERE {where}", params, path)
        made.append(path)
        print(f"    {table}: {n:,} rows")
    (out / "manifest.json").write_text(json.dumps(
        {"id": entry["id"], "kind": entry["kind"], "files_sha":
         dataset_meta.files_sha(entry["files"])}, indent=1))
    made.append(out / "manifest.json")
    return {"files": [{"path": str(p.relative_to(DUMP_ROOT)), "sha256": dataset_meta.sha256(p),
                       "bytes": p.stat().st_size} for p in made]}


def restore(c, entry: dict) -> int:
    out = DUMP_ROOT / safe(entry["id"])
    n = 0
    if entry["kind"] in ("features", "raster"):
        c.commit()
        subprocess.run(["pg_restore", "--clean", "--if-exists", "--no-owner", "-d",
                        os.environ.get("PGDATABASE", "mygisdb"),
                        str(out / f"{entry['table']}.pgdump")], check=True)
        with c.cursor() as cur:
            cur.execute(f'ANALYZE "{entry["table"]}"')
            cur.execute(f'SELECT count(*) FROM "{entry["table"]}"')
            n = cur.fetchone()[0]
    with c.cursor() as cur:
        for stem, table, cols, where, params in copy_specs(entry):
            cur.execute(f"DELETE FROM {table} WHERE {where}", params)
            with gzip.open(out / f"{stem}.csv.gz", "rt", encoding="utf-8") as fh:
                cur.copy_expert(f"COPY {table} ({cols}) FROM STDIN WITH (FORMAT csv)", fh)
            if table in ("acs_county_values", "geo_values") and entry["kind"] == "table":
                n = cur.rowcount
    c.commit()
    if entry["kind"] == "raster":
        return entry.get("rows") or n
    return n


# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--commit", action="store_true", help="load what is stale")
    ap.add_argument("--only", help="one ledger id")
    ap.add_argument("--force", action="store_true", help="reload even if current")
    ap.add_argument("--prefer-dump", action="store_true",
                    help="restore from a dump even when the raw files are present")
    ap.add_argument("--dump", metavar="ID", help="write a dump of one ledger entry")
    args = ap.parse_args()

    ledger = dataset_meta.read_ledger()
    entries = ledger["datasets"]
    if not entries:
        print("  the ledger is empty: nothing has been ingested")
        return 0
    c = conn()

    if args.dump:
        entry = next((e for e in entries if e["id"] == args.dump), None)
        if entry is None:
            sys.exit(f"  no ledger entry {args.dump!r}. Entries: "
                     f"{', '.join(e['id'] for e in entries)}")
        if db_state(c, entry) != "current":
            sys.exit(f"  {args.dump} is not loaded current in this database; nothing to dump")
        print(f"  dumping {entry['id']} -> {DUMP_ROOT / safe(entry['id'])}")
        entry["dump"] = dump(c, entry)
        dataset_meta.record_load(entry)   # keeps its original loaded_at
        for f in entry["dump"]["files"]:
            print(f"    {f['path']}  {f['bytes']:,} bytes")
        print("  recorded in the ledger. Copy the folder to the server's deploy/dumps/.")
        return 0

    todo = []
    print(f"\n  {'entry':<28} {'kind':<9} {'database':<9} {'raw files':<10} dump")
    for e in entries:
        if args.only and e["id"] != args.only:
            continue
        fs, bad = file_state(e)
        ds = dump_state(e)
        db = db_state(c, e)
        print(f"  {e['id']:<28} {e['kind']:<9} {db:<9} {fs:<10} {ds}")
        if fs == "changed":
            print(f"     ! these files differ from the bytes the catalog was written from:"
                  f" {', '.join(bad[:3])}. Refusing; re-ingest on the tagging machine.")
            continue
        if db == "current" and not args.force:
            continue
        if (fs == "ok" and not (args.prefer_dump and ds == "ok")):
            todo.append((e, "replay"))
        elif ds == "ok":
            todo.append((e, "restore"))
        else:
            print(f"     ! nothing to load from: raw files {fs}"
                  f"{' (' + ', '.join(bad[:2]) + ')' if bad else ''}, dump {ds}")

    if not todo:
        print("\n  nothing to do\n")
        return 0
    if not args.commit:
        print(f"\n  {len(todo)} would load: " + ", ".join(f"{e['id']} ({how})" for e, how in todo))
        print("  Nothing written; re-run with --commit.\n")
        return 0

    for e, how in todo:
        print(f"\n  {how} {e['id']} ...")
        if how == "restore":
            n = restore(c, e)
        elif e["kind"] == "features":
            n = load_features(c, e)
        elif e["kind"] == "table":
            n = load_table_values(c, e)
        elif e["kind"] == "raster":
            n = load_raster_data(c, e)
        else:
            print(f"     ! no replay route for kind {e['kind']!r} yet")
            continue
        expect = e.get("rows")
        flag = "" if expect in (None, n) else f"   ! ledger recorded {expect:,}"
        print(f"    {n:,} rows{flag}")
        record(c, e, n, how)
    c.close()
    print("\n  Done. make replay also relinks, re-embeds and reloads the corpus.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
