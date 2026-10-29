#!/usr/bin/env python3
"""
Tests for etl/load_raster.py that need no database: refusals, pyramid
factors, pyramid arithmetic, and the raster WKB header.

    docker compose --profile etl run --rm --entrypoint python3 etl-geo \
        /app/etl/test_load_raster.py

The database half (tiles readable by PostGIS, zonal sums, conservation) is
checked against the real load; see docs/DATA_LOADING_PLAN.md, Progress.
"""

from __future__ import annotations

import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

sys.path.insert(0, str(Path(__file__).parent))
import load_raster as lr  # noqa: E402

gdal.UseExceptions()
PX = 1 / 120   # 30 arc-seconds


def make_tif(arr: np.ndarray, epsg: int = 4326, nodata: float = -9.0) -> Path:
    p = Path(tempfile.mkdtemp()) / "t.tif"
    ds = gdal.GetDriverByName("GTiff").Create(str(p), arr.shape[1], arr.shape[0], 1,
                                              gdal.GDT_Float32)
    ds.SetGeoTransform((-90.0, PX, 0, 40.0, 0, -PX))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(epsg)
    ds.SetProjection(srs.ExportToWkt())
    b = ds.GetRasterBand(1)
    b.SetNoDataValue(nodata)
    b.WriteArray(arr)
    ds = None
    return p


class CheckTests(unittest.TestCase):
    def test_aggregate_is_required(self):
        info = lr.inspect(make_tif(np.ones((4, 4))))
        with self.assertRaises(SystemExit):
            lr.check(info, {})
        lr.check(info, {"aggregate": "sum"})

    def test_projected_raster_refused(self):
        info = lr.inspect(make_tif(np.ones((4, 4)), epsg=5070))
        with self.assertRaises(SystemExit):
            lr.check(info, {"aggregate": "sum"})

    def test_factors_from_pixel_height(self):
        info = lr.inspect(make_tif(np.ones((4, 4))))
        self.assertEqual(lr.factors(info), {"grid4k": 4, "grid16k": 16, "grid64k": 64})


class PyramidTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(7)
        self.arr = rng.uniform(0, 100, (200, 300)).astype(np.float32)
        self.arr[0:10, 0:10] = -9.0                     # nodata block
        self.path = make_tif(self.arr)
        self.info = lr.inspect(self.path)
        self.valid = np.where(self.arr == -9.0, 0, self.arr).astype(np.float64)

    def test_sum_levels_conserve_the_total(self):
        cells = lr.pyramid(self.path, self.info, "t", "sum")
        for level, cs in cells.items():
            self.assertAlmostEqual(sum(c[-1] for c in cs), self.valid.sum(), places=3, msg=level)

    def test_cell_is_its_pixels(self):
        cells = {c[0]: c for c in lr.pyramid(self.path, self.info, "t", "sum")["grid4k"]}
        g, x0, y0, x1, y1, v = cells["t:3:5"]
        self.assertAlmostEqual(v, self.valid[12:16, 20:24].sum(), places=3)
        self.assertAlmostEqual(x0, -90.0 + 20 * PX)
        self.assertAlmostEqual(y1, 40.0 - 12 * PX)     # top edge
        self.assertAlmostEqual(y0, 40.0 - 16 * PX)     # bottom edge

    def test_all_nodata_cell_is_absent(self):
        cells = {c[0] for c in lr.pyramid(self.path, self.info, "t", "sum")["grid4k"]}
        self.assertNotIn("t:0:0", cells)               # pixels 0-3 x 0-3 are all nodata
        self.assertIn("t:0:3", cells)

    def test_mean_ignores_nodata(self):
        arr = np.full((8, 8), 10.0, dtype=np.float32)
        arr[0:4, 0:2] = -9.0                           # half of one 4x4 cell is nodata
        arr[0:4, 2:4] = 30.0
        p = make_tif(arr)
        cells = {c[0]: c[-1] for c in lr.pyramid(p, lr.inspect(p), "t", "mean")["grid4k"]}
        self.assertAlmostEqual(cells["t:0:0"], 30.0)   # not diluted by the nodata half
        self.assertAlmostEqual(cells["t:0:1"], 10.0)


class WkbTests(unittest.TestCase):
    def test_header_and_band(self):
        arr = np.arange(6, dtype=np.float64).reshape(2, 3)
        wkb = lr.tile_wkb(arr, -90.0, 40.0, PX, -PX, -9.0)
        endian, version, nbands = struct.unpack_from("<BHH", wkb, 0)
        self.assertEqual((endian, version, nbands), (1, 0, 1))
        scale_x, scale_y, ulx, uly = struct.unpack_from("<dddd", wkb, 5)
        self.assertEqual((ulx, uly, scale_x), (-90.0, 40.0, PX))
        srid, w, h = struct.unpack_from("<iHH", wkb, 5 + 48)
        self.assertEqual((srid, w, h), (4326, 3, 2))
        flags, nodata = struct.unpack_from("<Bf", wkb, 61)
        self.assertEqual(flags, 0x40 | 10)             # has-nodata | 32BF
        self.assertEqual(nodata, -9.0)
        self.assertEqual(len(wkb), 61 + 5 + 6 * 4)


if __name__ == "__main__":
    unittest.main(verbosity=1)
