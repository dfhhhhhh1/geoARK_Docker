"""
Answerability probe: catch rate and false-refusal rate of the relevance check.

See eval/answerability.yaml. Plans only (execute=false), so a run is minutes,
not the cost of executing every query. `--relevance-check on|off` is sent per
request, so both arms hit the same container.
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

SUITE = Path(__file__).with_name("answerability.yaml")


def call(base: str, query: str, check: bool | None, timeout: int) -> dict:
    body = {"q": query, "execute": False}
    if check is not None:
        body["relevance_check"] = check
    req = urllib.request.Request(f"{base}/api/analyze", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"error": f"HTTP {e.code}"}
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        # A dropped connection is a transport failure, not a refusal: recorded
        # as `failed` so it can never be counted as a correct catch.
        return {"error": f"transport: {e}", "transport_error": True}


def outcome(p: dict) -> str:
    """answered | refused | failed. A refusal is any honest 'cannot answer'."""
    steps = (p.get("plan") or {}).get("steps") or []
    if steps and not p.get("error"):
        return "answered"
    err = str(p.get("error") or "")
    if p.get("not_measured") or "no analysis could be built" in err \
            or "not been loaded" in err or "no executable attributes" in err:
        return "refused"
    return "failed"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite-file", type=Path, default=SUITE)
    ap.add_argument("--relevance-check", choices=["on", "off"])
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--save", type=Path)
    ap.add_argument("--compare", type=Path)
    ap.add_argument("--only", choices=["refuse", "answer"],
                    help="run one half of the suite (rates for the other half read 0)")
    args = ap.parse_args()
    check = None if args.relevance_check is None else args.relevance_check == "on"

    rows = []
    for q in yaml.safe_load(args.suite_file.read_text(encoding="utf-8"))["queries"]:
        if args.only and q["expect"] != args.only:
            continue
        t0 = time.time()
        p = call(args.base, q["query"], check, args.timeout)
        o = outcome(p)
        rel = p.get("relevance") or []
        rows.append({
            "id": q["id"], "expect": q["expect"], "outcome": o,
            "correct": (o == "refused") if q["expect"] == "refuse" else (o == "answered"),
            "ops": [s["op"] for s in (p.get("plan") or {}).get("steps") or []],
            "verdicts": [f"{v['verdict']}:{(v.get('description') or '')[:40]}" for v in rel],
            "rejected": [(v.get("description") or "")[:50] for v in p.get("rejected_attributes") or []],
            "error": p.get("error"), "seconds": round(time.time() - t0, 1),
        })
        r = rows[-1]
        mark = "ok  " if r["correct"] else "MISS"
        print(f"  {mark} {r['id']:13} {r['expect']:6} -> {r['outcome']:8} {r['seconds']:5.1f}s  "
              f"{'->'.join(r['ops'])[:40]:40} {' | '.join(r['verdicts'] or r['rejected'])[:90]}",
              flush=True)

    ref = [r for r in rows if r["expect"] == "refuse"]
    ans = [r for r in rows if r["expect"] == "answer"]
    res = {
        "relevance_check": args.relevance_check,
        "catch_rate": sum(r["outcome"] != "answered" for r in ref) / max(len(ref), 1),
        "honest_refusal_rate": sum(r["outcome"] == "refused" for r in ref) / max(len(ref), 1),
        "false_refusal_rate": sum(r["outcome"] != "answered" for r in ans) / max(len(ans), 1),
        "rows": rows,
    }
    print(f"\n  catch rate          {res['catch_rate']:.0%}  ({len(ref)} must-refuse; "
          f"not answered)")
    print(f"  honest refusals     {res['honest_refusal_rate']:.0%}  (refused with a reason, "
          f"not a crash)")
    print(f"  false refusals      {res['false_refusal_rate']:.0%}  ({len(ans)} answerable)")

    if args.compare:
        old = json.loads(args.compare.read_text(encoding="utf-8"))
        prev = {r["id"]: r for r in old["rows"]}
        print(f"\n  vs {args.compare.name}: catch {old['catch_rate']:.0%} -> {res['catch_rate']:.0%}, "
              f"false refusals {old['false_refusal_rate']:.0%} -> {res['false_refusal_rate']:.0%}")
        for r in rows:
            o = prev.get(r["id"])
            if o and o["outcome"] != r["outcome"]:
                print(f"    {r['id']:13} {o['outcome']} -> {r['outcome']}")
    if args.save:
        args.save.write_text(json.dumps(res, indent=2), encoding="utf-8")
        print(f"\n  saved -> {args.save}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
