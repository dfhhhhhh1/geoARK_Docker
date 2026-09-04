#!/usr/bin/env python3
"""
Plan-correctness probe.

    python3 eval/plan_probe.py --save before.json
    python3 eval/plan_probe.py --compare before.json

WHAT THIS MEASURES THAT run.py CANNOT

run.py --endpoint analyze asks "did a plan come back". This asks "is it the
RIGHT SHAPE for the question". Three numbers:

  op appropriateness  the op the question demands actually appears.
                      The headline number.
  forbidden op rate   an op that is clearly wrong for the question appears.
  op diversity        distinct op sequences / number of queries.

Op diversity is the direct test for template copying. A planner that answers
every question with the worked example's shape scores 100% plan validity on
run.py and ~0.12 diversity here. Measured 2026-08-31 on qwen3:14b: 7 of 8
queries returned the identical load->load->normalize->output.

Requests use execute=false: this is about the plan, and skipping execution
avoids a ~6.6 MB geometry payload per query.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

SUITE = Path(__file__).resolve().parent / "plan_correctness.yaml"

_C = sys.stdout.isatty()
GREEN, RED, YELLOW, DIM, BOLD, OFF = (
    ("\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m", "\033[0m")
    if _C else ("", "", "", "", "", "")
)


def call_analyze(base: str, query: str, timeout: int) -> tuple[dict, float]:
    body = json.dumps({"q": query, "execute": False}).encode()
    req = urllib.request.Request(
        f"{base}/api/analyze", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()), time.time() - t0
    except urllib.error.HTTPError as e:
        # 422 (no valid plan) is a result, not a crash -- record and score it.
        try:
            return json.loads(e.read().decode()), time.time() - t0
        except Exception:
            return {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:
        return {"error": str(e)}, time.time() - t0


def probe(base: str, queries: list[dict], timeout: int) -> dict:
    rows = []
    for q in queries:
        payload, secs = call_analyze(base, q["query"], timeout)
        plan = payload.get("plan") or {}
        steps = plan.get("steps") or []
        ops = [s.get("op") for s in steps]
        planned = bool(steps) and not payload.get("error")

        expect = q.get("expect_op")
        forbid = q.get("forbid_op")
        has_expect = expect in ops if expect else None
        has_forbid = forbid in ops if forbid else False

        # Which attributes it chose, with descriptions, so semantic wrongness
        # is at least visible to a reader even though it is not scored.
        cand = {c.get("attr_id"): c for c in payload.get("candidates", [])}
        attrs = []
        for s in steps:
            aid = s.get("attr_id")
            if not aid:
                continue
            c = cand.get(aid, {})
            attrs.append({
                "attr_id": aid,
                "purpose": c.get("search_purpose"),
                "desc": (c.get("attr_desc") or "?")[:100],
            })

        # The narrowing a plan applied, recorded because op_appropriateness
        # cannot see it: "how many hospitals" and "how many CRITICAL ACCESS
        # hospitals" are the same op and differ only here.
        narrowing = []
        for s in steps:
            for f in s.get("attribute_filters") or []:
                narrowing.append(f"{f.get('column')}={f.get('value')}")
            if s.get("city"):
                narrowing.append(f"city={s['city']}")
            # filter_place's fields, without which the probe could see that the
            # op was chosen but not what it was pointed at -- and "Springfield"
            # vs "Springfield Missouri" is the difference between one county and
            # none at all.
            if s.get("place_name"):
                narrowing.append(f"{s.get('place_kind', 'place')}={s['place_name']}")
            for st_name in s.get("states") or []:
                narrowing.append(f"state={st_name}")

        rows.append({
            "id": q["id"],
            "query": q["query"],
            "planned": planned,
            "intent": plan.get("intent"),
            "ops": "->".join(o for o in ops if o),
            "narrowing": narrowing,
            "expect_op": expect,
            "expect_op_present": has_expect,
            "forbid_op": forbid,
            "forbid_op_present": has_forbid,
            "attrs": attrs,
            "error": payload.get("error"),
            "seconds": round(secs, 1),
        })

        if not planned:
            mark, note = RED + "NOPLAN" + OFF, payload.get("error", "?")
        elif has_expect is False or has_forbid:
            mark, note = RED + "WRONG " + OFF, rows[-1]["ops"]
        else:
            mark, note = GREEN + "OK    " + OFF, rows[-1]["ops"]
        print(f"  {mark} {q['id']:<26} {note}  {DIM}({secs:.1f}s){OFF}")
        if planned:
            print(f"         {DIM}intent: {plan.get('intent')}{OFF}")
            if narrowing:
                print(f"         {DIM}narrowed by: {', '.join(narrowing)}{OFF}")

    n = len(rows) or 1
    scored = [r for r in rows if r["expect_op"] is not None]
    seqs = {r["ops"] for r in rows if r["planned"]}
    return {
        "queries": len(rows),
        "plan_validity": sum(r["planned"] for r in rows) / n,
        "op_appropriateness": (
            sum(1 for r in scored if r["expect_op_present"]) / len(scored)
            if scored else 0.0),
        "forbidden_op_rate": sum(1 for r in rows if r["forbid_op_present"]) / n,
        "op_diversity": len(seqs) / n,
        "distinct_op_sequences": sorted(seqs),
        "latency_mean": round(sum(r["seconds"] for r in rows) / n, 1),
        "detail": rows,
    }


def show(res: dict) -> None:
    print(f"\n{'=' * 62}")
    print(f"{BOLD}  plan correctness  n={res['queries']}{OFF}")
    print(f"{'=' * 62}")
    print(f"  plan validity        {res['plan_validity']:6.1%}   "
          f"{DIM}(a plan came back -- what run.py measures){OFF}")
    print(f"  op appropriateness   {res['op_appropriateness']:6.1%}   "
          f"{DIM}(the required op is present){OFF}")
    print(f"  forbidden op rate    {res['forbidden_op_rate']:6.1%}   "
          f"{DIM}(lower is better){OFF}")
    print(f"  op diversity         {res['op_diversity']:6.2f}   "
          f"{DIM}(1.00 = every question got its own shape){OFF}")
    print(f"  mean latency         {res['latency_mean']:6.1f}s")
    print(f"\n  distinct op sequences produced:")
    for s in res["distinct_op_sequences"]:
        print(f"    {s}")


def compare(res: dict, old: dict) -> None:
    print(f"\n{BOLD}vs baseline{OFF}")
    for k, fmt in (("plan_validity", "{:.1%}"),
                   ("op_appropriateness", "{:.1%}"),
                   ("forbidden_op_rate", "{:.1%}"),
                   ("op_diversity", "{:.2f}")):
        a, b = old.get(k, 0), res.get(k, 0)
        d = b - a
        color = GREEN if (d > 0) != (k == "forbidden_op_rate") and d else (RED if d else "")
        print(f"  {k:<20} {fmt.format(a)} -> {fmt.format(b)}   "
              f"{color}{d:+.2f}{OFF}")

    oldrows = {r["id"]: r for r in old.get("detail", [])}
    flips = []
    for r in res.get("detail", []):
        o = oldrows.get(r["id"])
        if not o:
            continue
        was = bool(o["expect_op_present"]) and not o["forbid_op_present"]
        now = bool(r["expect_op_present"]) and not r["forbid_op_present"]
        if was != now:
            flips.append(f"    {r['id']:<26} {'now correct' if now else 'now WRONG'}")
    if flips:
        print(f"\n  queries that flipped")
        print("\n".join(flips))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite-file", type=Path, default=SUITE)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--save", type=Path)
    ap.add_argument("--compare", type=Path)
    args = ap.parse_args()

    suite = yaml.safe_load(args.suite_file.read_text(encoding="utf-8"))
    queries = suite["queries"]
    print(f"{BOLD}plan correctness probe{OFF}  {DIM}{len(queries)} queries, "
          f"execute=false{OFF}\n")

    res = probe(args.base, queries, args.timeout)
    show(res)

    if args.compare:
        compare(res, json.loads(args.compare.read_text(encoding="utf-8")))
    if args.save:
        args.save.write_text(json.dumps(res, indent=2), encoding="utf-8")
        print(f"\n  saved -> {args.save}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
