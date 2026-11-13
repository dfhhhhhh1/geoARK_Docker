"""Does a concept-phrased question retrieve the loaded layer that answers it?

For each question in layer_concepts.yaml, calls /api/unified-search at the
planner's budget (top_k 60, which unifiedSearch splits across sub-queries)
and reports the best rank of an ACCEPTED dataset in any sub-query's results.
Decomposition is a model call, so each question runs `--repeats` times per arm.

    python eval/siblingcap/concept_reach.py --caps 0 3 --repeats 2 --save out.json
"""
import argparse, json, time, urllib.error, urllib.request
from pathlib import Path

import yaml

ap = argparse.ArgumentParser()
ap.add_argument("--caps", nargs="+", type=int, default=[0, 3])
ap.add_argument("--repeats", type=int, default=1)
ap.add_argument("--top-k", type=int, default=60)
ap.add_argument("--base", default="http://localhost:8080")
ap.add_argument("--suite", type=Path, default=Path(__file__).with_name("layer_concepts.yaml"))
ap.add_argument("--save", type=Path)
a = ap.parse_args()


def post(body):
    for _ in range(20):   # the search limiter is 60/min
        try:
            req = urllib.request.Request(f"{a.base}/api/unified-search", data=json.dumps(body).encode(),
                                         headers={"content-type": "application/json"})
            return json.load(urllib.request.urlopen(req, timeout=180))
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(float(e.headers.get("Retry-After") or 5))
    raise RuntimeError("rate limited")


qs = yaml.safe_load(a.suite.read_text(encoding="utf-8"))["queries"]
rows = []
for q in qs:
    for rep in range(a.repeats):
        for cap in a.caps:
            d = post({"q": q["q"], "top_k": a.top_k, "sibling_cap": cap})
            best = None
            for sq in d.get("results_by_query", []):
                for i, r in enumerate(sq.get("results", [])):
                    if r["dataset_id"] in q["accept"]:
                        best = i + 1 if best is None else min(best, i + 1)
                        break
            rows.append({"id": q["id"], "cap": cap, "rep": rep, "rank": best,
                         "subqueries": [sq["query"] for sq in d.get("results_by_query", [])]})

print(f"{'id':16}" + "".join(f"  cap{c:<3}" for c in a.caps))
for q in qs:
    cells = []
    for c in a.caps:
        rk = [r["rank"] for r in rows if r["id"] == q["id"] and r["cap"] == c]
        cells.append(",".join("-" if x is None else str(x) for x in rk))
    print(f"{q['id']:16}" + "".join(f"  {s:<6}" for s in cells))
for c in a.caps:
    rk = [r["rank"] for r in rows if r["cap"] == c]
    print(f"cap {c}: reached {sum(x is not None for x in rk)}/{len(rk)}"
          f"  @1 {sum(x == 1 for x in rk)}  @3 {sum(x is not None and x <= 3 for x in rk)}")
if a.save:
    a.save.write_text(json.dumps(rows, indent=1))
