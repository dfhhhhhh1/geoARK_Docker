"""Shape checks for published definitions (etl/definitions.py).

Fit to the DATA is tested in backend/planner/test_conditions.js; this covers
what the loader refuses before anything reaches the database.
Run: python etl/test_definitions.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import definitions as d  # noqa: E402

GOOD = {"id": "x_rule", "term": "t", "measures": ["M"], "vintages": [2013, 2023],
        "scale": "code", "rule": ">= 4", "source": "s"}


def test_registry_file_is_clean():
    entries, errs = d.collect(d.REGISTRY, Path("/nonexistent"))
    assert not errs, errs
    assert entries, "etl/definitions.yaml is empty"
    # Every entry is pinned to the vintages it was published for.
    assert all(len(e["vintages"]) == 2 for e in entries)


def test_vintages_are_required():
    bad = {k: v for k, v in GOOD.items() if k != "vintages"}
    assert any("vintages" in e for e in d.check(bad, "t"))


def test_rule_and_scale_are_checked():
    assert any("rule" in e for e in d.check({**GOOD, "rule": "big"}, "t"))
    assert any("scale" in e for e in d.check({**GOOD, "scale": "pct"}, "t"))
    assert d.parse_rule("<= 0.5") == ("<=", 0.5)
    assert d.check(GOOD, "t") == []


def test_sidecar_definitions_get_the_measure_code_and_vintage():
    meta = {"start_year": 2022, "end_year": 2022, "originator": "CDC",
            "columns": {"RPL": {"definitions": [
                {"term": "high", "rule": ">= 0.75", "scale": "fraction"}]}}}
    out, errs = d.from_sidecar(meta, lambda c: "SVI_" + c, {"SVI_RPL"})
    assert errs == [], errs
    assert out[0]["measures"] == ["SVI_RPL"] and out[0]["vintages"] == [2022, 2022]
    assert out[0]["source"] == "CDC"


def test_a_definition_on_a_column_that_was_not_loaded_is_reported():
    meta = {"start_year": 2020, "columns": {"Z": {"definitions": [GOOD]}}}
    _, errs = d.from_sidecar(meta, lambda c: "Q_" + c, set())
    assert any("not loaded" in e for e in errs)


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"  ok   {name}")
            except AssertionError as e:
                fails += 1
                print(f"  FAIL {name}: {e}")
    sys.exit(1 if fails else 0)
