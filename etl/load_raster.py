#!/usr/bin/env python3
"""
Load a raster: keep it as a raster, and derive per-unit values and a grid
pyramid from it. Called by etl/ingest.py for `kind: raster`, and by replay.

Three things come out of one GeoTIFF (docs/DATA_LOADING_PLAN.md section 4):

  raster_<id>        the raster itself, tiled in PostGIS (only tiles holding
                     data), so geoark_zonal() can summarise it over ANY polygon
                     on demand: a buffer, a user's shape, a level not
                     precomputed.
  zonal values       one value per unit at each level in the sidecar's
                     `zonal_levels` (default: county), stored like any other
                     measure: county in acs_county_values, the rest in
                     geo_values.
  grid pyramid       real polygons at about 4, 16 and 64 km, each the exact
                     aggregate of a block of WHOLE native pixels, in geo_unit /
                     geo_values. These are the "raster as GeoJSON at another
                     scale": drawable, exportable, joinable.

SUM OR MEAN IS THE SIDECAR'S CALL (`aggregate:`). Population is summed,
temperature is averaged, and the code cannot tell which a band holds. Choosing
wrong produces a plausible map of nonsense, so there is no default.

ZONAL METHOD, AND WHY NOT PIXEL CENTRES. A 30-arc-second pixel is ~0.8 km^2;
a third of urban tracts are smaller than that. Assigning each pixel wholly to
the unit containing its centre gives many of them zero people. Each pixel is
split into SUB x SUB sub-pixels (4x4, ~250 m), its value spread evenly over
them for a sum, and sub-pixels are assigned by centre. That is area weighting
under the usual assumption that a pixel is uniform inside, at a resolution
finer than any unit it is asked about. Units still smaller than one
sub-pixel take the pixel at their interior point, scaled by area for a sum,
and are counted.

THE CHECK THAT PINS IT: conservation. Every valid pixel's value lands in
exactly one unit per level (or outside every unit, offshore), so the
per-level sums must equal the raster total minus what fell outside. That is
printed, along with how far outside, per level.
"""

from __future__ import annotations

import math
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np
import psycopg2
from psycopg2.extras import execute_values

try:
    from osgeo import gdal, ogr, osr
    gdal.UseExceptions()
    ogr.UseExceptions()
except ImportError:  # pragma: no cover
    sys.exit("GDAL is required; run this in the etl-geo container.")

sys.path.insert(0, str(Path(__file__).parent))
import dataset_meta  # noqa: E402

TILE = 128            # raster tile edge, pixels. 128 divides every pyramid factor.
SUB = 4               # sub-pixels per pixel edge for zonal statistics
GRID_KM = {"grid4k": 4, "grid16k": 16, "grid64k": 64}
EARTH_R = 6371008.8

# Which pre-simplified geometry to rasterize per level: the finest tier whose
# tolerance is under half a sub-pixel (~125 m at 30"), else full geometry.
# z12 is 0.00017 deg (~19 m); z9 is 0.0013 deg (~145 m), fine for counties.
ZONAL_GEOM = {"county": "COALESCE(geom_z9, geom)", "state": "COALESCE(geom_z9, geom)",
              "tract": "COALESCE(geom_z12, geom)", "bg": "COALESCE(geom_z12, geom)",
              "zcta": "COALESCE(geom_z12, geom)", "place": "COALESCE(geom_z12, geom)"}


# --------------------------------------------------------------------------- #
# inspection
# --------------------------------------------------------------------------- #

def inspect(path: Path) -> dict:
    ds = gdal.Open(str(path))
    if ds is None:
        raise SystemExit(f"\n  REFUSED: GDAL cannot open {path.name} as a raster\n")
    srs = osr.SpatialReference(wkt=ds.GetProjection())
    srs.AutoIdentifyEPSG()
    epsg = srs.GetAuthorityCode(None)
    ox, px, rx, oy, ry, py = ds.GetGeoTransform()
    band = ds.GetRasterBand(1)
    info = {"width": ds.RasterXSize, "height": ds.RasterYSize, "bands": ds.RasterCount,
            "epsg": int(epsg) if epsg else None, "origin_x": ox, "origin_y": oy,
            "pixel_x": px, "pixel_y": py, "rotated": bool(rx or ry),
            "nodata": band.GetNoDataValue(),
            "dtype": gdal.GetDataTypeName(band.DataType)}
    ds = None
    return info


