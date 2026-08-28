#!/usr/bin/env python3
"""
Pre-flight gate for catalog changes.

Run this BEFORE a new or edited geoark_attributes.csv reaches the pipeline. It
checks the things that actually break retrieval and planning when data is added
-- which, measured, are NOT the ones that look scariest.

WHAT WAS MEASURED
-----------------
Tags are 38% of the embedded text and the least reproducible part of the
catalog. Removing them ENTIRELY changed nothing on the 37-query eval (see
eval/README.md). So tag drift between differently-tagged batches is a minor
risk, and this tool warns about it rather than failing.

What does break things, in rough order:
  - duplicate attr_label      silently shadows rows; attribute_source is keyed on it
  - missing attr_orig         the row can never resolve to a column -> unplannable
  - changed column set        loadVariablesFromCSV reads fields positionally by name
  - entity_type drift         new values break the geographic_level filter
  - encoding / delimiter      corrupts every downstream text field

Usage:
    python3 etl/validate_catalog.py --new path/to/new_geoark_attributes.csv
    python3 etl/validate_catalog.py --new NEW.csv --baseline backend/geoark_attributes.csv
    python3 etl/validate_catalog.py --new NEW.csv --json report.json

Exit codes:  0 clean (warnings allowed) | 1 errors found | 2 unreadable
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import re
import sys
from pathlib import Path

csv.field_size_limit(10**9)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = ROOT / "backend" / "geoark_attributes.csv"

# Fields the running code reads. Losing any of these breaks it silently,
# because every read is `row.get(x) or ""`.
REQUIRED = ["dataset_id", "attr_label", "attr_desc", "entity_type", "tags"]
USED_BY_CODE = REQUIRED + ["dataset_clean", "attr_orig", "start_date", "end_date",
                           "spatial_rep", "attr_id"]
KNOWN_ENTITY_TYPES = {"COUNTY", "STATE", "TRACT", "BLOCKGROUP", "BLOCK", ""}

_C = sys.stdout.isatty()
RED, YEL, GRN, DIM, OFF = ("\033[31m", "\033[33m", "\033[32m", "\033[2m", "\033[0m") if _C else ("",) * 5


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.info: dict = {}

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def read_catalog(path: Path) -> tuple[list[dict], list[str]]:
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        return list(reader), list(reader.fieldnames or [])


def check_schema(cols: list[str], rep: Report) -> None:
    missing = [c for c in REQUIRED if c not in cols]
    if missing:
        rep.error(f"missing required column(s): {', '.join(missing)}")
    soft = [c for c in USED_BY_CODE if c not in cols and c not in missing]
    if soft:
        rep.warn(f"columns read by the code but absent (they will be empty for every row): "
                 f"{', '.join(soft)}")


def check_identity(rows: list[dict], rep: Report) -> None:
    # attr_label is the key attribute_source is built on; duplicates shadow.
    labels = collections.Counter((r.get("attr_label") or "").strip() for r in rows)
    blank = labels.pop("", 0)
    if blank:
        rep.error(f"{blank} row(s) have a blank attr_label; they can never be planned against")
    dupes = {k: v for k, v in labels.items() if v > 1}
    if dupes:
        sample = ", ".join(list(dupes)[:4])
        rep.error(f"{len(dupes)} duplicate attr_label value(s), covering "
                  f"{sum(dupes.values())} rows (e.g. {sample}). attribute_source is keyed "
                  f"on attr_label, so later rows silently shadow earlier ones.")
    rep.info["rows"] = len(rows)
    rep.info["unique_attr_label"] = len(labels)


def check_resolvability(rows: list[dict], rep: Report) -> None:
    """attr_orig carries the census code; without it a row cannot be executed."""
    no_code = [r for r in rows if not (r.get("attr_orig") or "").strip()]
    pct = 100 * len(no_code) / max(len(rows), 1)
    rep.info["rows_without_attr_orig"] = len(no_code)
    if pct > 50:
        rep.warn(f"{len(no_code)} rows ({pct:.0f}%) have no attr_orig. Those can be "
                 f"searched but never planned against -- /api/analyze will skip them.")
    elif no_code:
        rep.info["note_attr_orig"] = f"{len(no_code)} rows ({pct:.1f}%) lack attr_orig"


def check_entity_types(rows: list[dict], rep: Report) -> None:
    seen = collections.Counter((r.get("entity_type") or "").strip().upper() for r in rows)
    unknown = {k: v for k, v in seen.items() if k not in KNOWN_ENTITY_TYPES}
    if unknown:
        rep.error(f"unrecognised entity_type value(s): {dict(list(unknown.items())[:5])}. "
                  f"The decomposer's geographic_level enum and the eval suite only know "
                  f"{sorted(KNOWN_ENTITY_TYPES - {''})}.")
    rep.info["entity_types"] = dict(seen)


def check_tags(rows: list[dict], rep: Report) -> None:
    """
    Tags are advisory. Measured, removing them all changes nothing on the eval
    suite -- so format drift is a warning, never an error.
    """
    bad, empty = 0, 0
    for r in rows:
        t = (r.get("tags") or "").strip()
        if not t:
            empty += 1
        elif not (t.startswith("[") and t.endswith("]")):
            bad += 1
    if bad:
        rep.warn(f"{bad} row(s) have tags not in the \"['a', 'b']\" form used by the rest "
                 f"of the catalog. Parsing is lenient, so this degrades rather than breaks.")
    if empty:
        rep.info["rows_without_tags"] = empty


def check_text_health(rows: list[dict], rep: Report) -> None:
    """Encoding and delimiter damage shows up as mojibake or absurd field lengths."""
    mojibake = sum(1 for r in rows if re.search(r"[ÃÂ]\w", (r.get("attr_desc") or "")))
    if mojibake:
        rep.error(f"{mojibake} row(s) show mojibake in attr_desc "
                  f"(e.g. 'Ã©'). The file is probably not UTF-8.")
    huge = sum(1 for r in rows if len(r.get("attr_desc") or "") > 600)
    if huge:
        rep.warn(f"{huge} row(s) have an attr_desc over 600 chars; the embedder truncates "
                 f"context and BM25 length-normalises against them.")
    blank_desc = sum(1 for r in rows if not (r.get("attr_desc") or "").strip())
    if blank_desc:
        rep.warn(f"{blank_desc} row(s) have no attr_desc. With tags contributing nothing "
                 f"measurable, these are near-unretrievable.")


def compare_to_baseline(rows: list[dict], cols: list[str],
                        base_rows: list[dict], base_cols: list[str], rep: Report) -> None:
    """A diff is what turns 'is this file valid' into 'is this change safe'."""
    dropped = [c for c in base_cols if c not in cols]
    added = [c for c in cols if c not in base_cols]
    if dropped:
        rep.error(f"column(s) present in the baseline but missing here: {', '.join(dropped)}")
    if added:
        rep.info["new_columns"] = added

    base_ids = {(r.get("attr_label") or "").strip() for r in base_rows}
    new_ids = {(r.get("attr_label") or "").strip() for r in rows}
    removed = base_ids - new_ids
    rep.info["attributes_added"] = len(new_ids - base_ids)
    rep.info["attributes_removed"] = len(removed)
    if removed:
        rep.warn(f"{len(removed)} attribute(s) present in the baseline are gone. Any saved "
                 f"plan or bookmark referencing them will stop resolving.")

    # Tag vocabulary overlap: low overlap means a different tagger, which is
    # worth knowing even though it is not measurably harmful.
    def vocab(rs):
        v = collections.Counter()
        for r in rs:
            for t in re.sub(r"[\[\]'\"]", "", r.get("tags") or "").split(","):
                t = t.strip().lower()
                if t:
                    v[t] += 1
        return v

    nv, bv = vocab(rows), vocab(base_rows)
    only_new = set(nv) - set(bv)
    if nv:
        share = 100 * sum(nv[t] for t in only_new) / sum(nv.values())
        rep.info["tag_vocab_new_terms"] = len(only_new)
        rep.info["tag_uses_from_new_terms_pct"] = round(share, 1)
        if share > 40:
            rep.warn(f"{share:.0f}% of tag uses are vocabulary absent from the baseline. "
                     f"That usually means a different tagger (model or prompt). Measured "
                     f"impact of tags on retrieval is nil, so this is informational -- but "
                     f"record what generated them (see etl/PROVENANCE.md).")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--new", type=Path, required=True, help="catalog CSV to validate")
    ap.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE,
                    help="catalog to diff against (default: the committed one)")
    ap.add_argument("--json", type=Path, help="write the report as JSON")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors")
    args = ap.parse_args()

    rep = Report()
    try:
        rows, cols = read_catalog(args.new)
    except Exception as exc:
        print(f"{RED}cannot read {args.new}: {exc}{OFF}")
        return 2

    print(f"validating {args.new.name}: {len(rows)} rows, {len(cols)} columns\n")

    check_schema(cols, rep)
    check_identity(rows, rep)
    check_resolvability(rows, rep)
    check_entity_types(rows, rep)
    check_tags(rows, rep)
    check_text_health(rows, rep)

    if args.baseline and args.baseline.exists() and args.baseline != args.new:
        base_rows, base_cols = read_catalog(args.baseline)
        print(f"{DIM}diffing against {args.baseline.name} ({len(base_rows)} rows){OFF}\n")
        compare_to_baseline(rows, cols, base_rows, base_cols, rep)

    for k, v in rep.info.items():
        print(f"  {DIM}{k:32s}{OFF} {v}")
    print()
    for w in rep.warnings:
        print(f"  {YEL}WARN {OFF} {w}")
    for e in rep.errors:
        print(f"  {RED}ERROR{OFF} {e}")

    if args.json:
        args.json.write_text(json.dumps(
            {"errors": rep.errors, "warnings": rep.warnings, "info": rep.info}, indent=2))
        print(f"\n  report -> {args.json}")

    if rep.errors:
        print(f"\n{RED}{len(rep.errors)} error(s). Do not load this catalog.{OFF}")
        return 1
    if rep.warnings and args.strict:
        print(f"\n{RED}{len(rep.warnings)} warning(s), and --strict was given.{OFF}")
        return 1
    print(f"\n{GRN}No errors."
          f"{' ' + str(len(rep.warnings)) + ' warning(s) to review.' if rep.warnings else ''}{OFF}")
    print(f"{DIM}After loading: re-run `make load-reference`, then "
          f"`python3 eval/run.py --compare <previous>.json` to catch regressions.{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
