"""Does the planner's candidate list contain every measure a question needs?

The decomposition A/B instrument (2026-11-19). For each dev question with
declared measures, calls /api/analyze with `candidates: {only: true}`: the
real retrieval + candidate selection (quotas, facility round-robin, level
filtering), stopping BEFORE the planner. A question is "reached" when every
measure it declares (m1, m2, ...) matches at least one offered candidate, with
the same "<code or table> | <description> | <dataset>" regex answer_probe.py
binds gold to. Layer questions (siblingcap/layer_concepts.yaml) are reached
when an accepted dataset_id is offered.

This isolates the two things decomposition and the caps can change -- what is
offered -- from the planner's choice among them. It cannot see whether the
planner then USES the measure; answer_probe.py does that.

Held-out tiers are never read.

    python eval/decomp/reach.py --base http://localhost:4100 \
        --arm v1-gemma '{"decomp":{"prompt":"v1","model":"gemma3:4b"}}' \
        --arm v2-qwen  '{"decomp":{"prompt":"v2","model":"qwen3:14b"}}' \
        --repeats 2 --save eval/decomp/reach.json
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

EVAL = Path(__file__).resolve().parents[1]


def load_questions() -> list[dict]:
    out = []
    for f in ("research.yaml", "research_advanced.yaml", "gis_ops.yaml"):
        d = yaml.safe_load((EVAL / f).read_text(encoding="utf-8"))
        regex = d.get("measures", {})
        for q in d["queries"]:
            tier = q.get("tier") or ""
            if tier == "refuse" or tier.endswith("_heldout") or not q.get("measures"):
                continue
            pats = {m: regex[name] for m, name in q["measures"].items() if name in regex}
            out.append({"id": q["id"], "suite": f.split(".")[0], "tier": tier,
                        "q": q["query"], "measures": pats})
    lc = yaml.safe_load((EVAL / "siblingcap" / "layer_concepts.yaml").read_text(encoding="utf-8"))
    for q in lc["queries"]:
        out.append({"id": q["id"], "suite": "layer_concepts", "tier": "layer",
                    "q": q["q"], "accept": q["accept"]})
    return out


def post(base: str, body: dict, timeout: int = 300) -> tuple[dict, float]:
    t0 = time.time()
    req = urllib.request.Request(f"{base}/api/analyze", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=timeout)), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}"), time.time() - t0
        except Exception:
            return {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:  # timeout etc.
        return {"error": str(e)}, time.time() - t0


def score(q: dict, d: dict) -> dict:
    cands = d.get("candidates") or []
    keys = [f"{c.get('key') or '?'} | {c.get('attr_desc') or ''} | {c.get('dataset') or ''}" for c in cands]
    if "accept" in q:
        hit = {c.get("dataset_id") for c in cands} & set(q["accept"])
        missed = [] if hit else ["layer"]
    else:
        missed = [m for m, pat in q["measures"].items()
                  if not any(re.search(pat, k, re.I) for k in keys)]
    dec = d.get("decomposition") or {}
    sq = dec.get("search_queries") or []
    return {"reached": not missed and not d.get("error"), "missed": missed,
            "error": d.get("error"), "n_cands": len(cands),
            "n_feature": sum(1 for c in cands if c.get("is_feature_table")),
            "n_subq": len(sq), "subq": [f"{s.get('purpose')}:{s.get('query')}" for s in sq],
            "decomp_ms": (dec.get("decomp") or {}).get("ms"), "fallback": bool(dec.get("fallback_used"))}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:4100")
    ap.add_argument("--arm", nargs=2, action="append", metavar=("NAME", "JSON"), required=True)
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--save", type=Path)
    a = ap.parse_args()
    qs = load_questions()
    if a.only:
        qs = [q for q in qs if q["id"] in a.only]
    results = {}
    for name, js in a.arm:
        extra = json.loads(js)
        extra.setdefault("candidates", {})["only"] = True
        rows = []
        for rep in range(a.repeats):
            for q in qs:
                d, secs = post(a.base, {"q": q["q"], **extra})
                r = {"id": q["id"], "suite": q["suite"], "tier": q["tier"], "rep": rep,
                     "secs": round(secs, 2), **score(q, d)}
                rows.append(r)
                print(f"[{name} r{rep}] {q['id']:34} {'OK ' if r['reached'] else 'MISS'} "
                      f"subq={r['n_subq']} cands={r['n_cands']}/{r['n_feature']}f "
                      f"{r['decomp_ms']}ms {','.join(r['missed'])} {r['error'] or ''}", flush=True)
        n = len(rows)
        reached = sum(r["reached"] for r in rows)
        ms = [r["decomp_ms"] for r in rows if r["decomp_ms"]]
        summ = {"reached": reached, "n": n, "rate": round(reached / n, 3),
                "mean_subq": round(statistics.mean(r["n_subq"] for r in rows), 2),
                "subq_hist": {k: sum(1 for r in rows if r["n_subq"] == k) for k in sorted({r["n_subq"] for r in rows})},
                "decomp_ms_p50": statistics.median(ms) if ms else None,
                "decomp_ms_mean": round(statistics.mean(ms)) if ms else None,
                "by_suite": {s: f"{sum(r['reached'] for r in rows if r['suite'] == s)}/{sum(1 for r in rows if r['suite'] == s)}"
                             for s in sorted({r['suite'] for r in rows})},
                "fallbacks": sum(r["fallback"] for r in rows)}
        print(f"== {name}: {json.dumps(summ)}", flush=True)
        results[name] = {"extra": extra, "summary": summ, "rows": rows}
        if a.save:
            a.save.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print("\n" + "\n".join(f"{k:24} {v['summary']['reached']}/{v['summary']['n']}  "
                           f"subq {v['summary']['mean_subq']}  decomp p50 {v['summary']['decomp_ms_p50']} ms  "
                           f"{v['summary']['by_suite']}" for k, v in results.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