def check(info: dict, meta: dict) -> None:
    if info["rotated"]:
        raise SystemExit("\n  REFUSED: rotated rasters are not supported; warp it north-up first\n")
    if info["epsg"] != 4326:
        raise SystemExit(
            f"\n  REFUSED: the raster is EPSG:{info['epsg']}, not 4326. Everything here is\n"
            f"  4326, and reprojecting a COUNT raster resamples it, which changes its\n"
            f"  total. Warp it yourself with the resampling that suits the data\n"
            f"  (gdalwarp -t_srs EPSG:4326 -r sum for counts, -r average for rates)\n"
            f"  and ingest the result.\n")
    if meta.get("aggregate") not in ("sum", "mean"):
        raise SystemExit(
            "\n  REFUSED: say how this raster aggregates, with  aggregate: sum  (counts:\n"
            "  population, buildings) or  aggregate: mean  (rates and fields:\n"
            "  temperature, elevation, percent cover). Guessing wrong produces a\n"
            "  plausible map of nonsense, so there is no default.\n")
    if info["bands"] != 1:
        print(f"  ! {info['bands']} bands; only band 1 is loaded")


def factors(info: dict) -> dict[str, int]:
    """
    Pyramid factor per level: whole pixels nearest the nominal size.

    Sized by pixel HEIGHT, which does not vary with latitude. Pixel width does,
    and the raster's mid-latitude is dragged north by Alaska: sizing by width
    at 45N made the "4 km" level 8x8 pixels, about 7 km tall.
    """
    km = abs(info["pixel_y"]) * math.pi / 180 * EARTH_R / 1000
    out = {}
    for level, target in GRID_KM.items():
        f = max(1, round(target / km))
        # Rounded to a power of two that divides the tile, so a cell never
        # straddles two tiles of the band being read.
        f = 2 ** round(math.log2(f))
        if f <= TILE and f > 1:
            out[level] = f
    return out


# --------------------------------------------------------------------------- #
# raster tiles -> PostGIS (WKB written directly; raster2pgsql is in no image)
# --------------------------------------------------------------------------- #

def tile_wkb(arr: np.ndarray, ulx: float, uly: float, px: float, py: float,
             nodata: float) -> bytes:
    """
    PostGIS raster WKB, version 0, one 32BF band with a nodata value.
    Layout: postgis/raster/doc/RFC2-WellKnownBinaryFormat.
    """
    h, w = arr.shape
    head = struct.pack("<BHHddddddiHH", 1, 0, 1, px, py, ulx, uly, 0.0, 0.0, 4326, w, h)
    band = struct.pack("<Bf", 0x40 | 10, nodata)      # hasnodata | PT_32BF
    return head + band + arr.astype("<f4", copy=False).tobytes()


def bands(path: Path, info: dict):
    """(row0, array float64 with NaN for nodata) per band of TILE rows."""
    ds = gdal.Open(str(path))
    b = ds.GetRasterBand(1)
    nd = info["nodata"]
    for r0 in range(0, info["height"], TILE):
        rows = min(TILE, info["height"] - r0)
        a = b.ReadAsArray(0, r0, info["width"], rows).astype(np.float64)
        if nd is not None:
            a[a == nd] = np.nan
        a[~np.isfinite(a)] = np.nan
        yield r0, a
    ds = None


