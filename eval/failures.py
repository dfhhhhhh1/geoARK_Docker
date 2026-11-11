#!/usr/bin/env python3
"""Summarise logs/failures.jsonl, the queries that did not answer.

    python eval/failures.py                    # overview of everything
    python eval/failures.py --class failure    # only real failures (not refusals)
    python eval/failures.py --kind planner_failed --since 2026-11-10
    python eval/failures.py --show 3fa91c0b2e  # one entry in full
    python eval/failures.py --list 20          # newest 20, one line each

The log is written by backend/failure_log.js. Classes: failure (fix code or
model), refusal (data cannot answer it; fix coverage, or it is correct), empty
(ran, no rows), workflow (a multi-step question stopped).
"""
import argparse
import collections
import json
import pathlib
import sys

DEFAULT = pathlib.Path(__file__).resolve().parent.parent / "logs" / "failures.jsonl"


def load(path):
    rows = []
    # The rotated file holds older entries; read it first so order is oldest-first.
    for p in (path.with_name(path.name + ".1"), path):
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def gpu_trouble(e):
    """True when ollama was not fully on the GPU at the time (the CPU/VRAM traps)."""
    o = e.get("ollama")
    if not isinstance(o, list):
        return False
    return any((m.get("gpu_pct") or 0) < 100 for m in o)


def one_line(e):
    return (f"{e['ts'][:19]}  {e['id']}  {e['kind']:<18} {e.get('stage_reached') or '-':<14} "
            f"{e.get('ms', 0) / 1000:5.1f}s  {e['query'][:70]}")


def show(e):
    print(json.dumps(e, indent=2, ensure_ascii=False))


def overview(rows):
    n = len(rows)
    print(f"{n} logged runs, {rows[0]['ts'][:10]} to {rows[-1]['ts'][:10]}\n")

    def table(title, counter, top=10):
        print(title)
        for k, v in counter.most_common(top):
            print(f"  {v:4d}  {k}")
        print()

    table("By class", collections.Counter(e["class"] for e in rows))
    table("By kind", collections.Counter(e["kind"] for e in rows))
    table("Stopped at stage", collections.Counter(e.get("stage_reached") or "-" for e in rows))

    # The same validator message across many queries is one bug, not many.
    msgs = collections.Counter()
    for e in rows:
        for m in set(e.get("validation_errors") or []):
            msgs[m[:110]] += 1
    table("Most common validation / relevance errors", msgs)

    # A question that fails every time is a better target than one that failed once.
    q = collections.Counter(e["query"].strip().lower() for e in rows)
    repeat = collections.Counter({k: v for k, v in q.items() if v > 1})
    if repeat:
        table("Repeat offenders (same question, several failures)", repeat)

    # Datasets retrieval offered when the planner still failed point at catalog gaps.
    top1 = collections.Counter(
        (e["candidates"][0]["desc"] or "")[:70] for e in rows if e.get("candidates"))
    table("Top candidate shown when it failed", top1, 8)

    flags = collections.Counter(
        f"{k}={v}" for e in rows for k, v in (e.get("flags") or {}).items()
        if k in ("plan_model", "plan_think", "expand", "rerank", "coverage", "relevance_check"))
    if flags:
        table("Request flags in play", flags, 8)

    models = collections.Counter(
        f"{(e.get('env') or {}).get('plan_model')} think={(e.get('env') or {}).get('plan_think')}"
        for e in rows)
    table("Planner configuration", models, 5)

    stale = sum(1 for e in rows if (e.get("env") or {}).get("corpus_stale"))
    gpu = sum(1 for e in rows if gpu_trouble(e))
    slow = sum(1 for e in rows if (e.get("ms") or 0) > 90_000)
    print("Environmental suspects")
    print(f"  {stale:4d}  ran with a stale corpus (corpus_stale), results unreliable")
    print(f"  {gpu:4d}  ollama not 100% on GPU at the time (see CLAUDE.md: GPU / VRAM traps)")
    print(f"  {slow:4d}  took over 90 s (planner timeout territory)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", type=pathlib.Path, default=DEFAULT)
    ap.add_argument("--class", dest="cls", choices=["failure", "refusal", "empty", "workflow"])
    ap.add_argument("--kind")
    ap.add_argument("--since", help="ISO date, e.g. 2026-11-10")
    ap.add_argument("--q", help="substring of the question")
    ap.add_argument("--show", metavar="ID", help="print one entry in full")
    ap.add_argument("--list", type=int, metavar="N", help="newest N, one line each")
    a = ap.parse_args()

    rows = load(a.file)
    if not rows:
        print(f"no entries in {a.file}", file=sys.stderr)
        return 0
    if a.show:
        hit = [e for e in rows if e["id"].startswith(a.show)]
        if not hit:
            print(f"no entry {a.show}", file=sys.stderr)
            return 1
        show(hit[-1])
        return 0
    if a.cls:
        rows = [e for e in rows if e["class"] == a.cls]
    if a.kind:
        rows = [e for e in rows if e["kind"] == a.kind]
    if a.since:
        rows = [e for e in rows if e["ts"] >= a.since]
    if a.q:
        rows = [e for e in rows if a.q.lower() in e["query"].lower()]
    if not rows:
        print("nothing matches", file=sys.stderr)
        return 0
    if a.list:
        for e in reversed(rows[-a.list:]):
            print(one_line(e))
        return 0
    overview(rows)
    print("\nNewest 10:")
    for e in reversed(rows[-10:]):
        print("  " + one_line(e))
    print("\nFull entry: python eval/failures.py --show <id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
