#!/usr/bin/env python3
"""
Answer-correctness probe: execute each question, compare the ROWS to a gold
answer computed by hand-written SQL.

    python eval/answer_probe.py --check-gold        gold SQL runs, non-empty, per measure
    python eval/answer_probe.py --self-test         the scorer separates right from wrong
    python eval/answer_probe.py --save eval/phaseA/answer-r1.json [--tier now]

WHY THIS EXISTS

plan_probe.py scores the op, answerability_probe.py scores refusals, and
run.py --endpoint analyze scores well-formedness. None of them looks at the
numbers. A plan that divides a poverty percentage by a head count passes all
three. This one fails it, and --self-test proves that it does: every question
carries known-wrong answers that must be classified wrong, and the gold answer
fed back as a response must be classified CORRECT. A metric that cannot fail
its own known-wrong cases measures nothing (eval/README.md).

Classes, in the order they are checked:
  CORRECT / CORRECT_REFUSAL
  FALSE_ANSWER      answered a question the data cannot answer
  NO_ANSWER         no plan, an error, or a refusal of an answerable question
  EXEC_ERROR        a validated plan failed in Postgres
  EMPTY             executed, zero rows
  WRONG_SHAPE       e.g. features where a per-county value was asked for
  WRONG_MEASURE     no loaded attribute is an acceptable measure
  WRONG_GEOGRAPHY   rows outside the places asked about
  INCOMPLETE        right places, too few of them
  WRONG_VALUE       right measure, right places, wrong numbers
"""
from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

SUITE = Path(__file__).resolve().parent / "research.yaml"
DB_CONTAINER = "geoark-db-1"
API_CONTAINER = "geoark-api-1"

_C = sys.stdout.isatty()
GREEN, RED, YELLOW, DIM, BOLD, OFF = (
    ("\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m", "\033[0m")
    if _C else ("", "", "", "", "", ""))

PASS = {"CORRECT", "CORRECT_REFUSAL"}
GEO_SLACK = 0.02          # share of result rows allowed outside the gold domain


# --------------------------------------------------------------------- database

def psql(sql: str) -> list[list[str | None]]:
    """Run SQL in the db container; rows as lists of strings (None for NULL)."""
    # 300 s, not 180: brute-force overlay gold (gis_ops.yaml overlay family)
    # intersects whole river polygons with no parts, ~240 s for MO roads x NWI.
    wrapped = "SET statement_timeout = '300s';\n" + sql.strip().rstrip(";") + ";\n"
    p = subprocess.run(
        ["docker", "exec", "-i", DB_CONTAINER, "sh", "-c",
         'psql -U "${POSTGRES_USER:-postgres}" -d mygisdb -X -q -At '
         '-F "\t" -P null=\\\\N -v ON_ERROR_STOP=1'],
        input=wrapped, capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "psql failed")
    out = []
    for line in p.stdout.splitlines():
        if line == "SET" or not line:
            continue
        out.append([None if c == "\\N" else c for c in line.split("\t")])
    return out


