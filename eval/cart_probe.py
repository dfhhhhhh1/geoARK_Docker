"""Data cart selection probe: rules vs top-8 vs the LLM curator, on one shelf.

    python eval/cart_probe.py --split dev --arms off,lit,both,web --save eval/cart/dev.json
    python eval/cart_probe.py --split heldout --arms both --save eval/cart/heldout.json

Arms are expansion settings:
    off   no expansion          lit   literature only
    both  literature + PubMed   web   literature + PubMed + web
Per (question, arm) the API returns ONE shelf and all three carts, so the
selection comparison is paired. Duplicates are measured on the data: every
cart is checked out (national) and two columns with |Spearman| >= 0.97 on
shared counties count as one measure twice. See eval/cart.yaml for the gold.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import yaml

ARMS = {
    "off": {"expand": False, "research": ""},
    "lit": {"expand": True, "research": ""},
    "both": {"expand": True, "research": "pubmed"},
    "web": {"expand": True, "research": "pubmed,web"},
}
SELECTIONS = ("rules", "top8", "curator")


def post(base, path, body, timeout=400):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode()[:300]}


def ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(a, b):
    ra, rb = ranks(a), ranks(b)
    n = len(ra)
    ma, mb = sum(ra) / n, sum(rb) / n
    c = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = sum((x - ma) ** 2 for x in ra) ** 0.5
    vb = sum((y - mb) ** 2 for y in rb) ** 0.5
    return c / (va * vb) if va and vb else 0.0


def duplicates(base, cart, cache):
    """Columns in the cart that repeat an earlier column's data."""
    key = tuple(sorted(cart))
    if key in cache:
        return cache[key]
    if len(cart) < 2:
        cache[key] = 0
        return 0
    t = post(base, "/api/cart/table", {"items": cart})
    if "error" in t:
        cache[key] = None
        return None
    cols = list(zip(*[r["values"] for r in t["rows"]]))
    dup = set()
    for j in range(len(cols)):
        for i in range(j):
            if i in dup:
                continue
            pairs = [(x, y) for x, y in zip(cols[i], cols[j]) if x is not None and y is not None]
            if len(pairs) >= 30 and abs(spearman(*zip(*pairs))) >= 0.97:
                dup.add(j)
                break
    cache[key] = len(dup)
    return len(dup)


def score(q, cart, items, ok_re):
    text = {i["id"]: f'{i["label"]} {i.get("description") or ""} {i["dataset"] or "" if i["kind"] == "feature" else ""}'
            for i in items}
    for i in items:
        for v in i.get("variants", []):
            text[v["id"]] = f'{v["label"]} {v.get("description") or ""}'
    must = re.compile(q["must"], re.I) if q.get("must") else None
    should = re.compile(q["should"], re.I) if q.get("should") else None
    good = 0
    hit_must = hit_should = False
    for cid in cart:
        t = text.get(cid, cid)
        m = bool(must and must.search(t))
        s = bool(should and should.search(t))
        hit_must |= m
        hit_should |= s
        # A question nothing loaded answers (rainfall): every item is junk.
        good += (m or s or bool(ok_re.search(t))) if (must or should) else 0
    cov = [i["coverage"] for i in items if i["id"] in cart and i.get("coverage")]
    return {
        "size": len(cart),
        "precision": good / len(cart) if cart else (1.0 if not (must or should) else 0.0),
        "junk": len(cart) - good,
        "subject": hit_must if must else None,
        "related": hit_should if should else None,
        "coverage": sum(cov) / len(cov) if cov else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite", default="eval/cart.yaml")
    ap.add_argument("--split", default="dev")
    ap.add_argument("--arms", default="off,lit,both,web")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--only", default="")
    ap.add_argument("--save", default="")
    a = ap.parse_args()
    suite = yaml.safe_load(open(a.suite, encoding="utf-8"))
    qs = [q for q in suite[a.split] if not a.only or q["id"] in a.only.split(",")]
    dup_cache = {}
    runs = []
    for arm in a.arms.split(","):
        for rep in range(a.repeats):
            for q in qs:
                ok_re = re.compile(suite["common_ok"] + ("|" + suite["health_ok"] if q.get("health") else ""), re.I)
                t0 = time.time()
                d = post(a.base, "/api/cart/suggest", {"q": q["query"], "curate": True, **ARMS[arm]})
                if "error" in d:
                    print(f"{arm} {q['id']}: {d}", file=sys.stderr)
                    runs.append({"arm": arm, "rep": rep, "id": q["id"], "error": d})
                    continue
                carts = {"rules": d["baselines"]["rules"], "top8": d["baselines"]["top8"],
                         "curator": (d.get("curated") or {}).get("cart", [])}
                rec = {"arm": arm, "rep": rep, "id": q["id"], "seconds": round(time.time() - t0, 1),
                       "shelf": len(d["items"]), "selection": d.get("selection"),
                       "curator_ms": (d.get("curated") or {}).get("ms"),
                       "curator_fallback": (d.get("curated") or {}).get("fallback"),
                       "labels": {i["id"]: i["label"] for i in d["items"]},
                       "verdicts": (d.get("curated") or {}).get("verdicts"), "carts": carts, "scores": {}}
                for sel, c in carts.items():
                    s = score(q, c, d["items"], ok_re)
                    s["duplicates"] = duplicates(a.base, c, dup_cache)
                    rec["scores"][sel] = s
                runs.append(rec)
                line = "  ".join(f"{sel} p={rec['scores'][sel]['precision']:.2f} n={rec['scores'][sel]['size']}"
                                 f" s={rec['scores'][sel]['subject']} d={rec['scores'][sel]['duplicates']}"
                                 for sel in SELECTIONS)
                print(f"{arm:4} {q['id']:14} {rec['seconds']:5.1f}s  {line}", flush=True)

    print("\nsummary (mean over questions; subject/related = share of questions hit)")
    summary = {}
    for arm in a.arms.split(","):
        ok_runs = [r for r in runs if r["arm"] == arm and "scores" in r]
        for sel in SELECTIONS:
            ss = [r["scores"][sel] for r in ok_runs]
            if not ss:
                continue
            avg = lambda k: (lambda v: sum(v) / len(v) if v else None)([x[k] for x in ss if x[k] is not None])
            row = {k: avg(k) for k in ("precision", "junk", "size", "subject", "related", "duplicates", "coverage")}
            summary[f"{arm}/{sel}"] = row
            print(f"{arm:4} {sel:8} " + "  ".join(
                f"{k} {v:.3f}" if isinstance(v, float) else f"{k} {v}" for k, v in row.items()))
        cm = [r["curator_ms"] for r in ok_runs if r.get("curator_ms")]
        if cm:
            print(f"{arm:4} curator latency mean {sum(cm) / len(cm) / 1000:.1f}s, "
                  f"fallbacks {sum(1 for r in ok_runs if r.get('curator_fallback'))}")
    if a.save:
        Path(a.save).parent.mkdir(parents=True, exist_ok=True)
        json.dump({"split": a.split, "arms": a.arms, "runs": runs, "summary": summary},
                  open(a.save, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
