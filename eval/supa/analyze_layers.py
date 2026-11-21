#!/usr/bin/env python3
"""One /api/analyze question per Supplementary File A feature layer loaded on
2026-11-20 (docs/DATA_CARPENTRY.md, "Supplementary File A feature layers").
Records the plan, which dataset each step used, and the row / feature count,
and says whether the plan used the NEW layer (ing_<id>) or something else.

    python eval/supa/analyze_layers.py [--only <dataset_id_substring>] [--save out.json]
"""
import argparse
import json
import sys
import time
import urllib.request

QS = [
    ("ing_eiapowerplan", "where are the coal power plants in Kentucky"),
    ("ing_ntadpetroleu", "where are the petroleum ports in Texas"),
    ("ing_ntadpipeline", "how many petroleum terminals are in each state"),
    ("ing_polpumpingst", "where are the oil pipeline pumping stations in Oklahoma"),
    ("ing_prisonbounda", "how many prisons are in each county in Georgia"),
    ("ing_publichealth", "where are the public health departments in Ohio"),
    ("ing_urgentcarefa", "how many urgent care centers are in each county in Florida"),
    ("ing_vhafacilitie", "how far is each county in Missouri from the nearest VA medical center"),
    ("ing_ntadpassenge", "where are the train and transit stations in Illinois"),
    ("ing_ntadroadtunn", "where are the road tunnels in Pennsylvania"),
    ("ing_solidwastela", "how many open landfills are in each county in Michigan"),
    ("ing_supplemental", "where are the satellite college campuses in North Carolina"),
    ("ing_uraniumvanad", "where are the uranium mines in Utah"),
    ("ing_usgssandgrav", "where are the sand and gravel operations in Minnesota"),
    ("ing_placesofwors", "how many churches are in each county in Alabama"),
    ("ing_usgslandslid", "where are the areas of high landslide incidence in Pennsylvania"),
    ("ing_usgsseismich", "show the earthquake hazard zones in California"),
    ("ing_usgswaterbod", "where are the lakes and reservoirs in Minnesota"),
    ("ing_usgscoalfiel", "where are the coal fields in Wyoming"),
    ("ing_plateboundar", "show the tectonic plate boundaries near Alaska"),
    ("ing_eparmpfacili", "how many RMP chemical facilities are in each county in Texas"),
    ("ing_epatscafacil", "where are the TSCA chemical reporting facilities in New Jersey"),
    ("ing_ntadtransitr", "where are the bus routes in Missouri"),
]


def ask(q, base, timeout=600):
    body = json.dumps({"q": q, "execute": True}).encode()
    req = urllib.request.Request(f"{base}/api/analyze", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read())
        except Exception:
            d = {"error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        d = {"error": str(e)}
    return d, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--only")
    ap.add_argument("--save")
    a = ap.parse_args()
    out = []
    for ds, q in QS:
        if a.only and a.only not in ds:
            continue
        d, secs = ask(q, a.base)
        steps = (d.get("plan") or {}).get("steps") or []
        used = sorted({s.get("attr_id", "")[: s.get("attr_id", "").rfind("_")]
                       for s in steps if s.get("attr_id")})
        n_feat = len((d.get("features") or {}).get("features", [])) if isinstance(d.get("features"), dict) else None
        rec = {"dataset": ds, "q": q, "secs": round(secs, 1), "error": d.get("error"),
               "ops": [s.get("op") for s in steps], "used": used,
               "filters": [s.get("attribute_filters") for s in steps if s.get("attribute_filters")],
               "row_count": d.get("row_count"), "features": n_feat,
               "uses_new": any(u.startswith(ds) for u in used)}
        out.append(rec)
        flag = "NEW" if rec["uses_new"] else ("ERR" if rec["error"] else "OTHER")
        print(f"{flag:5s} {ds:18s} {secs:5.0f}s rows={rec['row_count']} feats={n_feat} "
              f"ops={'>'.join(rec['ops'])} used={used} filt={rec['filters']} err={(rec['error'] or '')[:120]}",
              flush=True)
    if a.save:
        json.dump(out, open(a.save, "w"), indent=1)
    print(f"\n{sum(r['uses_new'] for r in out)} / {len(out)} planned over the new layer")


if __name__ == "__main__":
    sys.exit(main())