def sql_lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def expand(sql: str, bind: dict[str, str], regions: dict[str, list[str]]) -> str:
    def code(m):
        name = m.group(1)
        if name not in bind:
            raise KeyError(f"measure {name} not bound")
        return bind[name]

    def latest(m):
        c = sql_lit(code(m))
        return (f"(SELECT fips, value FROM acs_county_values WHERE census_code = {c} "
                f"AND year = (SELECT max(year) FROM acs_county_values WHERE census_code = {c}))")

    def year(m):
        c = sql_lit(code(m))
        return (f"(SELECT fips, value FROM acs_county_values WHERE census_code = {c} "
                f"AND year = {int(m.group(2))})")

    def geo(m):
        # A measure below the county level (Phase E): geo_values, latest year,
        # keyed `fips` so every compare kind works on geoids unchanged.
        lv, c = sql_lit(m.group(1)), sql_lit(code(re.match(r"(\w+)", m.group(2))))
        return (f"(SELECT geoid AS fips, value FROM geo_values WHERE level = {lv} AND code = {c} "
                f"AND year = (SELECT max(year) FROM geo_values WHERE level = {lv} AND code = {c}))")

    def table(m):
        # A feature layer's table, bound like any measure (its origin key).
        t = code(m)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", t):
            raise ValueError(f"not a table name: {t}")
        return t

    def fkey(m):
        # A feature's identity: its first coordinate to 5 decimals, the same
        # key normalise() takes from the answer's GeoJSON (feature_key).
        g = m.group(1)
        return (f"(round(ST_X(ST_GeometryN({g}, 1))::numeric, 5) || ',' || "
                f"round(ST_Y(ST_GeometryN({g}, 1))::numeric, 5))")

    sql = re.sub(r"\{table:(\w+)\}", table, sql)
    sql = re.sub(r"\{fkey:([\w.]+)\}", fkey, sql)
    sql = re.sub(r"\{geo:(\w+):(\w+)\}", geo, sql)
    sql = re.sub(r"\{latest:(\w+)\}", latest, sql)
    sql = re.sub(r"\{year:(\w+):(\d{4})\}", year, sql)
    sql = re.sub(r"\{code:(\w+)\}", lambda m: sql_lit(code(m)), sql)
    sql = re.sub(r"\{region:(\w+)\}",
                 lambda m: "(" + ",".join(sql_lit(s) for s in regions[m.group(1)]) + ")", sql)
    return sql


def gold_rows(sql: str) -> list[dict]:
    rows = []
    for r in psql(sql):
        d = {"fips": r[0], "value": None if r[1] is None else float(r[1])}
        if len(r) > 2:
            d["grp"] = r[2]
        rows.append(d)
    return rows


# --------------------------------------------------------------------- measures

def catalog_candidates(regex: str) -> list[str]:
    """Origin strings in the catalog an acceptable-measure regex matches,
    built the same way a response's provenance is rendered."""
    rows = psql(
        "SELECT DISTINCT COALESCE(census_code, table_name), "
        "regexp_replace(COALESCE(description, ''), '[\\t\\n]', ' ', 'g'), dataset_id, "
        "source_kind FROM attribute_source")
    # Measures loaded only below the county level have no attribute_source
    # row by design (CLAUDE.md, "Non-county measures get NO catalog row");
    # geo_measure lists them, so a Phase E question can still bind one.
    known = {r[0] for r in rows}
    try:
        rows += [(c, lbl, "geo_measure", "geo") for c, lbl in psql(
            "SELECT DISTINCT code, regexp_replace(COALESCE(label, ''), '[\\t\\n]', ' ', 'g') "
            "FROM geo_measure") if c not in known]
    except RuntimeError:
        pass
    out = []
    for key, desc, ds, kind in rows:
        s = f"{key} | {desc} | {ds}"
        if re.search(regex, s):
            # Feature layers have one catalog row per column; one per table.
            if kind == "feature_table" and any(o.startswith(key + " ") for o in out):
                continue
            out.append(s)
    return out


def bind_measures(q: dict, measures: dict, origins: list[str]) -> tuple[dict | None, list]:
    """Assign each measure the question needs a distinct loaded attribute."""
    bind, used, missing = {}, set(), []
    for name, mkey in (q.get("measures") or {}).items():
        rx = measures[mkey]
        hit = next((i for i, o in enumerate(origins)
                    if i not in used and re.search(rx, o)), None)
        if hit is None:
            missing.append(mkey)
            continue
        used.add(hit)
        bind[name] = origins[hit].split(" | ")[0]
    return (None if missing else bind), missing


# ---------------------------------------------------------------- normalisation

