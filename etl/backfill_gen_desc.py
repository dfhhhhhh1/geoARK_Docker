#!/usr/bin/env python3
"""
Fill the `gen_desc` column for catalog rows whose description says nothing.

    python3 etl/backfill_gen_desc.py --catalog backend/geoark_attributes.csv
    python3 etl/backfill_gen_desc.py --catalog backend/geoark_attributes.csv --commit

WHY. 392 facility rows have an `attr_desc` that is a bare column name --
"Name", "Objectid", "Website" -- and about a third of the county-measure rows
are two words ("BIRTHS", "Premature death"). Those rows carry almost no text for
retrieval to match on, and this project has already measured that the text
matters: removing tags cost 41.7pp of known-item recall@1. A row whose entire
signal is the word "Name" is a row that can only be found by accident.

The generator for this has existed all along inside etl/ingest.py -- it asks the
tagger for tags AND a one-sentence description, then throws the sentence away.
This writes it into a column the embedder reads, which is the whole change.

SAME MODEL, SAME SETTINGS. gemma3:4b at temperature 0.1 with constrained JSON,
which is what PROVENANCE.md records for the existing catalog. Using a different
tagger produces a catalog that is internally inconsistent in a way retrieval
cannot report.

ONLY THE THIN ROWS. Regenerating all 7,128 would cost hours and would overwrite
good ACS descriptions -- "Estimate!!INCOME AND BENEFITS!!Median household
income" is already the best text available for that row. The whole point is to
give text to rows that have none.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
TAG_MODEL = os.environ.get("TAG_MODEL", "gemma3:4b")

DESC_SCHEMA = {
    "type": "object",
    "properties": {"gen_desc": {"type": "string"}},
    "required": ["gen_desc"],
}

# Words that make a description worthless on their own: they name the COLUMN
# rather than what it holds, so every layer that has one looks identical.
STOP_DESCS = {
    "name", "objectid", "website", "type", "status", "id", "fid", "shape",
    "geometry", "the_geom", "address", "city", "state", "zip", "county",
    "latitude", "longitude", "x", "y", "value", "count", "source", "notes",
}


def is_thin(desc: str, attr_orig: str) -> bool:
    """
    A description is thin when it carries no more information than the column
    name already does. Two words or fewer, or a bare identifier, or simply a
    restatement of attr_orig.
    """
    d = (desc or "").strip()
    if not d:
        return True
    words = [w for w in re.split(r"[^A-Za-z]+", d) if w]
    if len(words) <= 2:
        return True
    if d.strip().lower() in STOP_DESCS:
        return True
    if attr_orig and d.strip().lower() == attr_orig.strip().lower():
        return True
    return False


def describe(dataset: str, column: str, existing: str, timeout: int = 45) -> str:
    """One sentence for one column. Empty string on any failure."""
    prompt = (
        f"Dataset: {dataset}\n"
        f"Column: {column}\n"
        + (f"Current label: {existing}\n" if existing else "")
        + "In one sentence, say what this column holds and what someone would "
          "use it for. Do not repeat the column name alone."
    )
    body = json.dumps({
        "model": TAG_MODEL,
        "prompt": prompt,
        "format": DESC_SCHEMA,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 90},
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode())
        out = json.loads(payload.get("response", "{}")).get("gen_desc", "")
        return " ".join(str(out).split()).strip()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return ""


def merge_sidecar(catalog: Path, sidecar: Path) -> int:
    """Apply a sidecar of (attr_id, gen_desc) to the catalog, on the host."""
    with sidecar.open(encoding="utf-8-sig", newline="") as fh:
        # Keyed on attr_label, NOT attr_id: attr_id is blank on 6,813 of the
        # 7,128 catalog rows and duplicated on almost all the rest, so it
        # cannot identify a row. attr_label is unique with no blanks.
        got = {r["attr_label"]: r["gen_desc"] for r in csv.DictReader(fh)
               if (r.get("gen_desc") or "").strip()}
    with catalog.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        header = list(reader.fieldnames)
        rows = list(reader)
    if "gen_desc" not in header:
        header.append("gen_desc")
    applied = 0
    for r in rows:
        r.setdefault("gen_desc", "")
        text = got.get(r["attr_label"])
        if text and not (r.get("gen_desc") or "").strip():
            r["gen_desc"] = text
            applied += 1
    with catalog.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=header, lineterminator="\r\n")
        w.writeheader()
        w.writerows(rows)
    print(f"  merged {applied} descriptions into {catalog.name}")
    print("  next: make reindex, then restart the API")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", type=Path, required=True)
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--limit", type=int, help="stop after N rows, for a trial")
    # The tagger lives on the docker network and the catalog is mounted
    # read-only inside it, so generation and writing happen in different places.
    # --out writes a two-column sidecar from the container; --merge applies it
    # on the host. It is also a resume point: a run that dies keeps its work.
    ap.add_argument("--out", type=Path,
                    help="write (attr_id, gen_desc) here instead of the catalog")
    ap.add_argument("--merge", type=Path,
                    help="apply a sidecar produced by --out to the catalog")
    args = ap.parse_args()

    if args.merge:
        return merge_sidecar(args.catalog, args.merge)

    with args.catalog.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        header = list(reader.fieldnames)
        rows = list(reader)

    if "gen_desc" not in header:
        # Appended, not inserted: the column order of this file is part of what
        # the embedder hashes, and moving existing columns would invalidate
        # every cached vector for no reason.
        header.append("gen_desc")
        for r in rows:
            r.setdefault("gen_desc", "")

    todo = [r for r in rows
            if not (r.get("gen_desc") or "").strip()
            and is_thin(r.get("attr_desc", ""), r.get("attr_orig", ""))]
    print(f"{len(rows)} catalog rows, {len(todo)} with nothing useful to match on")

    by_ds = {}
    for r in todo:
        by_ds[r.get("dataset_clean") or "?"] = by_ds.get(r.get("dataset_clean") or "?", 0) + 1
    for ds, n in sorted(by_ds.items(), key=lambda kv: -kv[1])[:8]:
        print(f"   {n:5d}  {ds[:52]}")

    if not args.commit:
        print("\n  dry run; nothing written. Re-run with --commit")
        return 0

    if args.limit:
        todo = todo[:args.limit]

    sink = None
    if args.out:
        sink = args.out.open("w", encoding="utf-8", newline="")
        writer = csv.writer(sink, lineterminator="\r\n")
        writer.writerow(["attr_label", "gen_desc"])

    started, done, failed = time.time(), 0, 0
    for i, r in enumerate(todo, 1):
        text = describe(r.get("dataset_clean", ""), r.get("attr_orig") or r.get("attr_desc", ""),
                        r.get("attr_desc", ""))
        if text:
            r["gen_desc"] = text
            done += 1
            if sink:
                writer.writerow([r["attr_label"], text])
                sink.flush()          # so a killed run keeps its work
        else:
            failed += 1
        if i % 25 == 0 or i == len(todo):
            rate = i / max(time.time() - started, 1)
            left = (len(todo) - i) / max(rate, 0.01)
            print(f"   {i}/{len(todo)}  ok={done} failed={failed}  "
                  f"{rate:.1f}/s  ~{left/60:.0f} min left")

    if sink:
        sink.close()
        print(f"\n  wrote {done} descriptions ({failed} failed) to {args.out.name}")
        print(f"  next, on the host: python3 etl/backfill_gen_desc.py "
              f"--catalog backend/geoark_attributes.csv --merge {args.out.name}")
        return 0

    # Written whole rather than appended: an interrupted run leaves the rows it
    # did finish, and re-running skips them because gen_desc is now non-empty.
    with args.catalog.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=header, lineterminator="\r\n")
        w.writeheader()
        w.writerows(rows)
    print(f"\n  wrote {done} descriptions ({failed} failed) to {args.catalog.name}")
    print("  next: make reindex, then restart the API")
    return 0


if __name__ == "__main__":
    sys.exit(main())
