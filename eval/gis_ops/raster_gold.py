#!/usr/bin/env python3
"""
Gold for the raster family of eval/gis_ops.yaml (GIS_OPS_PLAN.md H4), computed
from the SOURCE GeoTIFFs with GDAL, not from PostGIS.

The op under test clips PostGIS raster tiles with ST_Clip. A gold written with
PostGIS raster functions would share its loader and much of its machinery,
and pixel-centroid SQL took over ten minutes per question. This reads the
files ingest read (deploy/incoming), rasterizes each unit polygon with
gdal.RasterizeLayer (pixel-centre rule, GDAL's default, as ST_Clip's), and
counts with numpy. It catches a loader defect as well as an op defect.

Writes eval_raster_gold(qid, geoid, value); the YAML gold reads that table.
Run in the etl-geo container (GDAL + psycopg2):

  docker compose --profile etl run --rm --entrypoint python3 etl-geo \
      /app/eval/gis_ops/raster_gold.py
"""

from __future__ import annotations

import sys

import numpy as np
import psycopg2
from osgeo import gdal, ogr, osr

sys.path.insert(0, "/app/etl")
import ingest  # noqa: E402

gdal.UseExceptions()
INC = "/incoming"
NLCD = {2001: f"{INC}/nlcd2001/nlcd_2001_mo_il.tif", 2021: f"{INC}/nlcd2021/nlcd_2021_mo_il.tif"}
DEM = f"{INC}/dem3dep/dem_10m_fixture.tif"
SLOPE = f"{INC}/slope3dep/slope_pct_10m_fixture.tif"
ACRE = 4046.8564224


def units(cur, sql):
    cur.execute(sql)
    return cur.fetchall()            # (geoid, wkt in 4326)


def values_in(path: str, wkt: str) -> np.ndarray:
    """Valid pixel values whose centre lies in the polygon (EPSG:4326 WKT)."""
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    nd = band.GetNoDataValue()
    gt = ds.GetGeoTransform()
    dst = osr.SpatialReference(wkt=ds.GetProjection())
    src = osr.SpatialReference()
    src.ImportFromEPSG(4326)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    g = ogr.CreateGeometryFromWkt(wkt)
    g.Transform(osr.CoordinateTransformation(src, dst))
    x0, x1, y0, y1 = g.GetEnvelope()
    c0 = max(0, int((x0 - gt[0]) / gt[1]) - 1)
    c1 = min(ds.RasterXSize, int((x1 - gt[0]) / gt[1]) + 2)
    r0 = max(0, int((y1 - gt[3]) / gt[5]) - 1)
    r1 = min(ds.RasterYSize, int((y0 - gt[3]) / gt[5]) + 2)
    if c1 <= c0 or r1 <= r0:
        return np.array([])
    w, h = c1 - c0, r1 - r0
    mem = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Byte)
    mem.SetGeoTransform((gt[0] + c0 * gt[1], gt[1], 0, gt[3] + r0 * gt[5], 0, gt[5]))
    mem.SetProjection(ds.GetProjection())
    vds = ogr.GetDriverByName("Memory").CreateDataSource("")
    lyr = vds.CreateLayer("u", dst, ogr.wkbMultiPolygon)
    f = ogr.Feature(lyr.GetLayerDefn())
    f.SetGeometry(g)
    lyr.CreateFeature(f)
    gdal.RasterizeLayer(mem, [1], lyr, burn_values=[1])   # pixel centre (ALL_TOUCHED off)
    mask = mem.GetRasterBand(1).ReadAsArray() == 1
    a = band.ReadAsArray(c0, r0, w, h)
    ok = mask & (a != nd) if nd is not None else mask
    if np.issubdtype(a.dtype, np.floating):
        ok &= np.isfinite(a)
    return a[ok]


