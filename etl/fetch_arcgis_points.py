#!/usr/bin/env python3
"""
Download a point layer from an ArcGIS FeatureServer into a CSV with
latitude / longitude columns, which `make ingest` loads like any other CSV.

    python3 etl/fetch_arcgis_points.py \
        --url https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Transit_Map_Stops/FeatureServer/0 \
        --fields stop_id,stop_name,stop_type_text,ntd_id,wheelchair_boarding \
        --out deploy/incoming/transit_stops/transit_stops.csv

Pages by OBJECTID range rather than resultOffset: offsets past a few hundred
thousand are slow on hosted services and can skip or repeat rows when the
service reorders. Geometry is requested in 4326. Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.parse
import urllib.request


def get(url: str, params: dict, tries: int = 5) -> dict:
    q = url + "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(q, timeout=120) as r:
                d = json.load(r)
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  retry {i + 1}: {e}", file=sys.stderr)
            time.sleep(2 * (i + 1))
    raise RuntimeError("unreachable")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="the layer URL, ending in /FeatureServer/<n>")
    ap.add_argument("--fields", required=True, help="comma-separated attribute fields to keep")
    ap.add_argument("--out", required=True)
    ap.add_argument("--where", default="1=1")
    ap.add_argument("--page", type=int, default=2000)
    args = ap.parse_args()

    meta = get(args.url, {"f": "json"})
    oid = next(f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID")
    page = min(args.page, int(meta.get("maxRecordCount") or args.page))
    stats = get(args.url + "/query", {
        "where": args.where, "f": "json", "outStatistics": json.dumps([
            {"statisticType": "min", "onStatisticField": oid, "outStatisticFieldName": "lo"},
            {"statisticType": "max", "onStatisticField": oid, "outStatisticFieldName": "hi"}])})
    a = stats["features"][0]["attributes"]
    lo, hi = int(a["lo"]), int(a["hi"])
    fields = [f.strip() for f in args.fields.split(",") if f.strip()]
    print(f"  {oid} {lo}..{hi}, page {page}", file=sys.stderr)

    n = 0
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(fields + ["latitude", "longitude"])
        start = lo
        while start <= hi:
            end = start + page - 1
            d = get(args.url + "/query", {
                "where": f"({args.where}) AND {oid} >= {start} AND {oid} <= {end}",
                "outFields": ",".join(fields), "outSR": 4326, "f": "json",
                "returnGeometry": "true"})
            for feat in d.get("features", []):
                g = feat.get("geometry") or {}
                if g.get("x") is None or g.get("y") is None:
                    continue
                at = feat["attributes"]
                w.writerow([("" if at.get(f) is None else str(at.get(f)).strip()) for f in fields]
                           + [round(g["y"], 7), round(g["x"], 7)])
                n += 1
            start = end + 1
            if (start - lo) % (page * 25) < page:
                print(f"  {n:,} rows, at {oid} {start:,}", file=sys.stderr)
    print(f"  wrote {n:,} rows to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