def load_tiles(conn, path: Path, info: dict, table: str) -> dict:
    nd = info["nodata"] if info["nodata"] is not None else -99999.0
    px, py, ox, oy = info["pixel_x"], info["pixel_y"], info["origin_x"], info["origin_y"]
    with conn.cursor() as cur:
        cur.execute(f'DROP TABLE IF EXISTS "{table}"')
        cur.execute(f'CREATE TABLE "{table}" (rid serial PRIMARY KEY, rast raster NOT NULL)')
    tiles = valid = 0
    total = 0.0
    batch = []
    for r0, a in bands(path, info):
        for c0 in range(0, info["width"], TILE):
            t = a[:, c0:c0 + TILE]
            ok = np.isfinite(t)
            if not ok.any():
                continue
            valid += int(ok.sum())
            total += float(np.nansum(t))
            out = np.where(ok, t, nd)
            batch.append((psycopg2.Binary(tile_wkb(out, ox + c0 * px, oy + r0 * py, px, py, nd)),))
            tiles += 1
        if len(batch) >= 500:
            with conn.cursor() as cur:
                execute_values(cur, f'INSERT INTO "{table}" (rast) VALUES %s',
                               batch, template="(ST_RastFromWKB(%s))")
            batch = []
    if batch:
        with conn.cursor() as cur:
            execute_values(cur, f'INSERT INTO "{table}" (rast) VALUES %s', batch,
                           template="(ST_RastFromWKB(%s))")
    with conn.cursor() as cur:
        cur.execute(f'CREATE INDEX ON "{table}" USING gist (ST_ConvexHull(rast))')
        cur.execute(f'ANALYZE "{table}"')
    conn.commit()
    return {"tiles": tiles, "valid_pixels": valid, "total": total}


# --------------------------------------------------------------------------- #
# zonal statistics per level
# --------------------------------------------------------------------------- #

