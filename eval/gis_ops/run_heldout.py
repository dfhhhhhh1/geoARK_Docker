"""Runs the 16 held-out analyst queries (heldout_analyst_queries.csv) through
/api/research and saves plan, data used, rows and refusal text per question.
HELD OUT: score at phase boundaries only (docs/GIS_OPS_PLAN.md).
  python eval/gis_ops/run_heldout.py eval/gis_ops/<name>.json"""
import csv, json, sys, time, urllib.request, urllib.error

SRC = str(__import__("pathlib").Path(__file__).with_name("heldout_analyst_queries.csv"))
OUT = sys.argv[1]
BASE = "http://localhost:8080"

rows = list(csv.DictReader(open(SRC, encoding="utf-8")))
results = []
for i, r in enumerate(rows, 1):
    q = r["Natural Language Query"]
    body = json.dumps({"q": q, "execute": True, "include_geometry": False}).encode()
    req = urllib.request.Request(f"{BASE}/api/research", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            b = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            b = json.loads(e.read().decode())
        except Exception:
            b = {"error": f"HTTP {e.code}"}
    except Exception as e:
        b = {"error": str(e)}
    dt = time.time() - t0
    plan = b.get("plan") or {}
    layers = b.get("layers") or []
    sample = []
    for l in layers[:2]:
        sample.append({"mode": l.get("mode"), "n": len(l.get("rows") or []),
                       "rows": (l.get("rows") or [])[:3]})
    if not layers and b.get("rows"):
        sample.append({"n": len(b["rows"]), "rows": b["rows"][:3]})
    rec = {
        "i": i, "category": r["Category"], "q": q, "secs": round(dt, 1),
        "error": b.get("error"), "exec_error": b.get("execution_error"),
        "message": b.get("message") or b.get("explanation") or b.get("refusal"),
        "steps": [{k: v for k, v in s.items() if k in ("op", "id", "attr_id", "params", "inputs", "input", "dataset", "label")} | ({"_": {k: v for k, v in s.items() if k not in ("op",)}} ) for s in plan.get("steps") or []],
        "origins": [f"{o.get('census_code') or o.get('table_name') or o.get('original_name')} | {o.get('description')} | {o.get('dataset')}"
                    for o in (b.get("provenance") or {}).get("attribute_origins") or []],
        "row_count": b.get("row_count"), "mode": b.get("output_mode"), "level": b.get("level"),
        "sample": sample, "keys": sorted(b.keys()),
        "relevance": b.get("relevance"), "suggestions": b.get("suggestions"),
        "workflow": b.get("workflow"), "not_covered": b.get("not_covered") or ((b.get("workflow") or {}).get("final") or {}).get("not_covered"), "detail": b.get("detail"), "named_data": b.get("named_data"),
    }
    results.append(rec)
    print(f"[{i}] {dt:.0f}s rows={rec['row_count']} err={str(rec['error'])[:120]} ops={[s.get('op') for s in plan.get('steps') or []]}", flush=True)
    json.dump(results, open(OUT, "w"), indent=1, default=str)