def pixel_at(path: str, x: float, y: float) -> np.ndarray:
    """The one valid pixel holding (x, y) in the raster's CRS, or empty."""
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()
    c, r = int((x - gt[0]) / gt[1]), int((y - gt[3]) / gt[5])
    if not (0 <= c < ds.RasterXSize and 0 <= r < ds.RasterYSize):
        return np.array([])
    a = band.ReadAsArray(c, r, 1, 1).ravel()
    nd = band.GetNoDataValue()
    return a[a != nd] if nd is not None else a


def main() -> int:
    conn = psycopg2.connect(ingest.pg_dsn())
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS eval_raster_gold (qid TEXT, geoid TEXT, value DOUBLE PRECISION, "
                "PRIMARY KEY (qid, geoid))")
    out: dict[str, dict[str, float]] = {}

    def put(qid, geoid, v):
        out.setdefault(qid, {})[geoid] = float(v)

    chi = units(cur, "SELECT geoid, ST_AsText(geom) FROM geo_unit WHERE level = 'z_chi_community_areas'")
    for gid, wkt in chi:
        for yr in (2001, 2021):
            v = values_in(NLCD[yr], wkt)
            put(f"chi-dev-share-{yr}", gid, 100.0 * np.isin(v, [21, 22, 23, 24]).sum() / v.size)
        v = values_in(NLCD[2021], wkt)
        put("chi-dev24-share-2021", gid, 100.0 * (v == 24).sum() / v.size)

    wards = units(cur, "SELECT geoid, ST_AsText(geom) FROM geo_unit WHERE level = 'z_stl_wards'")
    for gid, wkt in wards:
        e = values_in(DEM, wkt)
        s = values_in(SLOPE, wkt)
        put("stl-ward-elev-mean", gid, e.mean())
        put("stl-ward-slope-mean", gid, s.mean())
        put("stl-ward-flat-share", gid, 100.0 * (s < 5).sum() / s.size)
        put("stl-ward-steep-share", gid, 100.0 * (s >= 5).sum() / s.size)

    nb = units(cur, "SELECT geoid, ST_AsText(geom) FROM geo_unit WHERE level = 'z_stl_neighborhoods'")
    for gid, wkt in nb:
        put("stl-nbhd-slope-mean", gid, values_in(SLOPE, wkt).mean())
        put("stl-nbhd-elev-mean", gid, values_in(DEM, wkt).mean())

    mo = units(cur, "SELECT fips, ST_AsText(geom) FROM county_geom WHERE state_fp = '29'")
    for gid, wkt in mo:
        a01, a21 = values_in(NLCD[2001], wkt), values_in(NLCD[2021], wkt)
        c01, c21 = (a01 == 82).sum(), (a21 == 82).sum()
        put("mo-crop-change-acres", gid, (c21 - c01) * 900 / ACRE)
        put("mo-crop-change-pct", gid, 100.0 * (c21 - c01) / c01 if c01 else 0.0)
        p01, p21 = np.isin(a01, [81, 82]).sum(), np.isin(a21, [81, 82]).sum()
        put("mo-planted-change-acres", gid, (p21 - p01) * 900 / ACRE)

    cook = units(cur, "SELECT fips, ST_AsText(geom) FROM county_geom WHERE fips = '17031'")
    for gid, wkt in cook:
        for yr in (2001, 2021):
            v = values_in(NLCD[yr], wkt)
            put(f"cook-forest-share-{yr}", gid, 100.0 * np.isin(v, [41, 42, 43]).sum() / v.size)

    # ---- zonal over FEATURES (H4 remainder, family zonal_features). Each
    # feature is keyed as answer_probe keys a returned feature (first vertex,
    # 5 decimals). A polygon holding no pixel centre reads the pixel under
    # its interior point (the op's stated rule), looked up here with GDAL.
    campus = "table_3c5026522e6841d4ad3ed482c0fb1b30_collegeuniversitycampuse"
    fk = ("round(ST_X(ST_GeometryN(ST_Points(f.geom), 1))::numeric, 5) || ',' || "
          "round(ST_Y(ST_GeometryN(ST_Points(f.geom), 1))::numeric, 5)")
    pos = "ST_X(ST_PointOnSurface(ST_Transform(f.geom, 5070))), ST_Y(ST_PointOnSurface(ST_Transform(f.geom, 5070)))"

    def feats(table, where):
        cur.execute(f"SELECT {fk}, ST_AsText(f.geom), {pos}, ST_Area(ST_Transform(f.geom, 5070)) "
                    f"FROM {table} f WHERE {where}")
        return cur.fetchall()

    in_state = lambda st: (f"EXISTS (SELECT 1 FROM county_geom c WHERE c.geom && f.geom "
                           f"AND ST_Intersects(c.geom, f.geom) AND c.state_fp = '{st}')")
    in_city = lambda name, st: (f"EXISTS (SELECT 1 FROM place_geom p WHERE p.kind = 'place' AND p.state_fp = '{st}' "
                                f"AND lower(p.name) = '{name}' AND p.geom && f.geom AND ST_Intersects(p.geom, f.geom))")

    def fvals(path, wkt, x, y):
        v = values_in(path, wkt)
        return (v, False) if v.size else (pixel_at(path, x, y), True)

    small = 0
    for key, wkt, x, y, _a in feats(campus, in_state("29")):
        for yr in (2001, 2021):
            v, s = fvals(NLCD[yr], wkt, x, y)
            if v.size:
                put(f"zf-mo-campus-forest-{yr}", key, 100.0 * np.isin(v, [41, 42, 43]).sum() / v.size)
                if yr == 2021:
                    put("zf-mo-campus-developed-2021", key, 100.0 * np.isin(v, [21, 22, 23, 24]).sum() / v.size)
                    small += s
    for key, wkt, x, y, area in feats("epa_npl_sites", in_state("17")):
        v, s = fvals(NLCD[2021], wkt, x, y)
        if not v.size:
            continue
        dev = np.isin(v, [21, 22, 23, 24])
        acres = (dev.sum() * 900 if not s else (area if dev.all() else 0.0)) / ACRE
        put("zf-il-npl-developed-acres", key, acres)
        put("zf-il-npl-developed-sqmi", key, acres * ACRE / 2589988.110336)
        put("zf-il-npl-developed-share", key, 100.0 * dev.sum() / v.size)
    for key, wkt, x, y, _a in feats(campus, in_city("st. louis", "29")):
        v, _ = fvals(SLOPE, wkt, x, y)
        if v.size:
            put("zf-stl-campus-slope-mean", key, v.mean())
        e, _ = fvals(DEM, wkt, x, y)
        if e.size:
            put("zf-stl-campus-elev-mean", key, e.mean())
    for key, wkt, x, y, _a in feats("epa_npl_sites", in_city("chicago", "17")):
        e, _ = fvals(DEM, wkt, x, y)
        if e.size:
            put("zf-chi-npl-elev-mean", key, e.mean())
        s, _ = fvals(SLOPE, wkt, x, y)
        if s.size:
            put("zf-chi-npl-slope-mean", key, s.mean())
    for key, wkt, x, y, _a in feats(campus, in_state("17")):
        for yr in (2001, 2021):
            v, _ = fvals(NLCD[yr], wkt, x, y)
            if v.size:
                put(f"zf-il-campus-dev-share-{yr}", key, 100.0 * np.isin(v, [21, 22, 23, 24]).sum() / v.size)
    for key, wkt, x, y, _a in feats(campus, in_city("chicago", "17")):
        s, _ = fvals(SLOPE, wkt, x, y)
        if s.size:
            put("zf-chi-campus-flat-share", key, 100.0 * (s < 2).sum() / s.size)
            put("zf-chi-campus-steep-share", key, 100.0 * (s >= 2).sum() / s.size)
    print(f"  Missouri campuses read from one interior pixel (2021): {small}")

    cur.execute("DELETE FROM eval_raster_gold")
    for qid, rows in out.items():
        for gid, v in rows.items():
            cur.execute("INSERT INTO eval_raster_gold VALUES (%s, %s, %s)", (qid, gid, v))
        print(f"  {qid:<26} {len(rows):>4} units")
    return 0


if __name__ == "__main__":
    sys.exit(main())
