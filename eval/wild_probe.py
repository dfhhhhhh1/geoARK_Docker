#!/usr/bin/env python3
"""
Run a held-out suite and record what actually came back.

plan_probe.py scores `expect_op`, which needs the right answer known in
advance. For unseen queries it usually is not, and the interesting failures are
not "wrong op" anyway -- they are no plan, an empty result, or a confident plan
over the wrong attribute. So this executes each query and records the shape of
the outcome for a human to classify.
"""
import json, sys, time, urllib.error, urllib.request
from pathlib import Path
import yaml

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
SUITE = Path("eval/wild_queries.yaml")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "eval/wild-run1.json")

def call(q):
    body = json.dumps({"q": q, "execute": True}).encode()
    req = urllib.request.Request(f"{BASE}/api/analyze", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode()), time.time() - t0
    except urllib.error.HTTPError as e:
        try:    return json.loads(e.read().decode()), time.time() - t0
        except Exception: return {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:
        return {"error": str(e)}, time.time() - t0

rows = []
for q in yaml.safe_load(SUITE.read_text(encoding="utf-8"))["queries"]:
    p, secs = call(q["query"])
    plan = p.get("plan") or {}
    steps = plan.get("steps") or []
    cand = {c.get("attr_id"): c for c in p.get("candidates", [])}
    attrs = [ (cand.get(s.get("attr_id"), {}).get("attr_desc") or s.get("attr_id") or "")[:70]
              for s in steps if s.get("attr_id") ]
    n = p.get("row_count")
    if not steps:            outcome = "NO_PLAN"
    elif p.get("execution_error"): outcome = "EXEC_ERROR"
    elif n in (0, None):     outcome = "EMPTY"
    else:                    outcome = "ROWS"
    rows.append({"id": q["id"], "query": q["query"], "note": q.get("note"),
                 "outcome": outcome, "ops": "->".join(s["op"] for s in steps),
                 "intent": plan.get("intent"), "rows": n, "attrs": attrs,
                 "error": p.get("error"), "exec_error": p.get("execution_error"),
                 "layers": p.get("layer_count"), "seconds": round(secs, 1)})
    print(f"  {outcome:10s} {q['id']:22s} {rows[-1]['ops'] or (p.get('error') or '')[:44]}"
          f"  rows={n}  ({secs:.0f}s)", flush=True)

OUT.write_text(json.dumps(rows, indent=2), encoding="utf-8")
from collections import Counter
print("\n" + "="*58)
for k, v in Counter(r["outcome"] for r in rows).most_common():
    print(f"  {k:11s} {v:3d} / {len(rows)}  ({100*v//len(rows)}%)")
print(f"  mean {sum(r['seconds'] for r in rows)/len(rows):.0f}s   saved -> {OUT}")