def normalise(body: dict) -> dict:
    """Reduce an /api/analyze response to what scoring needs."""
    steps = (body.get("plan") or {}).get("steps") or []
    layers = []

    def add(rows):
        # compare_groups returns ONE layer whose rows carry `grp` (a / b). That
        # is the shape the gold already has, so it is split into one layer per
        # group exactly as self_test's as_answer splits the gold.
        # A unit below the county (Phase E) may come back keyed `geoid`.
        rows = [{**r, "fips": r.get("fips") or r.get("geoid")} for r in rows or []]
        rows = [r for r in rows if r.get("fips")]
        if rows and "grp" in rows[0]:
            by = {}
            for r in rows:
                by.setdefault(r.get("grp"), {})[r["fips"]] = r.get("value")
            layers.extend(by.values())
        else:
            layers.append({r["fips"]: r.get("value") for r in rows})

    feature_layers = []
    if body.get("layers"):
        for l in body["layers"]:
            if l.get("mode") == "features":
                feature_layers.append({k: v for k, v in (feature_key(f) for f in l.get("features") or []) if k})
                continue
            add(l.get("rows"))
    elif body.get("output_mode") == "features" and body.get("features"):
        # A single features output comes back flat, without `layers`.
        feature_layers.append({k: v for k, v in (feature_key(f) for f in body["features"]) if k})
    elif body.get("rows"):
        add(body["rows"])
    scalar = None
    if isinstance(body.get("stats"), dict) and body["stats"].get("value") is not None:
        scalar = body["stats"]["value"]
    elif body.get("rows") and len(body["rows"]) == 1 and not body["rows"][0].get("fips"):
        scalar = body["rows"][0].get("value")
    origins = []
    for o in (body.get("provenance") or {}).get("attribute_origins") or []:
        key = o.get("census_code") or o.get("table_name") or o.get("original_name") or "?"
        origins.append(f"{key} | {o.get('description') or ''} | {o.get('dataset') or ''}")
    return {
        "planned": bool(steps),
        "error": body.get("error"),
        "exec_error": body.get("execution_error"),
        "mode": body.get("output_mode"),
        "row_count": body.get("row_count") or 0,
        "layers": [l for l in layers if l],
        "feature_layers": [l for l in feature_layers if l],
        "scalar": scalar,
        "origins": origins,
    }


def feature_key(f: dict) -> tuple[str | None, float | None]:
    """(key, value) of one returned feature; the key matches gold's {fkey:...}."""
    g = (f or {}).get("geometry") or {}
    c = g.get("coordinates")
    while isinstance(c, list) and c and isinstance(c[0], list):
        c = c[0]
    if not (isinstance(c, list) and len(c) >= 2):
        return None, None
    # within's distance comes back as `miles_to_nearest` (earlier builds: `value`).
    props = f.get("properties") or {}
    # overlay's amount inside the second layer comes back as `amount_inside` (H3).
    v = props.get("miles_to_nearest", props.get("amount_inside", props.get("value")))
    return f"{c[0]:.5f},{c[1]:.5f}", (1.0 if v is None else _num(v))


# ------------------------------------------------------------------- comparison

def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _close(a, b, cmp):
    tol = max(cmp.get("rel_tol", 0.0) * abs(b), cmp.get("abs_tol", 0.0))
    return abs(a - b) <= tol + 1e-9


