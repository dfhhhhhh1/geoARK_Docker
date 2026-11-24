"""
Paper upload probe (docs/PAPER_AND_CART_INTEGRATION.md P3-P4, U5).

Posts each paper in eval/papers.yaml to /api/paper/extract and scores the
study card against hand-written gold:

  quote validity     findings kept / checked (the server drops unquoted ones)
  area, unit, period exact
  variable recall    gold variables found among the extracted ones (name regex)
  match accuracy     of those found: chosen catalog row matches `expect`, or a
                     gold `missing` variable is listed as not in GeoARK (or a
                     stand-in, which says so)
  method recall      gold families present
  reproduction       each gold family's status is one the gold accepts
  --reproduce        also POST /api/paper/reproduce and count runs that executed

Run 3 times before reading a number (CLAUDE.md). Standard library + PyYAML:

  python eval/paper_probe.py --base http://localhost:8080 --tier dev --out eval/paper/run1.json
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def post(url, data, content_type, timeout=900):
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode("utf8", "replace")[:500]}


def score(paper, res):
    s = res["study"]
    out = {"id": paper["id"], "tier": paper.get("tier"), "ms": res.get("ms"), "calls": res.get("model_calls")}
    q = s["quotes"]
    out["quote_validity"] = q["kept"] / q["checked"] if q["checked"] else None
    out["quotes"] = f'{q["kept"]}/{q["checked"]}'

    g_area = paper.get("area") or {}
    out["area_ok"] = s["area"]["scope"] == g_area.get("scope") and (
        g_area.get("scope") != "states" or sorted(s["area"]["states"] or []) == sorted(g_area.get("states") or []))
    out["area"] = s["area"]["scope"]
    g_unit = paper.get("unit")
    out["unit_ok"] = (s["unit"]["value"] in ("not_stated", "other", "individual")) if g_unit is None else s["unit"]["value"] == g_unit
    out["unit"] = s["unit"]["value"]
    g_per = paper.get("period")
    per = s.get("period") or {}
    out["period"] = [per.get("start_year"), per.get("end_year")]
    out["period_ok"] = g_per is None or out["period"] == list(g_per)

    found = matched = 0
    rows = []
    for gv in paper.get("variables", []):
        rx = re.compile(gv["name"], re.I)
        v = next((x for x in s["variables"] if rx.search(x["name"])), None)
        row = {"gold": gv["name"], "found": v["name"] if v else None}
        if v:
            found += 1
            label = next((m["label"] for m in v["matches"] if m["attr_id"] == v["selected"]), None)
            row.update(role=v["role"], role_ok=v["role"] == gv.get("role", v["role"]), status=v["status"], chosen=label)
            exp = gv.get("expect", "")
            alts = [a for a in exp.split("|")]
            ok_missing = "missing" in alts and (v["status"] in ("missing", "proxy", "out_of_area") or not v["selected"])
            rx_e = "|".join(a for a in alts if a != "missing")
            ok_match = bool(label and rx_e and re.search(rx_e, label, re.I))
            row["match_ok"] = ok_missing or ok_match
            matched += row["match_ok"]
        rows.append(row)
    n = len(paper.get("variables", []))
    out["variable_recall"] = found / n if n else None
    out["match_accuracy"] = matched / found if found else None
    out["variables"] = rows
    out["extracted_variables"] = len(s["variables"])

    fams = {m["family"] for m in s["methods"]}
    gm = paper.get("methods", [])
    hit = sum(1 for m in gm if m["family"] in fams or any(a in fams for a in m.get("any_of", [])))
    out["method_recall"] = hit / len(gm) if gm else None
    out["methods"] = sorted(fams)

    rep_ok = rep_n = 0
    rep_rows = []
    for fam, allowed in (paper.get("reproduce") or {}).items():
        ms = [m for m in res["reproduction"] if m["family"] == fam]
        if not ms:
            rep_rows.append({"family": fam, "status": None, "ok": False})
            rep_n += 1
            continue
        for m in ms:
            ok = m["status"] in allowed
            rep_rows.append({"family": fam, "status": m["status"], "ok": ok, "reason": m["reason"]})
            rep_n += 1
            rep_ok += ok
    out["reproduction_ok"] = rep_ok / rep_n if rep_n else None
    out["reproduction"] = rep_rows
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite", default=str(ROOT / "eval" / "papers.yaml"))
    ap.add_argument("--tier", default="dev")
    ap.add_argument("--only", default=None, help="comma-separated paper ids")
    ap.add_argument("--reproduce", action="store_true")
    ap.add_argument("--root", default=str(ROOT), help="where the papers' paths are relative to")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    suite = yaml.safe_load(open(args.suite, encoding="utf8"))
    papers = [p for p in suite["papers"] if args.tier in ("all", p.get("tier"))]
    if args.only:
        keep = set(args.only.split(","))
        papers = [p for p in papers if p["id"] in keep]
    results = []
    for p in papers:
        path = Path(args.root) / p["file"]
        t0 = time.time()
        res = post(f'{args.base}/api/paper/extract?name={urllib.parse.quote(path.name)}', path.read_bytes(),
                   "application/octet-stream")
        if "study" not in res:
            print(f'{p["id"]}: ERROR {res}')
            results.append({"id": p["id"], "error": res})
            continue
        r = score(p, res)
        if args.reproduce:
            rep = post(f"{args.base}/api/paper/reproduce", json.dumps({"study": res["study"]}).encode(), "application/json")
            runs = [run for m in rep.get("methods", []) for run in m["runs"]]
            r["runs"] = len(runs)
            r["runs_ok"] = sum(1 for run in runs if run.get("response"))
            r["run_errors"] = [f'{run["title"]}: {run.get("error")} {run.get("detail") or ""}' for run in runs if not run.get("response")]
        r["wall_s"] = round(time.time() - t0, 1)
        results.append(r)
        print(f'{p["id"]}: quotes {r["quotes"]}, area {r["area"]} {"ok" if r["area_ok"] else "WRONG"}, '
              f'unit {r["unit"]} {"ok" if r["unit_ok"] else "WRONG"}, period {r["period"]} {"ok" if r["period_ok"] else "WRONG"}, '
              f'variables {r["extracted_variables"]} (recall {r["variable_recall"]:.2f}, match {r["match_accuracy"] or 0:.2f}), '
              f'methods {r["methods"]} (recall {r["method_recall"]:.2f}), reproduction {r["reproduction_ok"]:.2f}'
              + (f', runs {r["runs_ok"]}/{r["runs"]}' if args.reproduce else "") + f', {r["wall_s"]} s')
        for v in r["variables"]:
            if not v.get("found") or not v.get("match_ok"):
                print(f'    variable {v["gold"]!r}: {v}')
        for m in r["reproduction"]:
            if not m["ok"]:
                print(f'    method {m}')
        for e in r.get("run_errors", []):
            print(f"    run failed: {e}")

    def mean(k):
        xs = [r[k] for r in results if isinstance(r.get(k), (int, float))]
        return sum(xs) / len(xs) if xs else None
    summary = {k: mean(k) for k in ("quote_validity", "variable_recall", "match_accuracy", "method_recall", "reproduction_ok")}
    summary.update({k: sum(1 for r in results if r.get(k)) for k in ("area_ok", "unit_ok", "period_ok")})
    summary["papers"] = len(results)
    print("summary", json.dumps(summary))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        json.dump({"summary": summary, "results": results}, open(args.out, "w", encoding="utf8"), indent=2)


if __name__ == "__main__":
    sys.exit(main())