def zonal(conn, dsn: str, path: Path, info: dict, level: str, aggregate: str) -> dict:
    """
    One value per unit at `level`, by 4x4 sub-pixel area weighting, plus the
    conservation numbers. Returns {geoid: value} and diagnostics.
    """
    t0 = time.time()
    work = "_zonal_units"
    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {work}")
        cur.execute(f"""CREATE UNLOGGED TABLE {work} AS
                         SELECT row_number() OVER ()::int AS lbl, geoid,
                                {ZONAL_GEOM.get(level, 'geom')} AS geom, pt,
                                ST_Area(geom::geography) AS area_m2
                           FROM geo_unit WHERE level = %s""", (level,))
        cur.execute(f"CREATE INDEX ON {work} USING gist (geom)")
        cur.execute(f"SELECT lbl, geoid, ST_X(pt), ST_Y(pt), area_m2 FROM {work} ORDER BY lbl")
        units = cur.fetchall()
    conn.commit()
    n = len(units)
    acc = np.zeros(n + 1)          # sum of value x weight
    wsum = np.zeros(n + 1)         # sum of weight (sub-pixel area share), for means

    px, py, ox, oy = info["pixel_x"], info["pixel_y"], info["origin_x"], info["origin_y"]
    sx, sy = px / SUB, py / SUB
    src = ogr.Open(f"PG:{dsn}")
    outside = 0.0
    drv = gdal.GetDriverByName("MEM")
    for r0, a in bands(path, info):
        for c0 in range(0, info["width"], TILE):
            t = a[:, c0:c0 + TILE]
            ok = np.isfinite(t)
            if not ok.any():
                continue
            h, w = t.shape
            ulx, uly = ox + c0 * px, oy + r0 * py
            lrx, lry = ulx + w * px, uly + h * py
            mem = drv.Create("", w * SUB, h * SUB, 1, gdal.GDT_Int32)
            mem.SetGeoTransform((ulx, sx, 0, uly, 0, sy))
            srs = osr.SpatialReference()
            srs.ImportFromEPSG(4326)
            mem.SetProjection(srs.ExportToWkt())
            lyr = src.ExecuteSQL(
                f"SELECT lbl, geom FROM {work} WHERE geom && "
                f"ST_MakeEnvelope({ulx}, {lry}, {lrx}, {uly}, 4326)")
            if lyr.GetFeatureCount() == 0:
                src.ReleaseResultSet(lyr)
                if aggregate == "sum":
                    outside += float(np.nansum(t))
                continue
            gdal.RasterizeLayer(mem, [1], lyr, options=["ATTRIBUTE=lbl"])
            src.ReleaseResultSet(lyr)
            lab = mem.GetRasterBand(1).ReadAsArray()
            mem = None
            sub = np.repeat(np.repeat(t, SUB, axis=0), SUB, axis=1)
            good = np.isfinite(sub)
            if aggregate == "sum":
                vals = np.where(good, sub / (SUB * SUB), 0.0)
                wts = good / (SUB * SUB)
            else:
                # Weight by sub-pixel AREA, which shrinks with cos(latitude):
                # within a tile it barely varies, across a state it does.
                lat = uly + (np.arange(h * SUB) + 0.5) * sy
                cosl = np.cos(np.radians(lat))[:, None]
                wts = np.where(good, cosl, 0.0)
                vals = np.where(good, sub, 0.0) * wts
            lab_flat = lab.ravel()
            acc += np.bincount(lab_flat, weights=vals.ravel(), minlength=n + 1)[: n + 1]
            wsum += np.bincount(lab_flat, weights=wts.ravel(), minlength=n + 1)[: n + 1]
    src = None
    if aggregate == "sum":
        outside += acc[0]          # label 0 = inside a tile but in no unit

    # Units no sub-pixel centre fell in: take the pixel at the interior point.
    tiny = [i for i in range(1, n + 1) if wsum[i] == 0]
    filled = 0
    if tiny:
        ds = gdal.Open(str(path))
        b = ds.GetRasterBand(1)
        nd = info["nodata"]
        for i in tiny:
            _, _, x, y, area = units[i - 1]
            col = int((x - ox) / px)
            row = int((y - oy) / py)
            if not (0 <= col < info["width"] and 0 <= row < info["height"]):
                continue
            v = float(b.ReadAsArray(col, row, 1, 1)[0, 0])
            if (nd is not None and v == nd) or not math.isfinite(v):
                continue
            if aggregate == "sum":
                lat = math.radians(y)
                pix_area = (abs(px) * math.pi / 180 * EARTH_R) ** 2 * math.cos(lat)
                acc[i], wsum[i] = v * min(1.0, area / pix_area), 1.0
            else:
                acc[i], wsum[i] = v, 1.0
            filled += 1
        ds = None

    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {work}")
    conn.commit()
    out = {}
    for i in range(1, n + 1):
        if wsum[i] > 0:
            out[units[i - 1][1]] = acc[i] if aggregate == "sum" else acc[i] / wsum[i]
    return {"values": out, "units": n, "covered": len(out), "tiny_filled": filled,
            "tiny": len(tiny), "outside": outside, "seconds": time.time() - t0}


# --------------------------------------------------------------------------- #
# grid pyramid
# --------------------------------------------------------------------------- #

