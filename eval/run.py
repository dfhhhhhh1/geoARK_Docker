#!/usr/bin/env python3
"""
GeoARK retrieval evaluation harness.

Measures whether retrieval finds what a query needs, so that prompt, model, and
ranking changes can be judged by a number instead of by vibes.

    python3 eval/run.py                               # run against a live stack
    python3 eval/run.py --save baseline.json          # record a baseline
    python3 eval/run.py --compare baseline.json       # diff against it
    python3 eval/run.py --endpoint unified            # full pipeline, not raw search
    python3 eval/run.py --suite multi_concept         # one suite only
    python3 eval/run.py --validate-only               # check assertions, no API calls

METRICS
  concept recall@k   fraction of required concepts found anywhere in the top k.
                     The headline number.
  query success      fraction of queries where EVERY concept was found. Harsh on
                     purpose: a multi-concept query that drops the normalizer is
                     not a success, even if the primary concept ranked first.
  MRR                mean of 1/rank of each concept's first matching result.
                     Moves when good results get ranked higher, which recall
                     alone cannot see.
  latency            p50 / p95 wall-clock per query.

EXIT CODE is 0 unless --fail-under is set and concept recall falls below it,
so this can gate CI later.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = ROOT / "backend" / "geoark_attributes.csv"
DEFAULT_SUITE = Path(__file__).resolve().parent / "queries.yaml"

# ANSI, disabled when piped.
_C = sys.stdout.isatty()
GREEN, RED, YELLOW, DIM, BOLD, OFF = (
    ("\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m", "\033[0m")
    if _C else ("",) * 6
)


# --------------------------------------------------------------------------- #
# predicates
# --------------------------------------------------------------------------- #

def row_matches(row: dict, pred: dict) -> bool:
    """
    Does one result row satisfy one predicate?

    Every listed field must match (AND). `any_of` holds sub-predicates joined
    with OR. Field names map onto what the API returns, which for historical
    reasons is not identical to the CSV's column names.
    """
    if "any_of" in pred:
        return any(row_matches(row, p) for p in pred["any_of"])

    checks = (
        ("desc", row.get("attr_desc") or ""),
        ("tags", row.get("tags") or ""),
        ("dataset", row.get("dataset_clean") or ""),
    )
    for key, haystack in checks:
        if key in pred and not re.search(pred[key], haystack, re.I):
            return False
    if "entity" in pred and (row.get("entity_type") or "") != pred["entity"]:
        return False
    return True


def load_suites(path: Path, only: str | None) -> list[dict]:
    suites = yaml.safe_load(path.read_text())["suites"]
    if only:
        suites = [s for s in suites if s["name"] == only]
        if not suites:
            sys.exit(f"no suite named {only!r}")
    return suites


# --------------------------------------------------------------------------- #
# validation: is every assertion actually satisfiable?
# --------------------------------------------------------------------------- #

def validate(suites: list[dict], csv_path: Path) -> int:
    """
    Check each concept predicate against the catalog itself.

    An unsatisfiable assertion is worse than no assertion: it looks like a
    permanent retrieval failure and quietly drags the headline metric down. So
    the suite is checked before it is ever trusted.
    """
    rows = list(csv.DictReader(csv_path.open(encoding="utf-8")))
    print(f"validating assertions against {len(rows)} catalog rows\n")
    bad = 0
    for suite in suites:
        for q in suite["queries"]:
            for name, pred in q["concepts"].items():
                n = sum(1 for r in rows if row_matches(r, pred))
                if n == 0:
                    print(f"  {RED}UNSATISFIABLE{OFF} {q['id']}/{name}: {pred}")
                    bad += 1
                elif n < 3:
                    print(f"  {YELLOW}only {n} row(s){OFF}  {q['id']}/{name}: {pred}")
    if bad:
        print(f"\n{RED}{bad} assertion(s) match nothing in the catalog.{OFF}")
    else:
        print(f"  {GREEN}all {sum(len(q['concepts']) for s in suites for q in s['queries'])} "
              f"assertions are satisfiable{OFF}")
    return bad


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

def call_api(base: str, endpoint: str, query: str, top_k: int, timeout: int,
             llm_filter: bool = True):
    """Return (results, seconds). Normalizes the two endpoints' response shapes."""
    started = time.perf_counter()
    if endpoint == "search":
        url = f"{base}/api/search?" + urllib.parse.urlencode({"q": query})
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            f"{base}/api/unified-search",
            data=json.dumps({"q": query, "top_k": top_k,
                             "use_llm_filter": llm_filter}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    elapsed = time.perf_counter() - started

    if isinstance(payload, list):
        return payload, elapsed
    for key in ("all_results", "results", "top_variables"):
        if isinstance(payload.get(key), list):
            return payload[key], elapsed
    return [], elapsed


# --------------------------------------------------------------------------- #
# scoring
# --------------------------------------------------------------------------- #

def score_query(q: dict, results: list[dict], top_k: int) -> dict:
    """Find the rank of the first result satisfying each concept (1-based)."""
    found: dict[str, int | None] = {}
    for name, pred in q["concepts"].items():
        found[name] = next(
            (i + 1 for i, row in enumerate(results[:top_k]) if row_matches(row, pred)),
            None,
        )
    hits = [r for r in found.values() if r]
    return {
        "id": q["id"],
        "query": q["query"],
        "n_results": len(results),
        "concepts": found,
        "n_concepts": len(found),
        "n_found": len(hits),
        "all_found": len(hits) == len(found),
        "mrr": statistics.mean([1 / r for r in hits]) if hits else 0.0,
    }


def run(suites, base, endpoint, top_k, timeout, llm_filter=True) -> dict:
    per_suite, latencies, errors = {}, [], []
    for suite in suites:
        rows = []
        print(f"\n{BOLD}{suite['name']}{OFF}")
        for q in suite["queries"]:
            try:
                results, secs = call_api(base, endpoint, q["query"], top_k,
                                         timeout, llm_filter)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                print(f"  {RED}ERROR{OFF} {q['id']}: {exc}")
                errors.append({"id": q["id"], "error": str(exc)})
                continue
            latencies.append(secs)
            row = score_query(q, results, top_k)
            row["seconds"] = round(secs, 3)
            rows.append(row)

            mark = f"{GREEN}PASS{OFF}" if row["all_found"] else f"{RED}FAIL{OFF}"
            detail = "  ".join(
                f"{n}@{r}" if r else f"{RED}{n}:miss{OFF}"
                for n, r in row["concepts"].items()
            )
            print(f"  {mark} {row['id']:28s} {detail}{DIM}  ({secs:.2f}s){OFF}")
        per_suite[suite["name"]] = rows

    allrows = [r for rows in per_suite.values() for r in rows]
    concepts_total = sum(r["n_concepts"] for r in allrows)
    concepts_found = sum(r["n_found"] for r in allrows)
    return {
        "endpoint": endpoint,
        "llm_filter": llm_filter,
        "top_k": top_k,
        "queries": len(allrows),
        "errors": errors,
        "concept_recall": concepts_found / concepts_total if concepts_total else 0.0,
        "query_success": (sum(r["all_found"] for r in allrows) / len(allrows)) if allrows else 0.0,
        "mrr": statistics.mean([r["mrr"] for r in allrows]) if allrows else 0.0,
        "latency_p50": round(statistics.median(latencies), 3) if latencies else 0.0,
        "latency_p95": round(sorted(latencies)[int(len(latencies) * 0.95) - 1], 3) if latencies else 0.0,
        "per_suite": {
            name: {
                "concept_recall": (sum(r["n_found"] for r in rows) /
                                   sum(r["n_concepts"] for r in rows)) if rows else 0.0,
                "query_success": (sum(r["all_found"] for r in rows) / len(rows)) if rows else 0.0,
            }
            for name, rows in per_suite.items()
        },
        "detail": per_suite,
    }


def report(res: dict) -> None:
    print(f"\n{BOLD}{'=' * 62}{OFF}")
    flt = "" if res.get("llm_filter", True) else "  llm_filter=OFF"
    print(f"{BOLD}  {res['endpoint']}  top_k={res['top_k']}  n={res['queries']}{flt}{OFF}")
    print(f"{BOLD}{'=' * 62}{OFF}")
    print(f"  concept recall  {res['concept_recall']:6.1%}   (found / required)")
    print(f"  query success   {res['query_success']:6.1%}   (all concepts found)")
    print(f"  MRR             {res['mrr']:6.3f}")
    print(f"  latency         p50 {res['latency_p50']:.2f}s   p95 {res['latency_p95']:.2f}s")
    print(f"\n  {DIM}by suite{OFF}")
    for name, s in res["per_suite"].items():
        print(f"    {name:22s} recall {s['concept_recall']:6.1%}   success {s['query_success']:6.1%}")
    if res["errors"]:
        print(f"\n  {RED}{len(res['errors'])} request error(s){OFF}")


def compare(new: dict, old: dict) -> None:
    print(f"\n{BOLD}vs baseline{OFF}")
    for key, fmt in (("concept_recall", "{:.1%}"), ("query_success", "{:.1%}"),
                     ("mrr", "{:.3f}"), ("latency_p50", "{:.2f}s"), ("latency_p95", "{:.2f}s")):
        o, n = old.get(key, 0), new.get(key, 0)
        delta = n - o
        lower_is_better = key.startswith("latency")
        good = (delta < 0) if lower_is_better else (delta > 0)
        color = GREEN if (good and abs(delta) > 1e-9) else (RED if abs(delta) > 1e-9 else DIM)
        arrow = "=" if abs(delta) < 1e-9 else ("+" if delta > 0 else "")
        print(f"  {key:16s} {fmt.format(o)} -> {fmt.format(n)}   "
              f"{color}{arrow}{fmt.format(delta)}{OFF}")

    moved = []
    for suite, rows in new["detail"].items():
        old_rows = {r["id"]: r for r in old["detail"].get(suite, [])}
        for r in rows:
            o = old_rows.get(r["id"])
            if o and o["all_found"] != r["all_found"]:
                moved.append((r["id"], o["all_found"], r["all_found"]))
    if moved:
        print(f"\n{BOLD}  queries that flipped{OFF}")
        for qid, was, now in moved:
            tag = f"{GREEN}now passes{OFF}" if now else f"{RED}now fails{OFF}"
            print(f"    {qid:28s} {tag}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:8080",
                    help="API base URL (default: nginx at :8080)")
    ap.add_argument("--endpoint", choices=["search", "unified"], default="search",
                    help="'search' = raw hybrid search; 'unified' = full pipeline with LLM")
    ap.add_argument("--suite", help="run only this suite")
    ap.add_argument("--suite-file", type=Path, default=DEFAULT_SUITE)
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--save", type=Path, help="write results as JSON")
    ap.add_argument("--compare", type=Path, help="diff against a saved run")
    ap.add_argument("--validate-only", action="store_true")
    ap.add_argument("--skip-validate", action="store_true")
    ap.add_argument("--no-llm-filter", action="store_true",
                    help="unified endpoint only: skip the LLM verification step, "
                         "to measure what it costs and what it discards")
    ap.add_argument("--fail-under", type=float,
                    help="exit 1 if concept recall is below this (0-1)")
    args = ap.parse_args()

    suites = load_suites(args.suite_file, args.suite)

    if not args.skip_validate or args.validate_only:
        if validate(suites, args.csv) and not args.validate_only:
            print(f"{RED}refusing to run with unsatisfiable assertions{OFF}")
            return 2
    if args.validate_only:
        return 0

    res = run(suites, args.base.rstrip("/"), args.endpoint, args.top_k,
              args.timeout, llm_filter=not args.no_llm_filter)
    report(res)

    if args.compare:
        compare(res, json.loads(args.compare.read_text()))
    if args.save:
        args.save.write_text(json.dumps(res, indent=2))
        print(f"\n  saved -> {args.save}")

    if args.fail_under is not None and res["concept_recall"] < args.fail_under:
        print(f"\n{RED}concept recall {res['concept_recall']:.1%} "
              f"< --fail-under {args.fail_under:.1%}{OFF}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
