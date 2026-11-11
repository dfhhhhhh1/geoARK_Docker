"""
Demo questions for Phase C (conditions, definitions, group comparisons, time
periods) and Phase D (multi-step research workflows). Works in any shell.

    python eval/demo.py --list          what is available
    python eval/demo.py conditions      run one demo by name
    python eval/demo.py all             run every demo, in order
    python eval/demo.py ask "your question here"            /api/analyze
    python eval/demo.py research "your question here"       /api/research
    python eval/demo.py health          active / withheld definitions

Each question takes ~40-200 s (planner reasoning on). --raw prints the whole
JSON response instead of the summary.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://localhost:8080"

DEMOS = {
    # ------------------------------------------------------------- Phase C
    "conditions": ("analyze", "Show me rural counties with high poverty and few hospitals",
                   "several conditions; 'rural' from a published definition; intersect"),
    "compare": ("analyze", "Is the unemployment rate higher in the South than in the Northeast?",
                "two groups of one measure; compare_groups"),
    "decade": ("analyze", "Which counties' unemployment rate rose the most over the last decade?",
               "period anchored to the measure's own years; later minus earlier"),
    "refuse-period": ("analyze", "Which counties saw the biggest increase in poverty over the last decade?",
                      "no poverty measure spans a decade: should refuse, and say why"),
    "percentile": ("analyze", "Which counties with above-median poverty rates are more than 30 miles from the nearest hospital?",
                   "'above-median' as a percentile, not a guessed number"),
    # ------------------------------------------------------------- Phase D
    "workflow": ("research", "Take the 50 counties with the highest adult obesity rates. "
                             "How does their median household income compare with the rest of the country?",
                 "two steps: q1's counties feed q2's comparison"),
    "workflow-new": ("research", "Find the 100 counties with the highest uninsured rates. "
                                 "Is diabetes more common in those counties than in all other counties?",
                     "a two-step question in no eval suite"),
    "gated": ("research", "Which ten Missouri counties have the highest share of people living in poverty?",
              "no back-reference: stays one step, no decomposition call"),
}


def post(endpoint, question, timeout=600):
    body = json.dumps({"q": question, "include_geometry": False}).encode()
    req = urllib.request.Request(f"{BASE}/api/{endpoint}", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return json.load(e), time.time() - t0
        except Exception:
            return {"error": f"HTTP {e.code}"}, time.time() - t0


def fmt(v):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:,.0f}" if abs(v) >= 1000 else f"{v:.3g}"
    return str(v)


def show(d, secs):
    print(f"  ({secs:.0f} s)")
    if d.get("error"):
        print(f"  ERROR / REFUSAL: {d['error']}")
        if d.get("detail"):
            print(f"  {d['detail']}")
    w = d.get("workflow")
    if w:
        dec = w.get("decomposition") or {}
        print(f"  workflow: {w['status']}"
              f"{'  (one step: no back-reference, not decomposed)' if dec.get('gated') else ''}")
        if w.get("reason"):
            print(f"  stopped: {w['reason']}")
        for s in w.get("steps", []):
            uses = f"  [uses {', '.join(s['uses'])}]" if s.get("uses") else ""
            print(f"   {s['id']}: {s['question']}{uses}")
            print(f"       {' -> '.join(s.get('ops') or []) or '(no plan)'}")
    plan = d.get("plan") or {}
    if plan:
        print(f"  intent: {plan.get('intent')}")
        print(f"  ops:    {' -> '.join(s['op'] for s in plan.get('steps', []))}")
        for s in plan.get("steps", []):
            if s["op"] == "filter_attr":
                how = (f"definition {s['definition']} ({s.get('definition_term')}) = {s.get('operator')} {s.get('value')}"
                       if s.get("definition") else
                       f"{s.get('operator')} percentile {s['percentile']}" if s.get("percentile") else
                       f"{s.get('operator')} {s.get('value')}")
                print(f"     filter {s['id']}: {how}")
    prov = d.get("provenance") or {}
    for o in prov.get("attribute_origins", []):
        print(f"  data:   {o.get('description')}  [{o.get('census_code') or o.get('table_name') or o.get('source_kind')}]")
    for x in prov.get("definitions", []) or []:
        print(f"  definition used: \"{x['term']}\" {x['rule']}  ({x['source']})")
    for a in d.get("adjustments") or []:
        print(f"  adjusted: {a}")
    c = d.get("comparison")
    if c:
        lab = c.get("labels") or {}
        print(f"  comparison: {lab.get('a')}  vs  {lab.get('b')}")
        print(f"     median {fmt(c.get('median_a'))} vs {fmt(c.get('median_b'))}   "
              f"(n {c.get('n_a')} vs {c.get('n_b')}, overlap {c.get('overlap')})")
        print(f"     difference {fmt(c.get('diff'))}, rank-biserial {fmt(c.get('rank_biserial'))}, "
              f"p {fmt(c.get('p_value'))} on effective n {c.get('n_eff_a')} / {c.get('n_eff_b')} "
              f"(Moran's I {fmt(c.get('moran_i'))})")
    rows = [r for r in d.get("rows") or [] if r.get("fips")]
    if rows and not c:
        print(f"  rows:   {d.get('row_count')}  e.g. " +
              ", ".join(f"{r.get('name')} {fmt(r.get('value'))}" for r in rows[:6]))
    elif rows:
        print(f"  rows:   {d.get('row_count')} counties across both groups")
    if w and w.get("methods"):
        print("\n  METHODS\n  " + w["methods"].replace("\n", "\n  "))


def health():
    d = json.load(urllib.request.urlopen(f"{BASE}/api/health", timeout=30))
    defs = d.get("definitions") or {}
    print("Active definitions:")
    for x in defs.get("active", []):
        print(f"  {x['term']:<26} {x['measure_code']:<28} {x['rule']:<14} selects {x['selects']}")
    print("Withheld:" + ("" if defs.get("withheld") else " none"))
    for x in defs.get("withheld", []):
        print(f"  {x['id']} ({x['measure_code']}): {x['reason']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", nargs="?", help="demo name, all, ask, research, or health")
    ap.add_argument("question", nargs="?")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--raw", action="store_true", help="print the full JSON response")
    a = ap.parse_args()

    if a.list or not a.what:
        for k, (ep, q, why) in DEMOS.items():
            print(f"  {k:<14} /api/{ep:<9} {why}\n  {'':<14} \"{q}\"")
        return 0
    if a.what == "health":
        health()
        return 0
    if a.what in ("ask", "research"):
        if not a.question:
            sys.exit('give the question in quotes, e.g. python eval/demo.py ask "..."')
        runs = [("custom", ("analyze" if a.what == "ask" else "research", a.question, ""))]
    elif a.what == "all":
        runs = list(DEMOS.items())
    elif a.what in DEMOS:
        runs = [(a.what, DEMOS[a.what])]
    else:
        sys.exit(f"unknown demo {a.what!r}; try --list")

    for name, (ep, q, why) in runs:
        print(f"\n=== {name}  /api/{ep}  {('- ' + why) if why else ''}\n  Q: {q}")
        d, secs = post(ep, q)
        if a.raw:
            print(json.dumps(d, indent=1)[:20000])
        else:
            show(d, secs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
