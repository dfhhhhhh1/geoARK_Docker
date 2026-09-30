#!/usr/bin/env python3
"""
Follow-up interpretation probe.

    python eval/followup_probe.py --repeat 3 --save eval/followup-run1.json
    python eval/followup_probe.py --compare eval/followup-run1.json

Scores POST /api/analyze/followup against eval/followup.yaml: whether each
message was classified as an edit or a question, and, for questions, whether the
rewrite kept the context it needed and dropped what the follow-up replaced.
See the header of followup.yaml for what this can and cannot see.

--repeat defaults to 3. The rewrite runs at temperature 0, which should make
repeats identical; this checks that rather than assuming it. A small suite read
once has misled this project before (CLAUDE.md, stats probe: 1/5 then 4/5 x3).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

SUITE = Path(__file__).resolve().parent / "followup.yaml"

PLAIN = {"intent": "x", "output_type": "map", "entity_type": "COUNTY", "steps": [
    {"id": "s1", "op": "load", "attr_id": "a", "inputs": []},
    {"id": "s2", "op": "output", "attr_id": "", "inputs": ["s1"]}]}
AREA = {"intent": "x", "output_type": "map", "entity_type": "COUNTY", "steps": [
    {"id": "s1", "op": "load", "attr_id": "a", "inputs": []},
    {"id": "s2", "op": "filter_area", "attr_id": "", "inputs": ["s1"], "states": ["Missouri"]},
    {"id": "s3", "op": "output", "attr_id": "", "inputs": ["s2"]}]}


def call(base: str, case: dict, timeout: int) -> tuple[dict, float]:
    body = {
        "text": case["text"],
        "history": [{"query": h.get("query", ""), "intent": h.get("intent"),
                     "measures": h.get("measures", [])} for h in case.get("history", [])],
        "plan": AREA if case.get("plan") == "area" else PLAIN,
    }
    req = urllib.request.Request(
        f"{base}/api/analyze/followup", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    # The endpoint shares the search rate limiter (burst 30, 60/min), and a
    # 60-call suite exceeds the burst. A 429 is waited out and retried rather
    # than scored: the first run of this probe scored nine cases 0/3 on
    # "too many requests" and said nothing about the rewrite at all.
    for _ in range(10):
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read()), time.time() - t0
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(float(e.headers.get("Retry-After") or 2) + 0.5)
                continue
            return {"error": f"HTTP {e.code}: {e.read()[:200]!r}"}, time.time() - t0
    return {"error": "still rate limited after 10 retries"}, 0.0


def score(case: dict, out: dict) -> tuple[bool, list[str]]:
    problems = []
    if out.get("error"):
        return False, [out["error"]]
    if out.get("kind") != case["kind"]:
        problems.append(f"kind {out.get('kind')!r}, expected {case['kind']!r}")
    if case["kind"] == "edit" and out.get("kind") == "edit":
        for k, v in (case.get("edit") or {}).items():
            got = out["edit"].get(k)
            if isinstance(v, list) and isinstance(got, list):
                if sorted(v) != sorted(got):
                    problems.append(f"edit.{k} {got!r}, expected {v!r}")
            elif got != v:
                problems.append(f"edit.{k} {got!r}, expected {v!r}")
    if case["kind"] == "question" and out.get("kind") == "question":
        q = f" {out.get('question', '').lower()} "
        for group in case.get("must", []):
            if not any(str(alt).lower() in q for alt in group):
                problems.append(f"missing any of {group}")
        for bad in case.get("must_not", []):
            if str(bad).lower() in q:
                problems.append(f"contains {bad!r}")
    return not problems, problems


def run(base: str, cases: list[dict], repeat: int, timeout: int) -> dict:
    rows = []
    for case in cases:
        runs = []
        for _ in range(repeat):
            out, secs = call(base, case, timeout)
            ok, problems = score(case, out)
            runs.append({"ok": ok, "problems": problems, "secs": round(secs, 2),
                         "kind": out.get("kind"), "edit": out.get("edit"),
                         "question": out.get("question"), "rewritten": out.get("rewritten")})
        passes = sum(r["ok"] for r in runs)
        stable = len({json.dumps([r["kind"], r["edit"], r["question"]]) for r in runs}) == 1
        rows.append({"id": case["id"], "kind": case["kind"], "heldout": bool(case.get("heldout")),
                     "passes": passes, "of": repeat,
                     "stable": stable, "runs": runs})
        last = runs[-1]
        shown = last["question"] if last["kind"] == "question" else json.dumps(last["edit"])
        mark = "ok  " if passes == repeat else ("FLAKY" if passes else "FAIL")
        print(f"  {mark} {case['id']:<26} {passes}/{repeat}  {shown}")
        for p in ([] if passes == repeat else last["problems"]):
            print(f"         - {p}")

    def rate(rs):
        n = sum(r["of"] for r in rs)
        return round(100 * sum(r["passes"] for r in rs) / n, 1) if n else None

    edits = [r for r in rows if r["kind"] == "edit"]
    questions = [r for r in rows if r["kind"] == "question"]
    q_secs = [x["secs"] for r in questions for x in r["runs"]]
    e_secs = [x["secs"] for r in edits for x in r["runs"]]
    summary = {
        "cases": len(rows), "repeat": repeat,
        "overall_pct": rate(rows),
        "edit_pct": rate(edits),
        "question_pct": rate(questions),
        # Cases written after the prompt was revised and before it was measured.
        "heldout_pct": rate([r for r in rows if r["heldout"]]),
        "tuned_pct": rate([r for r in rows if not r["heldout"]]),
        # How often a QUESTION was taken as an edit: the failure that silently
        # applies a filter nobody asked for.
        "false_edit_pct": round(100 * sum(1 for r in questions for x in r["runs"] if x["kind"] == "edit")
                                / max(1, len(questions) * repeat), 1),
        "unstable_cases": [r["id"] for r in rows if not r["stable"]],
        "p50_question_s": round(statistics.median(q_secs), 2) if q_secs else None,
        "p50_edit_s": round(statistics.median(e_secs), 3) if e_secs else None,
    }
    return {"summary": summary, "rows": rows}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--suite-file", type=Path, default=SUITE)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--save", type=Path)
    ap.add_argument("--compare", type=Path)
    args = ap.parse_args()

    cases = yaml.safe_load(args.suite_file.read_text(encoding="utf-8"))["cases"]
    print(f"{len(cases)} cases x {args.repeat} against {args.base}\n")
    result = run(args.base, cases, args.repeat, args.timeout)
    s = result["summary"]
    print(f"\noverall {s['overall_pct']}%   edits {s['edit_pct']}%   questions {s['question_pct']}%   "
          f"false edits {s['false_edit_pct']}%")
    print(f"held-out {s['heldout_pct']}%   tuned {s['tuned_pct']}%")
    print(f"p50 latency: question {s['p50_question_s']}s, edit {s['p50_edit_s']}s   "
          f"unstable: {s['unstable_cases'] or 'none'}")

    if args.compare:
        before = json.loads(args.compare.read_text(encoding="utf-8"))["summary"]
        for k in ("overall_pct", "edit_pct", "question_pct", "false_edit_pct", "tuned_pct", "heldout_pct"):
            print(f"  {k:<16} {before.get(k)} -> {s[k]}")
    if args.save:
        args.save.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"saved {args.save}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