def compare(cmp: dict, gold: list[dict], ans: dict) -> tuple[str, dict]:
    kind = cmp["kind"]
    if kind == "scalar":
        if ans["scalar"] is None:
            return "WRONG_SHAPE", {"why": "no single statistic returned"}
        g = gold[0]["value"]
        return ("CORRECT" if _close(float(ans["scalar"]), g, cmp) else "WRONG_VALUE",
                {"gold": round(g, 4), "got": round(float(ans["scalar"]), 4)})

    if cmp.get("features"):
        # The answer is the features themselves (GIS_OPS_PLAN.md H1), keyed
        # by position. A per-county map is the wrong shape for "which ones".
        if not ans.get("feature_layers"):
            return "WRONG_SHAPE", {"why": "no features returned"}
        layer = ans["feature_layers"][0]
        want = {r["fips"]: r["value"] for r in gold if r["value"] is not None}
        base = {"features": len(layer), "gold_features": len(want)}
        if kind == "set":
            got = set(layer)
            j = len(got & set(want)) / len(got | set(want)) if got | set(want) else 1.0
            base.update(jaccard=round(j, 3), extra=len(got - set(want)), missed=len(set(want) - got))
            return ("CORRECT" if j >= cmp.get("min_jaccard", 0.95) else "WRONG_VALUE"), base
        if kind == "top_k":
            desc = cmp.get("direction", "desc") == "desc"
            kk = min(cmp["k"], len(want))
            if len(layer) < kk:
                return "INCOMPLETE", {**base, "why": f"only {len(layer)} features"}
            got = set(list(layer)[:kk]) if cmp.get("ordered_by_api") else                 {k for k, _ in sorted(layer.items(), key=lambda t: (t[1] is None, t[1]), reverse=desc)[:kk]}
            ranked = sorted(want.items(), key=lambda t: t[1], reverse=desc)
            cut = ranked[kk - 1][1]
            top = {k for k, v in ranked if (v >= cut if desc else v <= cut)}
            overlap = len(got & top) / kk
            base.update(k=kk, overlap=round(overlap, 3))
            return ("CORRECT" if overlap >= cmp.get("min_overlap", 0.8) else "WRONG_VALUE"), base
        raise ValueError(f"compare kind {kind} does not take features")

    if not ans["layers"]:
        return "WRONG_SHAPE", {"why": "no per-county rows"}

    domain = {r["fips"]: r["value"] for r in gold if r["value"] is not None}

    if kind == "groups":
        groups: dict[str, set] = {}
        for r in gold:
            if r["value"] is not None:
                groups.setdefault(r["grp"], set()).add(r["fips"])
        detail, missing = {}, []
        for g, members in groups.items():
            best = None
            for layer in ans["layers"]:
                fs = {f for f, v in layer.items() if _num(v) is not None}
                j = len(fs & members) / len(fs | members) if fs | members else 0
                if j >= cmp.get("min_jaccard", 0.9) and (best is None or j > best[0]):
                    best = (j, layer)
            gmed = statistics.median(domain[f] for f in members)
            if best is None:
                missing.append(g)
                detail[g] = {"gold_median": round(gmed, 3), "matched": False}
                continue
            got = statistics.median(_num(v) for v in best[1].values() if _num(v) is not None)
            detail[g] = {"gold_median": round(gmed, 3), "got_median": round(got, 3),
                         "jaccard": round(best[0], 3), "ok": _close(got, gmed, cmp)}
        if missing:
            return "INCOMPLETE", {"groups": detail, "unmatched": missing}
        ok = all(d["ok"] for d in detail.values())
        return ("CORRECT" if ok else "WRONG_VALUE"), {"groups": detail}

    # top_k / values / set use the first layer: the answer, by API contract.
    layer = {f: _num(v) for f, v in ans["layers"][0].items()}
    outside = [f for f in layer if f not in domain]
    share_out = len(outside) / len(layer)
    base = {"rows": len(layer), "gold_rows": len(domain),
            "outside": len(outside), "outside_sample": outside[:5]}
    if share_out > GEO_SLACK:
        return "WRONG_GEOGRAPHY", base

    if kind == "set":
        got, want = set(layer), set(domain)
        j = len(got & want) / len(got | want) if got | want else 1.0
        base["jaccard"] = round(j, 3)
        return ("CORRECT" if j >= cmp.get("min_jaccard", 0.8) else "INCOMPLETE"), base

    if kind == "values":
        both = [f for f in domain if layer.get(f) is not None]
        cov = len(both) / len(domain) if domain else 0
        base["coverage"] = round(cov, 3)
        if cov < cmp.get("min_coverage", 0.9):
            return "INCOMPLETE", base
        ok = sum(_close(layer[f], domain[f], cmp) for f in both)
        base["within_tol"] = round(ok / len(both), 3)
        bad = [f for f in both if not _close(layer[f], domain[f], cmp)][:3]
        base["mismatch_sample"] = [{"fips": f, "gold": round(domain[f], 4),
                                    "got": round(layer[f], 4)} for f in bad]
        return ("CORRECT" if ok / len(both) >= cmp.get("min_within", 0.95)
                else "WRONG_VALUE"), base

    if kind == "top_k":
        desc = cmp.get("direction", "desc") == "desc"
        vals = [(f, v) for f, v in layer.items() if v is not None]
        kk = min(cmp["k"], len(vals))
        if kk < min(5, cmp["k"]):
            return "INCOMPLETE", {**base, "why": f"only {kk} ranked rows"}
        got = [f for f, _ in sorted(vals, key=lambda t: t[1], reverse=desc)[:kk]]
        ranked = sorted(domain.items(), key=lambda t: t[1], reverse=desc)
        cut = ranked[kk - 1][1]
        # Ties at the k-th value widen the gold set rather than making the
        # answer depend on tie order.
        want = {f for f, v in ranked if (v >= cut if desc else v <= cut)}
        overlap = len(set(got) & want) / kk
        base.update(k=kk, overlap=round(overlap, 3))
        return ("CORRECT" if overlap >= cmp.get("min_overlap", 0.8)
                else "WRONG_VALUE"), base

    raise ValueError(f"unknown compare kind {kind}")


