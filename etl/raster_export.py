#!/usr/bin/env python3
"""
A raster as GeoJSON polygons, for one area, at a cell size you choose.

    python3 etl/raster_export.py --raster worldpop --state 29 --cell-km 2
    python3 etl/raster_export.py --raster worldpop --county 29077 --cell-km 1
    python3 etl/raster_export.py --raster worldpop --bbox -94.6,36.5,-89.1,40.6 --cell-km 8

Writes /dumps/exports/<raster>_<area>_<km>km.geojson (deploy/dumps/exports/ on
the host). docs/DATA_LOADING_PLAN.md section 4: the whole 1 km US grid as
GeoJSON is several GB that nothing can draw, so polygons are produced for the
area and scale someone actually asks for.

HOW CELLS ARE MADE. A cell is a block of f x f WHOLE native pixels, with f the
integer nearest cell_km / pixel height, aligned to the raster's own origin.
Cells therefore never resample: a sum cell is exactly the sum of its pixels,
and with f a power of two they nest inside the precomputed grid4k / grid16k /
grid64k cells. A cell is kept when its centre is inside the area (whole cells,
not clipped slivers, so every cell's value means the same thing). Pixels are
read from the database tiles, so this works on a server that restored the
raster from a dump and never had the source file.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import psycopg2

try:
    from osgeo import ogr
    ogr.UseExceptions()
except ImportError:  # pragma: no cover
    sys.exit("GDAL is required; run this in the etl-geo container.")

EARTH_R = 6371008.8
OUT = Path(os.environ.get("DUMP_ROOT", "/dumps")) / "exports"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raster", required=True, help="raster_layer id, e.g. worldpop")
    area = ap.add_mutually_exclusive_group(required=True)
    area.add_argument("--state", help="state FIPS, e.g. 29")
    area.add_argument("--county", help="county FIPS, e.g. 29077")
    area.add_argument("--bbox", help="west,south,east,north in degrees")
    ap.add_argument("--cell-km", type=float, default=1.0)
    ap.add_argument("--max-cells", type=int, default=250_000)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    conn = psycopg2.connect()
    cur = conn.cursor()
    cur.execute("""SELECT table_name, aggregate, code, year, origin_x, origin_y, pixel_x,
                          pixel_y, width, height FROM raster_layer WHERE id = %s""", (args.raster,))
    row = cur.fetchone()
    if row is None:
        cur.execute("SELECT id FROM raster_layer ORDER BY 1")
        sys.exit(f"  no raster {args.raster!r}. Loaded: "
                 f"{', '.join(r[0] for r in cur.fetchall()) or 'none'}")
    table, agg, code, year, ox, oy, px, py, W, H = row

    if args.state:
        cur.execute("SELECT ST_AsText(ST_Union(geom)) FROM county_geom WHERE state_fp = %s",
                    (args.state.zfill(2),))
        label = f"state{args.state.zfill(2)}"
    elif args.county:
        cur.execute("SELECT ST_AsText(geom) FROM county_geom WHERE fips = %s",
                    (args.county.zfill(5),))
        label = f"county{args.county.zfill(5)}"
    else:
        w, s, e, n = (float(v) for v in args.bbox.split(","))
        cur.execute("SELECT ST_AsText(ST_MakeEnvelope(%s,%s,%s,%s,4326))", (w, s, e, n))
        label = "bbox"
    wkt = cur.fetchone()[0]
    if not wkt:
        sys.exit("  that area has no geometry")
    area_geom = ogr.CreateGeometryFromWkt(wkt)
    minx, maxx, miny, maxy = area_geom.GetEnvelope()

    pixel_km = abs(py) * math.pi / 180 * EARTH_R / 1000
    f = max(1, round(args.cell_km / pixel_km))
    # The window, in native pixels, snapped OUT to whole cells.
    c0 = max(0, (int((minx - ox) / px) // f) * f)
    c1 = min(W, -(-int(math.ceil((maxx - ox) / px)) // f) * f)
    r0 = max(0, (int((maxy - oy) / py) // f) * f)
    r1 = min(H, -(-int(math.ceil((miny - oy) / py)) // f) * f)
    if c1 <= c0 or r1 <= r0:
        sys.exit("  the area does not overlap the raster")
    est = ((c1 - c0) // f + 1) * ((r1 - r0) // f + 1)
    if est > args.max_cells * 4:
        sys.exit(f"  about {est:,} candidate cells at {f}x{f} pixels; raise --cell-km "
                 f"or narrow the area (cap {args.max_cells:,} cells)")

    # Assemble the window from the tiles that intersect it.
    win = np.full((r1 - r0, c1 - c0), np.nan)
    cur.execute(f"""
        SELECT ST_UpperLeftX(rast), ST_UpperLeftY(rast), ST_Width(rast), ST_Height(rast),
               ST_DumpValues(rast, 1)
          FROM {table}
         WHERE ST_Intersects(rast, ST_MakeEnvelope(%s, %s, %s, %s, 4326))""",
                (ox + c0 * px, oy + r1 * py, ox + c1 * px, oy + r0 * py))
    for ulx, uly, tw, th, vals in cur.fetchall():
        tc = round((ulx - ox) / px)
        tr = round((uly - oy) / py)
        arr = np.array([[np.nan if v is None else v for v in r] for r in vals], dtype=float)
        a0, a1 = max(tr, r0), min(tr + th, r1)
        b0, b1 = max(tc, c0), min(tc + tw, c1)
        if a1 > a0 and b1 > b0:
            win[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = arr[a0 - tr:a1 - tr, b0 - tc:b1 - tc]

    hh, ww = win.shape
    Hc, Wc = -(-hh // f) * f, -(-ww // f) * f
    pad = np.full((Hc, Wc), np.nan)
    pad[:hh, :ww] = win
    blk = pad.reshape(Hc // f, f, Wc // f, f)
    cnt = np.isfinite(blk).sum(axis=(1, 3))
    tot = np.nansum(blk, axis=(1, 3))
    val = tot if agg == "sum" else tot / np.where(cnt > 0, cnt, 1)

    feats = []
    for i, j in zip(*np.nonzero(cnt)):
        R, C = (r0 // f) + int(i), (c0 // f) + int(j)
        x0, y0 = ox + C * f * px, oy + R * f * py
        x1, y1 = x0 + f * px, y0 + f * py
        centre = ogr.Geometry(ogr.wkbPoint)
        centre.AddPoint_2D((x0 + x1) / 2, (y0 + y1) / 2)
        if not area_geom.Contains(centre):
            continue
        feats.append({"type": "Feature",
                      "properties": {"cell": f"{args.raster}:{f}:{R}:{C}",
                                     "value": round(float(val[i, j]), 4),
                                     "pixels": int(cnt[i, j])},
                      "geometry": {"type": "Polygon", "coordinates": [[
                          [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}})
        if len(feats) > args.max_cells:
            sys.exit(f"  more than {args.max_cells:,} cells; raise --cell-km or narrow the area")

    OUT.mkdir(parents=True, exist_ok=True)
    out = args.out or OUT / f"{args.raster}_{label}_{args.cell_km:g}km.geojson"
    cell_km = f * pixel_km
    doc = {"type": "FeatureCollection",
           "metadata": {"raster": args.raster, "code": code, "year": year, "aggregate": agg,
                        "pixels_per_cell": f, "cell_km_approx": round(cell_km, 3),
                        "area": label, "cells": len(feats),
                        "total": round(float(sum(x["properties"]["value"] for x in feats)), 3)
                        if agg == "sum" else None},
           "features": feats}
    out.write_text(json.dumps(doc))
    print(f"  {len(feats):,} cells of {f}x{f} pixels (~{cell_km:.2f} km) -> {out}  "
          f"({out.stat().st_size / 1e6:.1f} MB)")
    if agg == "sum":
        print(f"  total {doc['metadata']['total']:,.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
