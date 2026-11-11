"""ERS variable descriptions (etl/ers_variables.yaml, load_county_values.py).

Run: python etl/test_ers_variables.py
"""

import csv
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import load_county_values as lcv  # noqa: E402

HEADER = ["dataset_id", "dataset_clean", "attr_label", "attr_orig", "attr_desc",
          "attr_id", "tags"]


def write(path: Path, rows):
    with path.open("w", encoding="utf-8", newline="") as fh:
        csv.writer(fh, lineterminator="\r\n").writerows([HEADER, *rows])


def test_dictionary_says_count_or_percent():
    ers = lcv.ers_descriptions()
    assert "poverty" in ers["PCTPOVALL"].lower() and "percent" in ers["PCTPOVALL"].lower()
    assert "number" in ers["POVALL"].lower()
    # population.js recognises a whole-population count by this prefix.
    assert ers["POP_ESTIMATE"].startswith("Total population (")
    # The search server demotes margins of error by this phrase; a bound
    # that does not carry it competes with its own estimate.
    assert all("margin of error" in d for c, d in ers.items() if c.startswith("CI90"))


def test_only_ers_rows_change_and_rerun_is_a_no_op():
    with tempfile.TemporaryDirectory() as tmp:
        cat = Path(tmp) / "cat.csv"
        rows = [
            ["USDA_ERS_01_01", "USDA ERS", "PCTPOVALL", "PCTPOVALL", "PCTPOVALL", "PCTPOVALL", "['pctpovall']"],
            ["USDA_ERS_01_01", "USDA ERS", "POVALL", "POVALL", "POVALL (covers 2,900 counties)", "POVALL", "[]"],
            # Same code, different source: never relabelled.
            ["X_01_01", "Other", "PCTPOVALL", "PCTPOVALL", "PCTPOVALL", "x", "[]"],
            ["USDA_ERS_01_01", "USDA ERS", "NOT_IN_DICT", "NOT_IN_DICT", "NOT_IN_DICT", "n", "[]"],
        ]
        write(cat, rows)
        ers = lcv.ers_descriptions()
        assert lcv.refresh_catalog(cat, ers) == 2
        got = list(csv.reader(cat.open(encoding="utf-8", newline="")))[1:]
        assert got[0][4] == ers["PCTPOVALL"] and "poverty" in got[0][6]
        assert got[0][3] == "PCTPOVALL", "attr_orig keeps the code, so it stays searchable"
        assert got[1][4].endswith("(covers 2,900 counties)"), "coverage note kept"
        assert got[2][4] == "PCTPOVALL" and got[3][4] == "NOT_IN_DICT"
        before = cat.read_bytes()
        assert lcv.refresh_catalog(cat, ers) == 0
        assert cat.read_bytes() == before
        assert b"\r\n" in before and b"\n\n" not in before.replace(b"\r\n", b"")


def test_new_rows_use_the_dictionary():
    ers = {"PCTPOVALL": "Percent of people of all ages in poverty"}
    assert lcv.describe("PCTPOVALL", {"dataset": "USDA ERS", "label": "PCTPOVALL"}, ers) == ers["PCTPOVALL"]
    assert lcv.describe("PCTPOVALL", {"dataset": "CDC PLACES", "label": "x"}, ers) == "x"
    assert "the" not in lcv.tags_for("Percent of the civilian labor force")


if __name__ == "__main__":
    fns = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok   {fn.__name__}")
    print(f"\n{len(fns)}/{len(fns)} passed")
