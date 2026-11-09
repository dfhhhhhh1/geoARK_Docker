#!/usr/bin/env python3
"""Planner-side A/B for literature expansion (backend/expansion.js).

eval/run.py --endpoint unified says whether expansion REACHES related data. It
cannot say whether any of it gets to the planner (analyze truncates to top_k=25
with expanded candidates LAST), or whether the answer changes. This does both:

  - pool:   expanded candidates in the planner's executable list
  - plan:   op sequence and loaded attributes, per arm
  - factor: for explain plans, each factor's source (literature / named / default)

    python eval/expansion_planner_ab.py --reps 2 --save eval/exp-heldout/planner.json
    # research expansion arms (backend/research.js), literature expansion on in each
    python eval/expansion_planner_ab.py --arms expand,pubmed,web --reps 1         --save eval/research/planner.json
"""
import argparse
import json
import time
import urllib.request

QUESTIONS = [
    # why / risk-factor questions: where expansion is MEANT to matter
    ("why-depression", "what explains depression rates across counties"),
    ("why-heart-attack", "what are the risk factors for heart attacks by county"),
    ("why-teeth", "what explains tooth loss among older adults"),
    ("why-ckd", "what drives chronic kidney disease rates"),
    ("why-binge", "why is binge drinking higher in some counties"),
    ("why-arthritis", "what factors explain arthritis prevalence"),
    # plain map questions: expansion must NOT change the answer
    ("plain-depression", "depression rates across counties"),
    ("plain-smoking", "smoking rates by county"),
    ("plain-cholesterol", "high cholesterol rates in Ohio"),
    ("plain-teeth", "tooth loss among older adults by county"),
]


# arm -> request fields
ARMS = {
    "off": {"expand": False},
    "expand": {"expand": True, "research": []},
    "pubmed": {"expand": True, "research": ["pubmed"]},
    "web": {"expand": True, "research": ["web"]},
    "both": {"expand": True, "research": ["pubmed", "web"]},
}


def analyze(base, q, fields, timeout):
    body = json.dumps({"q": q, **fields, "include_geometry": False}).encode()
    req = urllib.request.Request(f"{base}/api/analyze", body,
                                 {"content-type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    d["_seconds"] = round(time.time() - t, 1)
    return d


def summarize(d):
    plan = d.get("plan") or {}
    steps = plan.get("steps") or []
    cands = d.get("candidates") or []
    by_id = {c.get("attr_id"): c for c in cands}
    loads = [s.get("attr_id") for s in steps if s.get("op") == "load"]
    out = {
        "seconds": d.get("_seconds"),
        "error": d.get("error"),
        "ops": [s.get("op") for s in steps],
        "loads": [(a, (by_id.get(a) or {}).get("attr_desc"),
                   (by_id.get(a) or {}).get("search_purpose")) for a in loads],
        "n_candidates": len(cands),
        "expanded_in_pool": [c.get("attr_desc") for c in cands
                             if c.get("search_purpose") == "expanded"],
        "seeds": [s.get("name") for s in ((d.get("expansion") or {}).get("seeds") or [])],
        "research_kept": [k.get("keyword") for k in ((d.get("research") or {}).get("keywords") or [])
                          if k.get("kept")],
    }
    # explain factors: whatever shape the step/result carries them in
    factors = []
    for s in steps:
        for f in s.get("factors") or []:
            factors.append((f.get("description") or f.get("attr_id"), f.get("source")))
    out["factors"] = factors
    # the computed ranking, which is what a user actually reads
    out["explain"] = [
        {k: f.get(k) for k in ("rank", "description", "source", "partial_rho",
                                "ci_low", "ci_high", "q_value", "status")}
        for f in ((d.get("explain") or {}).get("factors") or [])
    ]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--arms", default="off,expand",
                    help=f"comma list from {sorted(ARMS)}; default off,expand")
    ap.add_argument("--only", default="", help="run only question ids with this prefix, e.g. why-")
    ap.add_argument("--save", required=True)
    args = ap.parse_args()

    rows = []
    for rep in range(1, args.reps + 1):
        for qid, q in [x for x in QUESTIONS if x[0].startswith(args.only)]:
            for arm in args.arms.split(","):  # alternate so drift hits every arm
                expand = ARMS[arm]["expand"]
                try:
                    d = analyze(args.base, q, ARMS[arm], args.timeout)
                    s = summarize(d)
                    raw = {k: d.get(k) for k in ("plan", "expansion", "research", "error", "detail")}
                except Exception as e:  # keep going: one stall should not lose the run
                    s, raw = {"error": repr(e)}, None
                row = {"id": qid, "query": q, "arm": arm, "expand": expand, "rep": rep, **s, "raw": raw}
                rows.append(row)
                print(f"[{rep}] {qid:18} {arm:7} {s.get('seconds')}s "
                      f"ops={s.get('ops')} pool+={len(s.get('expanded_in_pool') or [])} "
                      f"err={s.get('error')}", flush=True)
                with open(args.save, "w") as fh:
                    json.dump(rows, fh, indent=1, default=str)


if __name__ == "__main__":
    main()
