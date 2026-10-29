#!/usr/bin/env python3
"""
Tests for etl/load_table.py: the decisions a wrong guess would turn into
numbers on the wrong places.

    docker compose --profile etl run --rm --entrypoint python3 etl-geo \
        /app/etl/test_load_table.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import load_table as lt  # noqa: E402


class FakeConn:
    """Answers the two membership queries decide_level makes."""

    def __init__(self, counties, zctas):
        self.counties, self.zctas = counties, zctas

    def cursor(self):
        conn = self

        class Cur:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def execute(self, sql, params=None):
                self.rows = [(c,) for c in (conn.counties if "county_geom" in sql
                                            else conn.zctas)]

            def fetchall(self):
                return self.rows
        return Cur()


COUNTIES = {f"{s:02d}{c:03d}" for s in range(1, 57) for c in range(1, 200, 2)}
ZCTAS = {f"{z:05d}" for z in range(1000, 99999, 3)}


class LevelTests(unittest.TestCase):
    def test_lengths(self):
        for width, level in ((2, "state"), (7, "place"), (11, "tract"), (12, "bg"), (15, "block")):
            self.assertEqual(lt.decide_level({}, "GEOID", [], width, None)[0], level)

    def test_sidecar_wins(self):
        self.assertEqual(lt.decide_level({"level": "zcta"}, "FIPS", [], 5, None),
                         ("zcta", "sidecar"))

    def test_five_digits_by_column_name(self):
        self.assertEqual(lt.decide_level({}, "ZCTA5", [], 5, None)[0], "zcta")
        self.assertEqual(lt.decide_level({}, "zip_code", [], 5, None)[0], "zcta")
        self.assertEqual(lt.decide_level({}, "STCOFIPS", [], 5, None)[0], "county")

    def test_five_digits_by_membership(self):
        conn = FakeConn(COUNTIES, ZCTAS)
        county_codes = sorted(COUNTIES)[:3000]
        self.assertEqual(lt.decide_level({}, "GEOID", county_codes, 5, conn)[0], "county")
        zcta_codes = sorted(ZCTAS - COUNTIES)[:3000]
        self.assertEqual(lt.decide_level({}, "GEOID", zcta_codes, 5, conn)[0], "zcta")

    def test_five_digits_ambiguous_is_refused(self):
        both = sorted(COUNTIES & ZCTAS)
        conn = FakeConn(COUNTIES, ZCTAS)
        with self.assertRaises(SystemExit):
            lt.decide_level({}, "GEOID", both, 5, conn)

    def test_unknown_width_refused(self):
        with self.assertRaises(SystemExit):
            lt.decide_level({}, "GEOID", [], 9, None)


class CodeTests(unittest.TestCase):
    def test_stripped_leading_zero_is_restored(self):
        codes, width = lt.normalise_codes(["1001", "01003", "56045", "6037"])
        self.assertEqual(width, 5)
        self.assertEqual(codes, ["01001", "01003", "56045", "06037"])

    def test_two_short_is_not_padded(self):
        codes, width = lt.normalise_codes(["01001020100", "010010201"])
        self.assertEqual(codes[1], "010010201")

    def test_census_geo_id(self):
        self.assertEqual(lt.clean_geoid("1400000US29077000100"), "29077000100")
        self.assertEqual(lt.clean_geoid("8600000US65804"), "65804")

    def test_sentinels_are_missing(self):
        miss = lt.SENTINELS
        self.assertIsNone(lt.to_float("-999", miss))
        self.assertIsNone(lt.to_float("-666666666", miss))
        self.assertEqual(lt.to_float("-12.5", miss), -12.5)
        self.assertEqual(lt.to_float("1,234", miss), 1234.0)
        self.assertIsNone(lt.to_float("(X)", miss))

    def test_code_for_and_rewrite(self):
        self.assertEqual(lt.code_for({"id": "svi"}, "EP_POV150"), "SVI_EP_POV150")
        meta = {"id": "places", "code_rewrite": [["^(.*)_CrudePrev$", r"PLACES_\1_CrdPrv"]]}
        self.assertEqual(lt.code_for(meta, "DIABETES_CrudePrev"), "PLACES_DIABETES_CrdPrv")
        self.assertEqual(lt.code_for(meta, "TotalPopulation"), "PLACES_TOTALPOPULATION")


class ColumnTests(unittest.TestCase):
    def test_ids_and_text_are_not_measures(self):
        header = ["ST", "STCNTY", "FIPS", "LOCATION", "E_TOTPOP", "EP_POV150", "CI"]
        rows = [["01", "01001", "01001020100", "Tract 1", "1865", "-999", "( 6.2, 8.1)"],
                ["01", "01001", "01001020200", "Tract 2", "2010", "15.1", "( 1.0, 2.0)"]]
        keep, text = lt.measure_columns(header, rows, 2, {}, lt.SENTINELS)
        self.assertEqual([header[i] for i in keep], ["E_TOTPOP", "EP_POV150"])
        self.assertIn("CI", text)


class ReadTests(unittest.TestCase):
    def test_census_api_json(self):
        p = Path(tempfile.mkdtemp()) / "acs.json"
        p.write_text(json.dumps([["NAME", "B01003_001E", "zip code tabulation area"],
                                 ["ZCTA5 65804", "34000", "65804"]]))
        self.assertTrue(lt.is_census_json(p))
        header, rows = lt.read_rows(p)
        self.assertEqual(header[1], "B01003_001E")
        self.assertEqual(rows[0][2], "65804")

    def test_tsv(self):
        p = Path(tempfile.mkdtemp()) / "x.tsv"
        p.write_text("GEOID\tVAL\n29077\t1.5\n")
        header, rows = lt.read_rows(p)
        self.assertEqual(header, ["GEOID", "VAL"])
        self.assertEqual(rows, [["29077", "1.5"]])


if __name__ == "__main__":
    unittest.main(verbosity=1)
