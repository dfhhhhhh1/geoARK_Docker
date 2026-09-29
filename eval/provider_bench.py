#!/usr/bin/env python3
"""
Compare the local planner against a hosted one, on latency AND on correctness.

    python3 eval/provider_bench.py --suite eval/plan_correctness.yaml
    python3 eval/provider_bench.py --suite eval/wild_queries.yaml --repeat 2

WHY NOT JUST TIME IT. The obvious benchmark is wall-clock per query, and on its
own it would be actively misleading here. A hosted model that answers in 3s and
plans the wrong analysis is worse than a local one that takes 40s and plans the
right one -- this project has a documented history of exactly that trade being
read the wrong way round, when a PLAN_MODEL comparison measured example-copying
fidelity and was reported as planner capacity. So every query is scored on
`expect_op` where the suite declares one, and both arms are printed side by
side: seconds, plan validity, op appropriateness.

WHAT IT SENDS. The google arm transmits each question and its retrieved
attribute list to Google. That is the thing being traded for speed, and it is
worth being deliberate about before running this over a suite of real user
questions.

The server must be started with GOOGLE_API_KEY set; the provider is chosen per
request, so one running instance serves both arms and nothing is restarted
between them.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml


def call(base: str, query: str, provider: str, timeout: int):
    body = json.dumps({"q": query, "execute": False, "provider": provider}).encode()
    req = urllib.request.Request(f"{base}/api/analyze", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode()), time.time() - t0
        except Exception:
            return {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:                                   # noqa: BLE001
        return {"error": str(e)}, time.time() - t0


def load_queries(path: Path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if "queries" in doc:
        return doc["queries"]
    # known_item.yaml and friends nest under `suites`.
    return [q for s in doc.get("suites", []) for q in s.get("queries", [])]


def run_arm(base, queries, provider, repeat, timeout):
    rows = []
    for rep in range(repeat):
        for q in queries:
            payload, secs = call(base, q["query"], provider, timeout)
            plan = payload.get("plan") or {}
            steps = plan.get("steps") or []
            ops = [s.get("op") for s in steps]
            expect = q.get("expect_op")
            rows.append({
                "id": q["id"], "rep": rep, "seconds": round(secs, 1),
                "planned": bool(steps) and not payload.get("error"),
                "ops": "->".join(o for o in ops if o),
                "expect_op": expect,
                "correct": (expect in ops) if expect else None,
                "error": payload.get("error"),
            })
            mark = "ok " if rows[-1]["planned"] else "FAIL"
            print(f"  [{provider:6s}] {mark} {q['id']:24s} {secs:6.1f}s  "
                  f"{rows[-1]['ops'][:46]}", flush=True)
    return rows


def summarize(rows):
    secs = [r["seconds"] for r in rows]
    scored = [r for r in rows if r["correct"] is not None]
    return {
        "n": len(rows),
        "validity": sum(r["planned"] for r in rows) / max(len(rows), 1),
        "op_appropriateness": (sum(1 for r in scored if r["correct"]) / len(scored)
                               if scored else None),
        "mean_s": statistics.mean(secs) if secs else 0,
        "median_s": statistics.median(secs) if secs else 0,
        "max_s": max(secs) if secs else 0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite", type=Path, default=Path("eval/plan_correctness.yaml"))
    ap.add_argument("--providers", default="ollama,google")
    ap.add_argument("--repeat", type=int, default=1,
                    help="a 5-query sample read once is not a measurement")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--save", type=Path)
    args = ap.parse_args()

    queries = load_queries(args.suite)
    providers = [p.strip() for p in args.providers.split(",") if p.strip()]
    print(f"{len(queries)} queries x {args.repeat} rep(s) x {len(providers)} provider(s)\n")

    results = {p: run_arm(args.base, queries, p, args.repeat, args.timeout)
               for p in providers}

    print(f"\n{'=' * 66}")
    print(f"  {'provider':10s} {'n':>4s} {'valid':>7s} {'op ok':>7s} "
          f"{'mean':>8s} {'median':>8s} {'max':>8s}")
    print(f"{'=' * 66}")
    for p in providers:
        s = summarize(results[p])
        op = f"{s['op_appropriateness']:6.1%}" if s["op_appropriateness"] is not None else "     -"
        print(f"  {p:10s} {s['n']:4d} {s['validity']:6.1%} {op} "
              f"{s['mean_s']:7.1f}s {s['median_s']:7.1f}s {s['max_s']:7.1f}s")

    # Where the two arms disagree is the interesting part; a speed difference
    # on queries they both get right is a cost/latency decision, and a speed
    # difference on queries only one gets right is not a comparison at all.
    if len(providers) == 2:
        a, b = providers
        by = {p: {(r["id"], r["rep"]): r for r in results[p]} for p in providers}
        diffs = [k for k in by[a] if k in by[b]
                 and by[a][k]["ops"] != by[b][k]["ops"]]
        print(f"\n  {len(diffs)} of {len(by[a])} produced DIFFERENT plans")
        for k in diffs[:12]:
            print(f"    {k[0]:24s} {a}: {by[a][k]['ops'][:34]}")
            print(f"    {'':24s} {b}: {by[b][k]['ops'][:34]}")

    if args.save:
        args.save.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"\n  saved -> {args.save}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
