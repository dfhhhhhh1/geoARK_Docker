#!/usr/bin/env python3
"""
Collect a portable results bundle from a running stack.

Solves the "I ran it on the other machine, now what?" problem: everything needed
to judge a configuration lands in ONE directory you can commit, zip, or paste
back: the numbers, and the environment that produced them.

Recording the environment is the point. A number without the model, hardware,
and coverage that produced it cannot be compared against anything.

    python3 eval/collect.py --label rtx4080-qwen14b
    python3 eval/collect.py --label rtx4080-qwen14b --quick   # skip planner suite

Then:
    python3 eval/collect.py --compare results/laptop-gemma4b results/rtx4080-qwen14b
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUN = Path(__file__).resolve().parent / "run.py"

_C = sys.stdout.isatty()
GRN, RED, YEL, DIM, BOLD, OFF = (
    ("\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m", "\033[0m") if _C else ("",) * 6)


def get_json(url: str, timeout: int = 30):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception as exc:
        return {"error": str(exc)}


def sh(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception:
        return ""


def environment(base: str) -> dict:
    """Everything needed to interpret the numbers, and to reproduce them."""
    health = get_json(f"{base}/api/health")
    env = {
        "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": __import__("os").cpu_count(),
        },
        "api_health": health,
        "git_commit": sh(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"]),
        "git_branch": sh(["git", "-C", str(ROOT), "rev-parse", "--abbrev-ref", "HEAD"]),
        "git_dirty": bool(sh(["git", "-C", str(ROOT), "status", "--porcelain"])),
    }

    # GPU presence changes both speed and the embedding vector space.
    nvidia = sh(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])
    env["gpu"] = nvidia or None

    # Which models are actually resident, not just configured.
    env["ollama_models"] = sh(["docker", "compose", "-f", str(ROOT / "deploy" / "docker-compose.yml"),
                               "exec", "-T", "ollama", "ollama", "list"]) or None

    # The embedder's provenance: model, torch build, device, canary fingerprint.
    env["embedder_provenance"] = json.loads(sh([
        "docker", "compose", "-f", str(ROOT / "deploy" / "docker-compose.yml"),
        "exec", "-T", "embedder", "python", "-c",
        "import urllib.request,json;print(json.dumps(json.load("
        "urllib.request.urlopen('http://localhost:8000/provenance'))))"]) or "null")
    return env


def run_suite(args: list[str], out: Path) -> dict | None:
    cmd = [sys.executable, str(RUN), "--skip-validate", "--save", str(out)] + args
    print(f"  {DIM}$ {' '.join(cmd[1:])}{OFF}")
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if not out.exists():
        print(f"  {RED}FAILED{OFF} ({time.time()-started:.0f}s)")
        print("  " + (proc.stderr or proc.stdout)[-400:].replace("\n", "\n  "))
        return None
    print(f"  {GRN}ok{OFF} ({time.time()-started:.0f}s)")
    return json.loads(out.read_text())


# --------------------------------------------------------------------------- #
# Phase 4 readiness
# --------------------------------------------------------------------------- #
#
# Stated as thresholds so "is it ready?" has an answer rather than an opinion.
# The reasoning behind each is in docs/ROADMAP.md; the short version is that
# Phase 4 builds UI on top of the planner, and polishing the presentation of
# plans that are wrong a third of the time inverts the order of work.

GATES = [
    ("retrieval.concept_recall", 0.95, "concept recall", "retrieval finds what a query needs"),
    ("known_item.recall_1", 0.80, "known-item recall@1", "the RIGHT attribute ranks first"),
    ("planner.plan_validity", 0.85, "plan validity", "a valid plan comes out"),
    ("planner.execution_success", 0.85, "execution success", "the plan runs"),
    ("planner.non_empty_rate", 0.80, "non-empty results", "it returns rows"),
]


def dig(bundle: dict, dotted: str):
    cur = bundle
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def assess(bundle: dict) -> tuple[bool, list]:
    rows, ready = [], True
    for key, threshold, label, why in GATES:
        val = dig(bundle["results"], key)
        if val is None:
            rows.append((label, None, threshold, "not measured", why))
            ready = False
            continue
        ok = val >= threshold
        ready = ready and ok
        rows.append((label, val, threshold, "pass" if ok else "BELOW", why))
    return ready, rows


def print_assessment(bundle: dict) -> None:
    ready, rows = assess(bundle)
    print(f"\n{BOLD}{'=' * 68}{OFF}")
    print(f"{BOLD}  Phase 4 readiness{OFF}")
    print(f"{BOLD}{'=' * 68}{OFF}")
    for label, val, thr, status, why in rows:
        shown = "     -" if val is None else f"{val:6.1%}"
        color = GRN if status == "pass" else (YEL if status == "not measured" else RED)
        print(f"  {color}{status:12s}{OFF} {label:22s} {shown}  (need {thr:.0%})")
        print(f"  {DIM}{'':12s} {why}{OFF}")
    verdict = (f"{GRN}READY{OFF}: the planner is reliable enough that UI work on top of it pays off"
               if ready else
               f"{YEL}NOT YET{OFF}, raise the failing metric before building UI on top of it")
    print(f"\n  verdict: {verdict}")


def compare(a: Path, b: Path) -> None:
    ba, bb = (json.loads((p / "bundle.json").read_text()) for p in (a, b))
    print(f"\n{BOLD}{ba['label']}  ->  {bb['label']}{OFF}\n")
    for key, _thr, label, _why in GATES:
        va, vb = dig(ba["results"], key), dig(bb["results"], key)
        if va is None or vb is None:
            print(f"  {label:22s} {DIM}not comparable{OFF}")
            continue
        d = vb - va
        color = GRN if d > 0.001 else (RED if d < -0.001 else DIM)
        print(f"  {label:22s} {va:6.1%} -> {vb:6.1%}   {color}{d:+.1%}{OFF}")
    for label, path in (("planner latency p50", "planner.latency_p50"),
                        ("retrieval latency p50", "retrieval.latency_p50")):
        va, vb = dig(ba["results"], path), dig(bb["results"], path)
        if va and vb:
            color = GRN if vb < va else RED
            print(f"  {label:22s} {va:6.2f}s -> {vb:6.2f}s   {color}{vb-va:+.2f}s{OFF}")
    print(f"\n{DIM}  A: {ba['environment'].get('gpu') or 'no GPU'} | "
          f"plan_model={dig(ba, 'environment.api_health.plan_model')}{OFF}")
    print(f"{DIM}  B: {bb['environment'].get('gpu') or 'no GPU'} | "
          f"plan_model={dig(bb, 'environment.api_health.plan_model')}{OFF}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", help="name for this configuration, e.g. rtx4080-qwen14b")
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "results")
    ap.add_argument("--quick", action="store_true",
                    help="skip the planner suite (which is the slow one)")
    ap.add_argument("--compare", nargs=2, type=Path, metavar=("A", "B"))
    args = ap.parse_args()

    if args.compare:
        compare(*args.compare)
        return 0
    if not args.label:
        ap.error("--label is required (or use --compare A B)")

    d = args.out / args.label
    d.mkdir(parents=True, exist_ok=True)
    print(f"{BOLD}collecting into {d}{OFF}\n")

    env = environment(args.base)
    if "error" in env["api_health"]:
        print(f"{RED}cannot reach {args.base}: {env['api_health']['error']}{OFF}")
        return 2
    print(f"  api ok, {env['api_health'].get('resolvable_attributes')} resolvable attributes, "
          f"plan_model={env['api_health'].get('plan_model')}")
    if env.get("gpu"):
        print(f"  gpu: {env['gpu']}")

    results = {}
    print(f"\n{BOLD}retrieval (concept suite){OFF}")
    r = run_suite(["--base", args.base], d / "retrieval.json")
    if r:
        results["retrieval"] = {k: r[k] for k in
                                ("concept_recall", "query_success", "mrr",
                                 "latency_p50", "latency_p95") if k in r}
        results["retrieval"]["per_suite"] = r.get("per_suite")

    print(f"\n{BOLD}known-item (ranking-sensitive){OFF}")
    r = run_suite(["--base", args.base, "--suite-file",
                   str(Path(__file__).resolve().parent / "known_item.yaml")],
                  d / "known_item.json")
    if r:
        results["known_item"] = r.get("known_item")
        results["absent"] = r.get("absent")

    if not args.quick:
        print(f"\n{BOLD}planner (slow: one LLM call per query){OFF}")
        r = run_suite(["--base", args.base, "--endpoint", "analyze",
                       "--suite", "multi_concept"], d / "planner.json")
        if r:
            results["planner"] = {k: r[k] for k in
                                  ("plan_validity", "execution_success", "non_empty_rate",
                                   "mean_repairs", "latency_p50") if k in r}

    bundle = {"label": args.label, "environment": env, "results": results}
    (d / "bundle.json").write_text(json.dumps(bundle, indent=2))

    print_assessment(bundle)
    print(f"\n  bundle -> {d / 'bundle.json'}")
    print(f"{DIM}  Commit the directory, or send bundle.json back. Compare with:\n"
          f"    python3 eval/collect.py --compare eval/results/<other> {d}{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
