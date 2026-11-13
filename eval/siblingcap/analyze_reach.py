"""End to end: does the accepted layer reach the planner's candidates, get used,
and does the question answer? Same suite as concept_reach.py.

    python eval/siblingcap/analyze_reach.py [--ids a b] [--sibling-cap N] [--save out.json]
"""
import argparse, json, time, urllib.error, urllib.request
from pathlib import Path
import yaml

ap = argparse.ArgumentParser()
ap.add_argument("--ids", nargs="*")
ap.add_argument("--sibling-cap", type=int)
ap.add_argument("--base", default="http://localhost:8080")
ap.add_argument("--save", type=Path)
a = ap.parse_args()
qs = yaml.safe_load(Path(__file__).with_name("layer_concepts.yaml").read_text(encoding="utf-8"))["queries"]
if a.ids:
    qs = [q for q in qs if q["id"] in a.ids]
out = []
for q in qs:
    body = {"q": q["q"]}
    if a.sibling_cap is not None:
        body["sibling_cap"] = a.sibling_cap
    t = time.time()
    req = urllib.request.Request(f"{a.base}/api/analyze", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=600))
    except urllib.error.HTTPError as e:
        d = json.loads(e.read() or b"{}")
    cands = d.get("candidates") or []
    cand_ds = {c.get("dataset_id") for c in cands if isinstance(c, dict)}
    used = {s.get("attr_id") for s in (d.get("plan") or {}).get("steps", [])}
    used_ds = {c.get("dataset_id") for c in cands if isinstance(c, dict) and c.get("attr_id") in used}
    r = {"id": q["id"], "secs": round(time.time() - t), "error": d.get("error"),
         "offered": bool(cand_ds & set(q["accept"])), "used": bool(used_ds & set(q["accept"])),
         "rows": d.get("row_count"), "ops": [s.get("op") for s in (d.get("plan") or {}).get("steps", [])]}
    out.append(r)
    print(f"{r['id']:16} offered={r['offered']!s:5} used={r['used']!s:5} rows={r['rows']} {r['secs']}s "
          f"{' > '.join(r['ops'])}  {r['error'] or ''}", flush=True)
print(f"offered {sum(r['offered'] for r in out)}/{len(out)}  used {sum(r['used'] for r in out)}/{len(out)}"
      f"  answered {sum(not r['error'] for r in out)}/{len(out)}")
if a.save:
    a.save.write_text(json.dumps(out, indent=1))
