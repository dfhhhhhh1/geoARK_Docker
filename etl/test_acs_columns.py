"""load_acs declares only real ACS variables that carry values.

Run: python etl/test_acs_columns.py
"""

import csv
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:
    import psycopg2  # noqa: F401
except ImportError:  # the test never connects; the host may not have the driver
    import types
    sys.modules["psycopg2"] = types.ModuleType("psycopg2")
import load_reference_data as lrd  # noqa: E402

REAL_CSV = Path(__file__).resolve().parent.parent / "geospatial_database_data" / "fips_merged_ACS_data.csv"


class FakeCursor:
    def __init__(self):
        self.declared = []
        self.copied = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, *a):
        pass

    def executemany(self, sql, rows):
        if "acs_variables" in sql:
            self.declared = list(rows)

    def copy_from(self, buf, table, columns):
        self.copied += [ln for ln in buf.read().splitlines() if ln]


class FakeConn:
    def __init__(self):
        self.cur = FakeCursor()

    def cursor(self):
        return self.cur

    def commit(self):
        pass


def test_junk_headers_are_not_codes():
    for good in ("S2201_C01_001E", "DP02_0003E", "B01001_001E", "S0801_C02_054M", "DP04_0117PM"):
        assert lrd.is_acs_code(good), good
    for bad in ("GEO_ID", "NAME", "source_file", "FIPS", "Unnamed: 458_level_0", ""):
        assert not lrd.is_acs_code(bad), bad


def test_loader_skips_junk_and_all_suppressed_columns():
    header = ["FIPS", "GEO_ID", "NAME", "Unnamed: 5_level_0",
              "DP02_0001E|Estimate|Total households",
              "DP02_0001PM|Percent Margin of Error|Total households",
              "S2101_C01_003E|Estimate|Gulf War veterans",
              "source_file"]
    rows = [["01001", "0500000US01001", "Autauga", "x", "1,200", "(X)", "(X)", "a.csv"],
            ["01003", "0500000US01003", "Baldwin", "y", "3,400", "(X)", "", "a.csv"]]
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "acs.csv"
        with p.open("w", encoding="utf-8", newline="") as fh:
            csv.writer(fh).writerows([header, *rows])
        conn = FakeConn()
        n_declared, n_vals = lrd.load_acs(conn, p)
    assert [c for c, _, _ in conn.cur.declared] == ["DP02_0001E"]
    assert n_declared == 1 and n_vals == 2
    assert all(ln.split("\t")[1] == "DP02_0001E" for ln in conn.cur.copied)


def test_real_header_has_only_the_known_junk():
    if not REAL_CSV.exists():
        return
    with REAL_CSV.open(newline="", encoding="utf-8") as fh:
        header = next(csv.reader(fh))
    bad = [h.partition("|")[0].strip() for h in header
           if not lrd.is_acs_code(h.partition("|")[0].strip())]
    assert set(bad) == {"FIPS", "GEO_ID", "NAME", "source_file"} | {
        b for b in bad if b.startswith("Unnamed:")}, bad


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
