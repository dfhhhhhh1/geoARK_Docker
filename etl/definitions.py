"""
Load published definitions of qualitative terms into `concept_definition`.

    python3 etl/definitions.py            # dry run: parse, check shape, report
    python3 etl/definitions.py --commit   # replace the table's contents

Two sources, one table:

  etl/definitions.yaml        measures loaded outside the sidecar path
  etl/data_manifest.yaml      `definitions:` a sidecar declared under a column,
                              recorded by ingest.py with the measure code it
                              became (so replay on the server gets them too)

THIS FILE CHECKS SHAPE ONLY: a rule parses, a scale is known, vintages are a
range, a citation exists. Whether a definition still FITS THE DATA is checked
by the API at startup (backend/definitions.js), against whatever vintage is
actually loaded there. Checking it here would only tell you about the database
the loader ran against, and the two can differ: replay loads data on the
server, values get reloaded, a new vintage arrives. A definition is a claim
about a measure, so it is re-tested wherever that measure is read.

The table is replaced wholesale in one transaction: it is derived entirely from
files in git, so there is nothing in it worth merging with.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the etl-geo image has it
    yaml = None

HERE = Path(__file__).resolve().parent
REGISTRY = Path(os.environ.get("DEFINITIONS_FILE", HERE / "definitions.yaml"))
LEDGER = Path(os.environ.get("DATA_MANIFEST", HERE / "data_manifest.yaml"))

SCALES = ("percent", "fraction", "code", "flag", "count")
OPS = ("<", "<=", ">", ">=", "=", "!=")
RULE = re.compile(r"^\s*(<=|>=|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)\s*$")
ID = re.compile(r"^[a-z][a-z0-9_]{1,62}$")

DDL = """
CREATE TABLE IF NOT EXISTS concept_definition (
    id            text NOT NULL,
    measure_code  text NOT NULL,
    term          text NOT NULL,
    op            text NOT NULL,
    value         double precision NOT NULL,
    scale         text NOT NULL,
    vintage_from  smallint NOT NULL,
    vintage_to    smallint NOT NULL,
    source        text NOT NULL,
    url           text,
    origin        text NOT NULL,
    PRIMARY KEY (id, measure_code)
)
"""


def parse_rule(rule) -> tuple[str, float] | None:
    m = RULE.match(str(rule or ""))
    return (m.group(1), float(m.group(2))) if m else None


def check(entry: dict, where: str) -> list[str]:
    """Shape errors for one definition, worded for the person who wrote it."""
    errs = []
    did = entry.get("id")
    if not isinstance(did, str) or not ID.match(did):
        errs.append(f"{where}: id {did!r} must be lower_snake_case")
    for key in ("term", "source"):
        if not str(entry.get(key) or "").strip():
            errs.append(f"{where}: '{key}' is required (it is shown to the user)")
    measures = entry.get("measures")
    if not isinstance(measures, list) or not measures or \
            not all(isinstance(m, str) and m.strip() for m in measures):
        errs.append(f"{where}: 'measures' must be a non-empty list of measure codes")
    if entry.get("scale") not in SCALES:
        errs.append(f"{where}: scale {entry.get('scale')!r}; expected one of {SCALES}")
    if not parse_rule(entry.get("rule")):
        errs.append(f"{where}: rule {entry.get('rule')!r}; expected e.g. '>= 4' "
                    f"(one of {' '.join(OPS)}, then a number)")
    v = entry.get("vintages")
    if not (isinstance(v, list) and len(v) == 2 and all(isinstance(y, int) for y in v)
            and 1900 <= v[0] <= v[1] <= 2100):
        errs.append(f"{where}: 'vintages' must be [first_year, last_year]. Required: "
                    f"code schemes change between releases, and a rule written for "
                    f"one vintage must not be applied to another")
    return errs


def from_sidecar(meta: dict, code_of, codes: set[str]) -> tuple[list[dict], list[str]]:
    """
    The definitions a sidecar declares under its columns, as registry entries.

    `code_of(column)` gives the measure code the column was loaded as; a
    definition on a column that produced no measure is reported, not dropped
    silently. Vintages default to the dataset's own: a definition declared in a
    2022 sidecar describes the 2022 data.
    """
    out, errs = [], []
    lo, hi = meta.get("start_year"), meta.get("end_year")
    for column, spec in (meta.get("columns") or {}).items():
        defs = (spec or {}).get("definitions") if isinstance(spec, dict) else None
        if not defs:
            continue
        code = code_of(column)
        if code not in codes:
            errs.append(f"columns.{column}: has definitions but was not loaded as a "
                        f"measure ({code})")
            continue
        for i, d in enumerate(defs if isinstance(defs, list) else [defs]):
            entry = {**d, "measures": [code]}
            entry.setdefault("id", re.sub(r"[^a-z0-9]+", "_",
                                          f"{code}_{d.get('term', i)}".lower()).strip("_")[:62])
            if "vintages" not in entry and isinstance(lo, int):
                entry["vintages"] = [lo, hi if isinstance(hi, int) else lo]
            entry.setdefault("source", meta.get("originator") or meta.get("name"))
            entry.setdefault("url", meta.get("source_url"))
            errs += check(entry, f"columns.{column}.definitions[{i}]")
            out.append(entry)
    return out, errs


def collect(registry: Path = REGISTRY, ledger: Path = LEDGER) -> tuple[list[dict], list[str]]:
    """Every definition from both sources, with where it came from."""
    if yaml is None:
        raise SystemExit("PyYAML is missing")
    entries, errs = [], []
    if registry.exists():
        doc = yaml.safe_load(registry.read_text(encoding="utf-8")) or {}
        for i, d in enumerate(doc.get("definitions") or []):
            errs += check(d, f"{registry.name}[{i}]")
            entries.append({**d, "origin": registry.name})
    if ledger.exists():
        doc = yaml.safe_load(ledger.read_text(encoding="utf-8")) or {}
        for ds in doc.get("datasets") or []:
            for i, d in enumerate(ds.get("definitions") or []):
                errs += check(d, f"{ledger.name}:{ds.get('id')}[{i}]")
                entries.append({**d, "origin": f"ledger:{ds.get('id')}"})
    seen = {}
    for e in entries:
        if e.get("id") in seen:
            errs.append(f"duplicate id {e['id']!r} ({seen[e['id']]} and {e['origin']})")
        seen[e.get("id")] = e["origin"]
    return entries, errs


def rows(entries: list[dict]) -> list[tuple]:
    out = []
    for e in entries:
        op, value = parse_rule(e["rule"])
        for code in e["measures"]:
            out.append((e["id"], code, e["term"], op, value, e["scale"],
                        e["vintages"][0], e["vintages"][1], e["source"],
                        e.get("url"), e["origin"]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--commit", action="store_true", help="replace concept_definition")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()

    entries, errs = collect()
    for e in errs:
        print(f"  ERROR  {e}")
    if errs:
        print(f"\n  REFUSED: {len(errs)} problem(s); nothing written")
        return 1
    table = rows(entries)
    for r in table:
        print(f"  {r[0]:<28} {r[1]:<28} {r[3]} {r[4]:g}  [{r[5]}, {r[6]}-{r[7]}]  ({r[10]})")
    print(f"\n  {len(entries)} definition(s), {len(table)} measure binding(s)")
    if not args.commit:
        print("  dry run; --commit to write")
        return 0

    import psycopg2                                              # noqa: PLC0415
    conn = psycopg2.connect(args.dsn) if args.dsn else psycopg2.connect()
    with conn, conn.cursor() as cur:
        cur.execute(DDL)
        cur.execute("DELETE FROM concept_definition")
        cur.executemany(
            "INSERT INTO concept_definition (id, measure_code, term, op, value, scale, "
            "vintage_from, vintage_to, source, url, origin) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", table)
    conn.close()
    print("  written. The API re-reads them on POST /api/reload-corpus "
          "(make reload-corpus), and checks each against the loaded data.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
