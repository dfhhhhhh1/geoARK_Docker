"""Rank of every loaded map layer / raster when searched by its own name.

Raw /api/search (top 20), sibling_cap off vs on. Opaque hash-named layers are
skipped: their name is not a query anyone types. Usage:
    python eval/siblingcap/layer_reach.py [--caps 0 3] [--save out.json]
"""
import argparse, csv, json, re, subprocess, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--caps", nargs="+", type=int, default=[0, 3])
ap.add_argument("--base", default="http://localhost:8080")
ap.add_argument("--save", type=Path)
a = ap.parse_args()

out = subprocess.run(["docker", "exec", "geoark-db-1", "psql", "-U", "geoark", "-d", "mygisdb", "-At", "-c",
                      "SELECT DISTINCT dataset_id, source_kind FROM attribute_source "
                      "WHERE source_kind IN ('feature_table','raster')"],
                     capture_output=True, text=True, check=True).stdout
kind = dict(l.split("|") for l in out.split() if "|" in l)
names = {}
for r in csv.DictReader(open("backend/geoark_attributes.csv", encoding="utf-8")):
    if r["dataset_id"] in kind:
        names[r["dataset_id"]] = r["dataset_clean"]
opaque = re.compile(r"^[0-9A-Fa-f]{6,}-")
layers = sorted((d, n) for d, n in names.items() if not opaque.match(n))

def rank(q, ds, cap):
    u = f"{a.base}/api/search?" + urllib.parse.urlencode({"q": q, "sibling_cap": cap})
    for _ in range(20):   # the search limiter is 60/min
        try:
            res = json.load(urllib.request.urlopen(u, timeout=60))
            break
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(float(e.headers.get("Retry-After") or 5))
    for i, r in enumerate(res):
        if r["dataset_id"] == ds:
            return i + 1
    return None

rows = []
for ds, n in layers:
    rows.append({"dataset_id": ds, "name": n, "kind": kind[ds],
                 **{f"cap{c}": rank(n, ds, c) for c in a.caps}})
for c in a.caps:
    rk = [r[f"cap{c}"] for r in rows]
    found = [x for x in rk if x]
    print(f"cap {c}: n={len(rk)}  @1 {sum(x == 1 for x in found)}  @5 {sum(x <= 5 for x in found)}"
          f"  @20 {len(found)}  MRR {sum(1 / x for x in found) / len(rk):.3f}")
for r in rows:
    if len({r[f'cap{c}'] for c in a.caps}) > 1 or any(r[f'cap{c}'] in (None,) for c in a.caps):
        print("  ", r["name"][:60], {c: r[f"cap{c}"] for c in a.caps})
if a.save:
    a.save.write_text(json.dumps(rows, indent=1))
