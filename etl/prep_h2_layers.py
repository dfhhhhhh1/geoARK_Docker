#!/usr/bin/env python3
"""
Build the ingest-ready files for the national layers H2 loads
(docs/GIS_OPS_PLAN.md H2), from their public sources. Each output is the ONE
data file of its deploy/incoming/<folder>, next to its sidecar, so
`make ingest DIR=<folder>` loads it and the ledger records its sha256.

    python3 etl/prep_h2_layers.py snap      # USDA FNS SNAP retailers, currently authorized
    python3 etl/prep_h2_layers.py transit   # BTS NTAD National Transit Map stops

The two derivations, so a reload reproduces the same rows:

- SNAP: the FNS "historical" file lists every store authorized since 2005.
  A store is current when its End Date is blank (249,063 of 703,441 rows in
  the 2026-02 release). Rows without coordinates are dropped and counted.
- Transit: GTFS location_type 0 or blank is a boarding stop or platform; 1
  is a station that parents them, 2 an entrance, 3 a node, 4 a boarding
  area. Counting all of them counts one platform up to four times, so only
  0 / blank / "Null" are kept. stop_type_text arrives as a quoted list
  ('"Subway, Metro";"Bus"'); it is unquoted to "Subway, Metro; Bus".

Standard library only (runs on the host or in etl-geo).
"""

from __future__ import annotations

import csv
import io
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCOMING = ROOT / "deploy" / "incoming"
SNAP_URL = ("https://www.fns.usda.gov/sites/default/files/resource-files/"
            "snap-retailer-locator-data2005-2025.zip")
NTM_URL = ("https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/"
           "NTAD_National_Transit_Map_Stops/FeatureServer/0")


def snap() -> None:
    out = INCOMING / "snap_retailers" / "snap_retailers_current.csv"
    print(f"  downloading {SNAP_URL}")
    data = urllib.request.urlopen(SNAP_URL, timeout=600).read()
    z = zipfile.ZipFile(io.BytesIO(data))
    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
    seen = kept = bad = 0
    with z.open(name) as raw, open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["name", "type", "address", "city", "state", "zip",
                    "county", "latitude", "longitude", "authorized"])
        for r in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace")):
            seen += 1
            if (r.get("End Date") or "").strip():
                continue
            try:
                lat, lon = float(r["Latitude"]), float(r["Longitude"])
            except (TypeError, ValueError):
                bad += 1
                continue
            if lat == 0 or lon == 0:
                bad += 1
                continue
            addr = " ".join(x.strip() for x in (r["Street Number"], r["Street Name"]) if x.strip())
            w.writerow([r["Store Name"].strip(), r["Store Type"].strip(), addr, r["City"].strip(),
                        r["State"].strip(), r["Zip Code"].strip(), r["County"].strip(),
                        lat, lon, r["Authorization Date"].strip()])
            kept += 1
    print(f"  {seen:,} rows read, {kept:,} current, {bad:,} without coordinates -> {out}")


def transit(raw: Path | None = None) -> None:
    folder = INCOMING / "transit_stops"
    out = folder / "transit_stops.csv"
    if raw is None:
        raw = folder.parent / "_transit_stops_raw.csv"
        subprocess.run([sys.executable, str(ROOT / "etl" / "fetch_arcgis_points.py"),
                        "--url", NTM_URL, "--out", str(raw), "--fields",
                        "stop_id,stop_name,stop_type_text,location_type,ntd_id,wheelchair_boarding"],
                       check=True)
    seen = kept = 0
    with open(raw, encoding="utf-8") as src, open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["stop_id", "stop_name", "mode", "agency_ntd_id", "wheelchair_boarding",
                    "latitude", "longitude"])
        for r in csv.DictReader(src):
            seen += 1
            if r["location_type"] not in ("0", "", "Null"):
                continue
            mode = "; ".join(p.strip().strip('"') for p in r["stop_type_text"].split(";") if p.strip())
            w.writerow([r["stop_id"], r["stop_name"], mode, r["ntd_id"],
                        r["wheelchair_boarding"], r["latitude"], r["longitude"]])
            kept += 1
    print(f"  {seen:,} rows read, {kept:,} boarding stops kept -> {out}")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which == "snap":
        snap()
    elif which == "transit":
        transit(Path(sys.argv[2]) if len(sys.argv) > 2 else None)
    else:
        sys.exit(__doc__)