ORDER = ["CORRECT", "INCOMPLETE", "WRONG_VALUE", "WRONG_GEOGRAPHY", "WRONG_SHAPE"]


def is_transport_error(err) -> bool:
    """The API never answered: proxy 5xx, connection refused, timeout. Not a
    refusal, not a failure of the system under test, and never scored. The
    first baseline scored three 502s as CORRECT_REFUSAL."""
    e = str(err or "")
    return bool(re.match(r"HTTP 5\d\d$", e)) or any(
        s in e for s in ("Connection refused", "timed out", "Remote end closed",
                         "urlopen error", "Connection reset"))


def score(q: dict, suite: dict, ans: dict, gold_cache: dict) -> tuple[str, dict]:
    cmp = q["compare"]
    if is_transport_error(ans["error"]):
        return "HARNESS_ERROR", {"error": str(ans["error"])[:160]}
    answered = ans["planned"] and not ans["error"] and (
        ans["layers"] or ans.get("feature_layers") or ans["scalar"] is not None)
    if cmp["kind"] == "refuse":
        return ("FALSE_ANSWER" if answered else "CORRECT_REFUSAL"), {}
    if not ans["planned"] or ans["error"]:
        return "NO_ANSWER", {"error": (ans["error"] or "")[:160]}
    if ans["exec_error"]:
        return "EXEC_ERROR", {"error": ans["exec_error"][:160]}
    if ans["mode"] == "features" and not cmp.get("features"):
        return "WRONG_SHAPE", {"why": "features returned"}
    if not ans["layers"] and ans["scalar"] is None and not ans.get("feature_layers"):
        return "EMPTY", {}
    bind, missing = bind_measures(q, suite["measures"], ans["origins"])
    if bind is None:
        return "WRONG_MEASURE", {"missing": missing, "loaded": ans["origins"]}
    golds = q["gold"] if isinstance(q["gold"], list) else [q["gold"]]
    results = []
    for i, g in enumerate(golds):
        sql = expand(g, bind, suite.get("regions", {}))
        if sql not in gold_cache:
            gold_cache[sql] = gold_rows(sql)
        cls, det = compare(cmp, gold_cache[sql], ans)
        results.append((cls, {**det, "gold_alt": i, "bind": bind}))
    results.sort(key=lambda t: ORDER.index(t[0]) if t[0] in ORDER else 99)
    return results[0]


# ------------------------------------------------------------------------ modes

def default_bind(q: dict, suite: dict) -> dict:
    out = {}
    for name, mkey in (q.get("measures") or {}).items():
        c = catalog_candidates(suite["measures"][mkey])
        if c:
            out[name] = c[0]
    return out