def pyramid(path: Path, info: dict, rid: str, aggregate: str) -> dict[str, list]:
    """{level: [(geoid, x0, y0, x1, y1, value)]}, each cell from whole pixels."""
    fs = factors(info)
    px, py, ox, oy = info["pixel_x"], info["pixel_y"], info["origin_x"], info["origin_y"]
    out = {lvl: [] for lvl in fs}
    for r0, a in bands(path, info):
        h, w = a.shape
        for lvl, f in fs.items():
            H, W = -(-h // f) * f, -(-w // f) * f
            pad = np.full((H, W), np.nan)
            pad[:h, :w] = a
            blk = pad.reshape(H // f, f, W // f, f)
            cnt = np.isfinite(blk).sum(axis=(1, 3))
            agg = np.nansum(blk, axis=(1, 3))
            if aggregate == "mean":
                # Mean of the VALID pixels; a coastal cell half nodata is the
                # mean of its land half, not diluted by the sea.
                agg = agg / np.where(cnt > 0, cnt, 1)
            br0 = r0 // f
            for i, j in zip(*np.nonzero(cnt)):
                R, C = br0 + int(i), int(j)
                x0 = ox + C * f * px
                y0 = oy + R * f * py
                out[lvl].append((f"{rid}:{R}:{C}", x0, y0 + f * py, x0 + f * px, y0,
                                 float(agg[i, j])))
    return out


def write_grid(conn, level: str, cells: list, source: str) -> None:
    if not cells:
        return
    prefix = cells[0][0].split(":")[0] + ":"
    with conn.cursor() as cur:
        cur.execute("DELETE FROM geo_unit WHERE level = %s AND geoid LIKE %s",
                    (level, prefix + "%"))
        # execute_values takes exactly one placeholder, so the two constants
        # are bound first as literals.
        lvl, src = (cur.mogrify("%s", (x,)).decode() for x in (level, source))
        execute_values(cur, f"""
            INSERT INTO geo_unit (level, geoid, name, geom, pt, aland, source)
            SELECT {lvl}, v.geoid, v.geoid, e.g, ST_Centroid(e.g),
                   ST_Area(e.g::geography)::bigint, {src}
              FROM (VALUES %s) v(geoid, x0, y0, x1, y1)
              CROSS JOIN LATERAL (SELECT ST_Multi(ST_MakeEnvelope(v.x0, v.y0, v.x1, v.y1,
                                                                  4326)) AS g) e
        """, [(g, x0, y0, x1, y1) for g, x0, y0, x1, y1, _ in cells], page_size=5000)
        # Parent keys from the cell centre, so a grid can be filtered by state
        # or county like any other level.
        cur.execute(f"""UPDATE geo_unit_{level} u SET county_fips = c.fips, state_fp = c.state_fp
                          FROM county_geom c
                         WHERE u.geoid LIKE %s AND ST_Intersects(c.geom, u.pt)""",
                    (prefix + "%",))
        cur.execute(f"ANALYZE geo_unit_{level}")
    conn.commit()


# --------------------------------------------------------------------------- #

def write_values(conn, level: str, values: dict, code: str, year: int,
                 dataset_id: str, label: str, units: str) -> None:
    rows = [(g, code, year, v) for g, v in values.items()]
    with conn.cursor() as cur:
        if level == "county":
            cur.execute("DELETE FROM acs_county_values WHERE census_code = %s AND year = %s",
                        (code, year))
            execute_values(cur, "INSERT INTO acs_county_values (fips, census_code, year, value) "
                                "VALUES %s", rows, page_size=10000)
            cur.execute("""INSERT INTO attribute_source (attr_id, dataset_id, description,
                             source_kind, table_name, census_code, entity_type)
                           VALUES (%s,%s,%s,'acs_long','acs_county_values',%s,'COUNTY')
                           ON CONFLICT (attr_id) DO UPDATE SET description = EXCLUDED.description""",
                        (code, dataset_id, label, code))
        else:
            cur.execute("DELETE FROM geo_values WHERE level = %s AND code = %s AND year = %s",
                        (level, code, year))
            execute_values(cur, "INSERT INTO geo_values (geoid, code, year, value, level) VALUES %s",
                           [(g, c, y, v, level) for g, c, y, v in rows], page_size=10000)
        cur.execute("""INSERT INTO geo_measure (code, level, dataset_id, label, description, units,
                         min_year, max_year, n_units) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (code, level) DO UPDATE SET dataset_id = EXCLUDED.dataset_id,
                         label = EXCLUDED.label, description = EXCLUDED.description,
                         units = EXCLUDED.units, min_year = EXCLUDED.min_year,
                         max_year = EXCLUDED.max_year, n_units = EXCLUDED.n_units""",
                    (code, level, dataset_id, label, label, units or None, year, year, len(rows)))
    conn.commit()


def code_for(meta: dict) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "_", str(meta.get("id") or meta["name"])).strip("_").upper()
    m = re.sub(r"[^A-Za-z0-9]+", "_", str(meta.get("measure") or "value")).strip("_").upper()
    return f"{base[:20]}_{m}"


def load(conn, dsn: str, path: Path, meta: dict, dataset_id: str) -> dict:
    """The whole data half: tiles, registry, zonal values, pyramid."""
    info = inspect(path)
    check(info, meta)
    rid = re.sub(r"[^a-z0-9]+", "", str(meta.get("id") or meta["name"]).lower())[:16]
    table = f"raster_{rid}"
    code = code_for(meta)
    year = int(meta["end_year"])
    agg = meta["aggregate"]
    label = meta.get("measure_label") or meta.get("description") or meta["name"]
    units = (dataset_meta.column_meta(meta, meta.get("measure") or "value") or {}).get("units", "")
    report = {"table": table, "code": code, "year": year, "levels": {}}

    t0 = time.time()
    tiles = load_tiles(conn, path, info, table)
    report.update(tiles)
    print(f"    {tiles['tiles']:,} tiles, {tiles['valid_pixels']:,} valid pixels, "
          f"total {tiles['total']:,.1f}  ({time.time() - t0:.0f}s)")
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO raster_layer (id, table_name, dataset_id, code, aggregate, year, srid,
              origin_x, origin_y, pixel_x, pixel_y, width, height, nodata, tile_size, tiles,
              valid_pixels, total)
            VALUES (%s,%s,%s,%s,%s,%s,4326,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET table_name = EXCLUDED.table_name,
              dataset_id = EXCLUDED.dataset_id, code = EXCLUDED.code,
              aggregate = EXCLUDED.aggregate, year = EXCLUDED.year,
              origin_x = EXCLUDED.origin_x, origin_y = EXCLUDED.origin_y,
              pixel_x = EXCLUDED.pixel_x, pixel_y = EXCLUDED.pixel_y, width = EXCLUDED.width,
              height = EXCLUDED.height, nodata = EXCLUDED.nodata, tiles = EXCLUDED.tiles,
              valid_pixels = EXCLUDED.valid_pixels, total = EXCLUDED.total, loaded_at = now()
        """, (rid, table, dataset_id, code, agg, year, info["origin_x"], info["origin_y"],
              info["pixel_x"], info["pixel_y"], info["width"], info["height"], info["nodata"],
              TILE, tiles["tiles"], tiles["valid_pixels"], tiles["total"]))
    conn.commit()

    for level in meta.get("zonal_levels") or ["county"]:
        z = zonal(conn, dsn, path, info, level, agg)
        write_values(conn, level, z["values"], code, year, dataset_id, label, units)
        captured = sum(z["values"].values()) if agg == "sum" else None
        report["levels"][level] = {k: v for k, v in z.items() if k != "values"}
        report["levels"][level]["captured"] = captured
        line = (f"    zonal {level:<6} {z['covered']:,} of {z['units']:,} units"
                f"  ({z['tiny_filled']} tiny units from their interior pixel)"
                f"  {z['seconds']:.0f}s")
        if agg == "sum":
            share = captured / tiles["total"] if tiles["total"] else 0
            # Conservation: captured + outside must equal the total, except
            # for what the tiny-unit fill added. That fill estimates people
            # ALREADY counted in a neighbouring unit, so it is stated, not hidden.
            excess = captured + z["outside"] - tiles["total"]
            report["levels"][level]["tiny_fill_excess"] = excess
            line += (f"\n           captured {captured:,.0f} = {share:.4%} of the raster total;"
                     f" {z['outside']:,.0f} fell outside every {level};"
                     f" tiny-unit fill adds {excess:+,.0f} ({excess / tiles['total']:+.4%})")
        print(line)

    grids = pyramid(path, info, rid, agg)
    for level, cells in grids.items():
        write_grid(conn, level, cells, f"raster:{rid}")
        write_values(conn, level, {g: v for g, *_, v in cells}, code, year, dataset_id,
                     label, units)
        report["levels"][level] = {"cells": len(cells), "factor": factors(info)[level]}
        print(f"    grid  {level:<8} {len(cells):,} cells of {factors(info)[level]}x"
              f"{factors(info)[level]} pixels")
    return report
