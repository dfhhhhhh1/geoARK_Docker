"""The three held-out questions RESEARCH_PLAN Phase C names in its 'done when',
run 3x each. Outcome shape only (ROWS / EMPTY / NO_PLAN), like wild_probe.py:
ROWS is not correctness. The scored analogues are in research.yaml."""
import json, sys, time, urllib.request
BASE = "http://localhost:8080"
QS = {"w-two-conditions": "Show me rural counties with high poverty and few hospitals",
      "w-ratio-question": "Is there more unemployment in the south than the north?",
      "w-trend-where": "Which counties saw the biggest increase in poverty over the last decade?"}
out = []
for run in (1, 2, 3):
    for qid, q in QS.items():
        t = time.time()
        req = urllib.request.Request(f"{BASE}/api/analyze", method="POST",
            data=json.dumps({"q": q, "include_geometry": False}).encode(),
            headers={"content-type": "application/json"})
        try:
            body = json.load(urllib.request.urlopen(req, timeout=400))
        except urllib.error.HTTPError as e:
            body = json.load(e)
        steps = (body.get("plan") or {}).get("steps") or []
        shape = "NO_PLAN" if not steps else ("ROWS" if body.get("row_count") else "EMPTY")
        rec = {"run": run, "id": qid, "shape": shape, "rows": body.get("row_count"),
               "ops": "->".join(s["op"] for s in steps),
               "loaded": [o.get("census_code") or o.get("table_name") for o in
                          (body.get("provenance") or {}).get("attribute_origins") or []],
               "definitions": [d["id"] for d in (body.get("provenance") or {}).get("definitions") or []],
               "comparison": body.get("comparison"), "adjustments": body.get("adjustments"),
               "error": body.get("error"), "s": round(time.time() - t, 1)}
        out.append(rec)
        print(f"  r{run} {qid:<18} {shape:<8} rows={rec['rows']} {rec['ops']}  defs={rec['definitions']}", flush=True)
json.dump(out, open(sys.argv[1], "w"), indent=1)