def check_gold(suite: dict) -> int:
    """Every gold query runs and is non-empty, for EVERY acceptable code."""
    bad = 0
    cands = {k: catalog_candidates(rx) for k, rx in suite["measures"].items()}
    for k, c in cands.items():
        print(f"  {k:<22} {len(c)} acceptable: "
              f"{', '.join(x.split(' | ')[0][:28] for x in c[:6])}")
        if not c:
            print(f"    {RED}no catalog row matches {suite['measures'][k]}{OFF}")
            bad += 1
    print()
    for q in suite["queries"]:
        if q["compare"]["kind"] == "refuse":
            continue
        ms = q.get("measures") or {}
        # Vary one measure at a time over all its codes, others at default.
        combos = [{}] if not ms else []
        base = {n: cands[m][0].split(" | ")[0] for n, m in ms.items() if cands[m]}
        for n, m in ms.items():
            for c in cands[m]:
                combos.append({**base, n: c.split(" | ")[0]})
        golds = q["gold"] if isinstance(q["gold"], list) else [q["gold"]]
        for b in combos:
            for i, g in enumerate(golds):
                t0 = time.time()
                try:
                    rows = gold_rows(expand(g, b, suite.get("regions", {})))
                    n = sum(r["value"] is not None for r in rows)
                    mark = GREEN + "ok " + OFF if n else RED + "EMPTY" + OFF
                    bad += 0 if n else 1
                    print(f"  {mark} {q['id']:<28} alt{i} {n:5d} rows  "
                          f"{DIM}{b} ({time.time() - t0:.1f}s){OFF}")
                except Exception as e:
                    bad += 1
                    print(f"  {RED}FAIL{OFF} {q['id']:<28} alt{i} {b}: {str(e)[:200]}")
    print(f"\n  {bad} problem(s)")
    return 1 if bad else 0


def self_test(suite: dict) -> int:
    """The scorer must pass gold-as-answer and fail every known-wrong answer."""
    fails, n = 0, 0
    cache: dict = {}
    rng = random.Random(7)
    regions = suite.get("regions", {})

    def as_answer(rows, origins, groups=False, features=False):
        if features:
            return {"planned": True, "error": None, "exec_error": None, "mode": "features",
                    "row_count": len(rows), "layers": [], "scalar": None, "origins": origins,
                    "feature_layers": [{r["fips"]: r["value"] for r in rows}]}
        if rows and rows[0]["fips"] is None:
            return {"planned": True, "error": None, "exec_error": None, "mode": "values",
                    "row_count": 1, "layers": [], "scalar": rows[0]["value"], "origins": origins}
        if groups and rows and "grp" in rows[0]:
            by = {}
            for r in rows:
                by.setdefault(r["grp"], {})[r["fips"]] = r["value"]
            layers = list(by.values())
        else:
            layers = [{r["fips"]: r["value"] for r in rows}]
        return {"planned": True, "error": None, "exec_error": None, "mode": "values",
                "row_count": len(rows), "layers": layers, "scalar": None, "origins": origins}

    def check(label, got, want):
        nonlocal fails, n
        n += 1
        ok = got == want
        fails += 0 if ok else 1
        print(f"  {GREEN + 'ok  ' + OFF if ok else RED + 'FAIL' + OFF} {label:<52} "
              f"{got}{'' if ok else f'  (expected {want})'}")

    empty = {"planned": False, "error": "could not produce a valid plan", "exec_error": None,
             "mode": None, "row_count": 0, "layers": [], "scalar": None, "origins": []}
    for q in suite["queries"]:
        if q["compare"]["kind"] == "refuse":
            check(f"{q['id']} / refusal", score(q, suite, empty, cache)[0], "CORRECT_REFUSAL")
            fake = as_answer([{"fips": "29510", "value": 1.0}], ["X | made up | Y"])
            check(f"{q['id']} / any answer", score(q, suite, fake, cache)[0], "FALSE_ANSWER")
            # A proxy 502 is not a refusal (the first baseline scored it as one).
            check(f"{q['id']} / HTTP 502", score(q, suite, {**empty, "error": "HTTP 502"},
                                                 cache)[0], "HARNESS_ERROR")
            continue
        db = default_bind(q, suite)
        bind = {k: v.split(" | ")[0] for k, v in db.items()}
        origins = list(db.values())
        golds = q["gold"] if isinstance(q["gold"], list) else [q["gold"]]
        groups = q["compare"]["kind"] == "groups"
        feats = q["compare"].get("features") is True
        # 1. Gold fed back is CORRECT, for each alternative.
        for i, g in enumerate(golds):
            rows = gold_rows(expand(g, bind, regions))
            check(f"{q['id']} / gold alt{i}",
                  score(q, suite, as_answer(rows, origins, groups, feats), cache)[0], "CORRECT")
        # 2. Shuffled values on the right places are not CORRECT.
        # One row (a single named county) cannot be shuffled into a different
        # answer; its `wrong:` entries below are its check.
        rows = gold_rows(expand(golds[0], bind, regions)) \
            if q["compare"]["kind"] in ("values", "top_k") else []
        if len({r["value"] for r in rows}) >= 2:
            vals = [r["value"] for r in rows]
            rng.shuffle(vals)
            shuf = [{**r, "value": v} for r, v in zip(rows, vals)]
            got = score(q, suite, as_answer(shuf, origins, False, feats), cache)[0]
            check(f"{q['id']} / shuffled values", got if got != "CORRECT" else "CORRECT",
                  got if got != "CORRECT" else "not CORRECT")
        # 3. Each declared wrong answer gets its declared class.
        for j, w in enumerate(q.get("wrong") or []):
            wb = {**bind, **(w.get("bind") or {})}
            worigins = w.get("origins") or [
                next((o for o in origins if o.startswith(c + " ")), f"{c} | | ")
                for c in wb.values()]
            rows = gold_rows(expand(w["sql"], wb, regions))
            check(f"{q['id']} / wrong{j}",
                  score(q, suite, as_answer(rows, worigins, groups, feats and rows and rows[0]["fips"] is not None), cache)[0], w["expect"])
        # 4. No answer at all.
        check(f"{q['id']} / no plan", score(q, suite, empty, cache)[0], "NO_ANSWER")
    print(f"\n  {n - fails}/{n} scorer checks passed")
    return 1 if fails else 0


