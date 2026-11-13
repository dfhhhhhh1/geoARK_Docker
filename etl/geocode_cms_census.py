"""Geocode the CMS facility addresses with the US Census Bureau batch geocoder.

    python etl/geocode_cms_census.py [--test 50] [nursing dialysis hospice ltch]

The files have street addresses and no usable coordinates (the nursing home file
has CMS's own; they are kept only as a cross-check, never as the position). The
Census geocoder (https://geocoding.geo.census.gov/geocoder/) is free, needs no
key, and takes up to 10,000 addresses per request. ** The addresses are sent to
that US government service. ** They are public business addresses (facility name
is NOT sent: only an id, street, city, state, ZIP). The user authorised this on
2026-11-13.

Raw results are written to deploy/incoming/_raw/geocode_<set>.csv exactly as
returned (id, input address, Match / No_Match / Tie, Exact / Non_Exact, matched
address, "lon,lat", TIGER line id, side), so the prepared layers can be rebuilt
without calling the service again. A set that already has a result file is not
sent again unless --force is given.
"""
import csv
import subprocess
import sys
import time
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
RAW = INC / "_raw"
URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
BENCHMARK = "Public_AR_Current"
CHUNK = 5000

# set -> (file, ccn column, street columns, city, state, zip)
SOURCES = {
    "nursing": ("cms_nursing homes/NH_ProviderInfo_Oct2026.csv", "CMS Certification Number (CCN)",
                ["Provider Address"], "City/Town", "State", "ZIP Code"),
    "dialysis": ("cms_dialysis/DFC_FACILITY_2.csv", "CMS Certification Number (CCN)",
                 ["Address Line 1"], "City/Town", "State", "ZIP Code"),
    "hospice": ("cms_hospice/Hospice_General-Information_Aug2026_2.csv", "CMS Certification Number (CCN)",
                ["Address Line 1"], "City/Town", "State", "ZIP Code"),
    "ltch": ("cms_long_term_care/Long-Term_Care_Hospital-General_Information_Sep2026.csv",
             "CMS Certification Number (CCN)", ["Address Line 1"], "City/Town", "State", "ZIP Code"),
}


def read_rows(path):
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    return list(csv.DictReader(text.splitlines()))


def address_rows(name):
    f, ccn, street, city, state, zipc = SOURCES[name]
    out = []
    for r in read_rows(INC / f):
        z = "".join(c for c in (r[zipc] or "") if c.isdigit())[:5].zfill(5)
        out.append([r[ccn].strip().zfill(6), (r[street[0]] or "").strip(), (r[city] or "").strip(),
                    (r[state] or "").strip(), z])
    return out


def post(rows, tag):
    """One request. Returns the parsed result rows."""
    RAW.mkdir(parents=True, exist_ok=True)
    src = RAW / f"_send_{tag}.csv"
    with open(src, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
    out = RAW / f"_recv_{tag}.csv"
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "-S", "--max-time", "600", "-o", str(out), "-w", "%{http_code}",
                            "-F", f"addressFile=@{src}", "-F", f"benchmark={BENCHMARK}", URL],
                           capture_output=True, text=True)
        code = r.stdout.strip()
        if code == "200" and out.exists() and out.stat().st_size > 0:
            res = list(csv.reader(out.read_text(encoding="utf-8", errors="replace").splitlines()))
            if len(res) >= len(rows) * 0.98:  # a short response means a partial failure
                return res
        print(f"   attempt {attempt + 1} for {tag}: HTTP {code} {r.stderr.strip()[:120]}", flush=True)
        time.sleep(10 * (attempt + 1))
    sys.exit(f"geocoding {tag} failed after 3 attempts")


def main():
    args = sys.argv[1:]
    force = "--force" in args
    test = None
    if "--test" in args:
        test = int(args[args.index("--test") + 1])
    sets = [a for a in args if a in SOURCES] or list(SOURCES)
    for name in sets:
        final = RAW / f"geocode_{name}.csv"
        if final.exists() and not force and test is None:
            print(f"{name}: already geocoded ({final.name}); --force to redo")
            continue
        rows = address_rows(name)
        if test:
            rows = rows[:test]
        results = []
        for i in range(0, len(rows), CHUNK):
            part = rows[i:i + CHUNK]
            print(f"{name}: sending {len(part):,} addresses ({i + len(part):,}/{len(rows):,})", flush=True)
            results += post(part, f"{name}_{i // CHUNK}")
        counts = {}
        for r in results:
            k = (r[2] if len(r) > 2 else "?") + (f"/{r[3]}" if len(r) > 3 and r[3] else "")
            counts[k] = counts.get(k, 0) + 1
        print(f"{name}: {len(results):,} results of {len(rows):,}: {counts}")
        if test is None:
            with open(final, "w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerows(results)
        else:
            for r in results[:3]:
                print("   sample:", r)


if __name__ == "__main__":
    main()