def call_analyze(base: str, query: str, timeout: int, extra: dict,
                 endpoint: str = "analyze") -> tuple[dict, float]:
    # /api/research (Phase D) returns the last step's analyze body, so the same
    # normalise() and scoring read it; provenance there spans every step.
    body = json.dumps({"q": query, "execute": True, "include_geometry": False, **extra}).encode()
    req = urllib.request.Request(f"{base}/api/{endpoint}", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode()), time.time() - t0
        except Exception:
            return {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:
        return {"error": str(e)}, time.time() - t0


def api_created() -> str | None:
    p = subprocess.run(["docker", "inspect", API_CONTAINER, "--format", "{{.Created}}"],
                       capture_output=True, text=True)
    return p.stdout.strip() or None


def run(suite: dict, args) -> dict:
    extra = {}
    if args.plan_think:
        extra["plan_think"] = args.plan_think
    if args.plan_model:
        extra["plan_model"] = args.plan_model
    if args.executable_first is not None:
        extra["executable_first"] = args.executable_first
    created_before = api_created()
    cache: dict = {}
    rows = []
    aborted = None
    for q in suite["queries"]:
        if args.tier and q.get("tier") != args.tier:
            continue
        if args.only and q["id"] not in args.only:
            continue
        # A redeploy mid-run means later questions run on a different build.
        # Stop rather than score a mixture.
        if api_created() != created_before:
            aborted = f"API container recreated before {q['id']}"
            print(f"  {RED}{aborted}; aborting{OFF}")
            break
        body, secs = call_analyze(args.base, q["query"], args.timeout, extra, args.endpoint)
        ans = normalise(body)
        try:
            cls, det = score(q, suite, ans, cache)
        except Exception as e:
            cls, det = "SCORER_ERROR", {"error": str(e)[:300]}
        steps = (body.get("plan") or {}).get("steps") or []
        rows.append({
            "id": q["id"], "tier": q.get("tier"), "query": q["query"], "class": cls,
            "pass": cls in PASS, "detail": det,
            "ops": "->".join(s.get("op", "?") for s in steps),
            "intent": (body.get("plan") or {}).get("intent"),
            "loaded": ans["origins"], "row_count": ans["row_count"],
            "error": body.get("error"), "exec_error": body.get("execution_error"),
            # --endpoint research: how the question was split, and whether the
            # workflow ran to the end. Over-splitting a one-plan question is
            # the failure this records.
            **({"workflow": {
                "status": body["workflow"].get("status"),
                "steps": [{"id": s.get("id"), "question": s.get("question"), "uses": s.get("uses"),
                           "ops": "->".join(s.get("ops") or [])}
                          for s in body["workflow"].get("steps") or []],
                "planned_steps": len((body["workflow"].get("decomposition") or {}).get("steps") or []),
                "fallback": (body["workflow"].get("decomposition") or {}).get("fallback"),
                "reason": body["workflow"].get("reason"),
            }} if isinstance(body.get("workflow"), dict) else {}),
            "seconds": round(secs, 1),
        })
        color = GREEN if cls in PASS else RED
        print(f"  {color}{cls:<16}{OFF} {q['id']:<28} {rows[-1]['ops'] or ''}  "
              f"{DIM}({secs:.0f}s){OFF}", flush=True)
        if cls not in PASS:
            print(f"      {DIM}{json.dumps(det)[:260]}{OFF}")
    created_after = api_created()
    harness = [r for r in rows if r["class"] == "HARNESS_ERROR"]
    rows_all, rows = rows, [r for r in rows if r["class"] != "HARNESS_ERROR"]
    n = len(rows) or 1
    tiers = {}
    for r in rows:
        t = tiers.setdefault(r["tier"], [0, 0])
        t[0] += r["pass"]
        t[1] += 1
    classes = {}
    for r in rows:
        classes[r["class"]] = classes.get(r["class"], 0) + 1
    return {
        "suite": str(args.suite_file.name), "queries": len(rows),
        "answer_correctness": sum(r["pass"] for r in rows) / n,
        "by_tier": {k: {"pass": v[0], "n": v[1], "rate": v[0] / v[1]} for k, v in tiers.items()},
        "classes": classes,
        "latency_mean": round(sum(r["seconds"] for r in rows) / n, 1),
        "api_container_created": created_before,
        # A redeploy mid-run means the questions did not all see one build.
        "contaminated": created_before != created_after,
        "aborted": aborted,
        # Questions the API never answered (proxy 5xx, connection refused).
        # Excluded from every rate above; a run with any is not a baseline.
        "harness_errors": len(harness),
        "plan_think": args.plan_think,
        "plan_model": args.plan_model,
        "executable_first": args.executable_first,
        "endpoint": args.endpoint,
        "detail": rows_all,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite-file", type=Path, default=SUITE)
    ap.add_argument("--timeout", type=int, default=400)
    ap.add_argument("--save", type=Path)
    ap.add_argument("--tier")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--plan-think")
    # A planner from the API's PLAN_MODEL_CHOICES; default is its PLAN_MODEL.
    ap.add_argument("--plan-model")
    # Executable-first retrieval, per request; default is the API's EXECUTABLE_FIRST.
    ap.add_argument("--executable-first", dest="executable_first", action="store_const",
                    const=True, default=None)
    ap.add_argument("--no-executable-first", dest="executable_first", action="store_const",
                    const=False)
    ap.add_argument("--endpoint", choices=["analyze", "research"], default="analyze",
                    help="research = /api/research, the multi-step workflow (Phase D)")
    ap.add_argument("--check-gold", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    suite = yaml.safe_load(args.suite_file.read_text(encoding="utf-8"))
    if args.check_gold:
        return check_gold(suite)
    if args.self_test:
        return self_test(suite)

    print(f"{BOLD}answer-correctness probe{OFF}  {DIM}{len(suite['queries'])} queries{OFF}\n")
    res = run(suite, args)
    print(f"\n{'=' * 62}")
    print(f"{BOLD}  answer correctness  {res['answer_correctness']:.1%}  "
          f"n={res['queries']}{OFF}")
    for t, v in res["by_tier"].items():
        print(f"    {t:<10} {v['pass']}/{v['n']}")
    for c, k in sorted(res["classes"].items(), key=lambda t: -t[1]):
        print(f"    {c:<16} {k}")
    print(f"  mean latency {res['latency_mean']}s")
    if res["contaminated"]:
        print(f"  {RED}API container was recreated during the run: results mix builds{OFF}")
    if res["harness_errors"]:
        print(f"  {RED}{res['harness_errors']} question(s) never reached the API "
              f"(excluded): not a valid baseline{OFF}")
    if args.save:
        args.save.parent.mkdir(parents=True, exist_ok=True)
        args.save.write_text(json.dumps(res, indent=2), encoding="utf-8")
        print(f"  saved -> {args.save}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
