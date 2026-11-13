"""Build the four CMS facility point layers from CMS files plus Census geocoder results.

    python etl/geocode_cms_census.py        # first: writes deploy/incoming/_raw/geocode_<set>.csv
    python etl/prep_cms_facilities.py [nursing dialysis hospice ltch]

Each writes deploy/incoming/<id>/<id>.geojson and a sidecar. A facility becomes a
point only where the Census batch geocoder returned a Match (Exact or
Non_Exact); Tie and No_Match rows are left out and counted, never placed at a
ZIP centroid or copied from another source. Every point carries `geocode_match`
(Exact / Non-exact). The nursing home file also has CMS's own latitude and
longitude: they are NOT used as the position (the user asked for one method for
all four sets), only compared with the Census point and the distance reported.

Facility names, phone numbers and CMS contact fields are not sent to the
geocoder (see geocode_cms_census.py). Phone numbers are not carried into the
layers. What was kept and dropped is in docs/DATA_CARPENTRY.md.
"""
import csv
import json
import math
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geocode_cms_census import INC, RAW, SOURCES, read_rows  # noqa: E402

q = json.dumps


def num(v):
    v = (v or "").strip().replace(",", "")
    try:
        return float(v) if "." in v else int(v)
    except ValueError:
        return None


def text(v):
    return (v or "").strip()


def yn(v):
    return {"Y": "Yes", "N": "No"}.get(text(v), text(v))


# (source column, output name, `as` label or None, description, kind)
NURSING = [
    ("Provider Name", "name", "name", "Name of the nursing home", text),
    ("CMS Certification Number (CCN)", "ccn", None, "CMS Certification Number (CCN) of the nursing home", text),
    ("Provider Address", "address", "address", "Street address of the nursing home", text),
    ("City/Town", "city", "city", "City of the nursing home", text),
    ("County/Parish", "county", "county", "County or parish of the nursing home", text),
    ("State", "state", "state", "State of the nursing home", text),
    ("ZIP Code", "zip", "zip", "ZIP code of the nursing home", text),
    ("Ownership Type", "ownership", "owner", "Ownership type of the nursing home: for profit (corporation, limited liability company, individual, partnership), non profit, or government (county, state, city)", text),
    ("Provider Type", "provider_type", "type", "Type of certification: Medicare and Medicaid, Medicare only, or Medicaid only", text),
    ("Number of Certified Beds", "certified_beds", None, "Number of Medicare- or Medicaid-certified beds in the nursing home", num),
    ("Average Number of Residents per Day", "avg_residents_per_day", None, "Average number of residents per day in the nursing home", num),
    ("Overall Rating", "overall_rating", None, "CMS Five-Star overall quality rating of the nursing home, 1 (lowest) to 5 (highest)", num),
    ("Health Inspection Rating", "health_inspection_rating", None, "CMS Five-Star health inspection rating of the nursing home, 1 to 5", num),
    ("Staffing Rating", "staffing_rating", None, "CMS Five-Star staffing rating of the nursing home, 1 to 5", num),
    ("QM Rating", "quality_measure_rating", None, "CMS Five-Star quality measures rating of the nursing home, 1 to 5", num),
    ("Reported Total Nurse Staffing Hours per Resident per Day", "nurse_hours_per_resident_day", None, "Reported total nurse staffing hours per resident per day at the nursing home", num),
    ("Reported RN Staffing Hours per Resident per Day", "rn_hours_per_resident_day", None, "Reported registered nurse staffing hours per resident per day at the nursing home", num),
    ("Total nursing staff turnover", "nurse_turnover_pct", None, "Percent of nursing staff who left the nursing home in a year (total nursing staff turnover)", num),
    ("Total Amount of Fines in Dollars", "fines_dollars", None, "Total amount of fines in dollars imposed on the nursing home", num),
    ("Special Focus Status", "special_focus_status", None, "Whether the nursing home is in the CMS Special Focus Facility program for poor performance (blank if not)", text),
    ("Continuing Care Retirement Community", "continuing_care_community", None, "Whether the nursing home is part of a continuing care retirement community", yn),
    ("Chain Name", "chain_name", None, "Name of the corporate chain that owns the nursing home, if any", text),
]
DIALYSIS = [
    ("Facility Name", "name", "name", "Name of the dialysis facility", text),
    ("CMS Certification Number (CCN)", "ccn", None, "CMS Certification Number (CCN) of the dialysis facility", text),
    ("Address Line 1", "address", "address", "Street address of the dialysis facility", text),
    ("City/Town", "city", "city", "City of the dialysis facility", text),
    ("County/Parish", "county", "county", "County or parish of the dialysis facility", text),
    ("State", "state", "state", "State of the dialysis facility", text),
    ("ZIP Code", "zip", "zip", "ZIP code of the dialysis facility", text),
    ("Profit or Non-Profit", "ownership", "owner", "Whether the dialysis facility is for profit or non-profit", text),
    ("Chain Organization", "chain_name", None, "Name of the dialysis chain organization that owns the facility, if any", text),
    ("Five Star", "five_star_rating", None, "CMS Dialysis Facility Compare five-star quality rating, 1 (lowest) to 5 (highest)", num),
    ("# of Dialysis Stations", "dialysis_stations", None, "Number of dialysis stations at the facility", num),
    ("Offers in-center hemodialysis", "offers_in_center_hemodialysis", None, "Whether the facility offers in-center hemodialysis", yn),
    ("Offers peritoneal dialysis", "offers_peritoneal_dialysis", None, "Whether the facility offers peritoneal dialysis", yn),
    ("Offers home hemodialysis training", "offers_home_hemodialysis_training", None, "Whether the facility offers home hemodialysis training", yn),
    ("Patient Survival Category Text", "patient_survival_category", None, "How patient survival at the facility compares with the national rate: better than expected, as expected, or worse than expected", text),
    ("Patient hospitalization category text", "patient_hospitalization_category", None, "How patient hospitalization at the facility compares with the national rate: better than expected, as expected, or worse than expected", text),
]
HOSPICE = [
    ("Facility Name", "name", "name", "Name of the hospice", text),
    ("CMS Certification Number (CCN)", "ccn", None, "CMS Certification Number (CCN) of the hospice", text),
    ("Address Line 1", "address", "address", "Street address of the hospice", text),
    ("City/Town", "city", "city", "City of the hospice", text),
    ("County/Parish", "county", "county", "County or parish of the hospice", text),
    ("State", "state", "state", "State of the hospice", text),
    ("ZIP Code", "zip", "zip", "ZIP code of the hospice", text),
    ("Ownership Type", "ownership", "owner", "Ownership type of the hospice: for-profit, non-profit, government or other", text),
    ("Certification Date", "certification_date", None, "Date the hospice was certified for Medicare", text),
]
LTCH = [
    ("Provider Name", "name", "name", "Name of the long-term care hospital", text),
    ("CMS Certification Number (CCN)", "ccn", None, "CMS Certification Number (CCN) of the long-term care hospital", text),
    ("Address Line 1", "address", "address", "Street address of the long-term care hospital", text),
    ("City/Town", "city", "city", "City of the long-term care hospital", text),
    ("County/Parish", "county", "county", "County or parish of the long-term care hospital", text),
    ("State", "state", "state", "State of the long-term care hospital", text),
    ("ZIP Code", "zip", "zip", "ZIP code of the long-term care hospital", text),
    ("Ownership Type", "ownership", "owner", "Ownership type of the long-term care hospital: proprietary, non-profit or government", text),
    ("Total Number of Beds", "beds", None, "Total number of beds in the long-term care hospital", num),
    ("Certification Date", "certification_date", None, "Date the long-term care hospital was certified for Medicare", text),
]
GEOCODE_COL = ("geocode_match", None, "How precisely the Census Bureau geocoder placed the point: Exact (the street address matched) or Non-exact (matched approximately, for example a nearby address or a street segment)")

LAYERS = {
    "nursing": ("cms_nursing_homes", "CMS Medicare and Medicaid nursing homes", NURSING,
                "Nursing homes certified for Medicare or Medicaid, from CMS Care Compare provider information (October 2026), with ownership, beds, Five-Star ratings, staffing, turnover and fines. Positions come from the US Census Bureau geocoder, matched on street address.",
                "which nursing homes have the lowest overall star rating", "CMS Care Compare"),
    "dialysis": ("cms_dialysis_facilities", "CMS dialysis facilities", DIALYSIS,
                 "Medicare-certified dialysis facilities from CMS Dialysis Facility Compare, with ownership, chain, five-star rating, number of stations, services offered, and survival and hospitalization compared with national rates. Positions come from the US Census Bureau geocoder, matched on street address.",
                 "where are the dialysis facilities in Missouri", "CMS Dialysis Facility Compare"),
    "hospice": ("cms_hospices", "CMS hospices", HOSPICE,
                "Medicare-certified hospices from CMS Hospice General Information (August 2026), with ownership and certification date. Positions come from the US Census Bureau geocoder, matched on street address.",
                "where are the hospices in Ohio", "CMS Hospice Compare"),
    "ltch": ("cms_long_term_care_hospitals", "CMS long-term care hospitals", LTCH,
             "Medicare-certified long-term care hospitals from CMS general information (September 2026), with ownership, beds and certification date. Positions come from the US Census Bureau geocoder, matched on street address.",
             "where are the long-term care hospitals in Texas", "CMS Long-Term Care Hospital Compare"),
}


def haversine_m(lon1, lat1, lon2, lat2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742000 * math.asin(math.sqrt(a))


def build(name):
    folder, title, spec, desc, probe, origin = LAYERS[name]
    src_file = SOURCES[name][0]
    rows = read_rows(INC / src_file)
    missing = [c for c, *_ in spec if c not in rows[0]]
    if missing:
        sys.exit(f"{name}: columns not found in {src_file}: {missing}")
    res = {}
    for r in csv.reader((RAW / f"geocode_{name}.csv").read_text(encoding="utf-8").splitlines()):
        res[r[0]] = r  # id = CCN (zero padded)
    feats, outcome, dists = [], Counter(), []
    for r in rows:
        ccn = r["CMS Certification Number (CCN)"].strip().zfill(6)
        g = res.get(ccn)
        if g is None:
            outcome["not returned"] += 1
            continue
        kind = g[2] + (f"/{g[3]}" if len(g) > 3 and g[3] else "")
        outcome[kind] += 1
        if g[2] != "Match":
            continue
        lon, lat = (float(x) for x in g[5].split(","))
        props = {out: fn(r.get(col)) for col, out, _, _, fn in spec}
        props["geocode_match"] = "Exact" if g[3] == "Exact" else "Non-exact"
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props})
        if name == "nursing" and r["Latitude"].strip() and r["Longitude"].strip():
            dists.append(haversine_m(lon, lat, float(r["Longitude"]), float(r["Latitude"])))
    total = len(rows)
    placed = len(feats)
    print(f"{folder}: {total:,} facilities, {placed:,} placed ({placed / total:.1%}); outcome {dict(outcome)}")
    if dists:
        dists.sort()
        pct = lambda p: dists[int(len(dists) * p)]
        print(f"   vs CMS's own coordinates ({len(dists):,}): median {statistics.median(dists):.0f} m, "
              f"p90 {pct(.9):.0f} m, p99 {pct(.99):.0f} m, over 1 km {sum(d > 1000 for d in dists):,}, "
              f"over 10 km {sum(d > 10000 for d in dists):,}")
    out = INC / folder / f"{folder}.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")
    cols = [c[1:] for c in spec] + [GEOCODE_COL]
    lines = []
    for item in cols:
        out_name, as_, d = item[0], item[1], item[2]
        body = (f"as: {q(as_)}, " if as_ else "") + f"desc: {q(d)}"
        lines.append(f"  {out_name}: {{{body}}}")
    (INC / folder / f"{folder}.meta.yaml").write_text(
        f"# {title}. Prepared by etl/prep_cms_facilities.py {name}: CMS file + US Census Bureau batch geocoder results.\n"
        f"# {total:,} facilities in the CMS file; {placed:,} geocoded to a point; the rest (Tie / No_Match) are not in the layer.\n"
        f"# Phone numbers are not carried. Positions are the Census geocoder's, not CMS's.\n"
        f"id: {folder}\nname: {q(title)}\nkind: features\nentity_type: COUNTY\nvintage: 2026\n"
        f"description: {q(desc + f' {total - placed:,} of {total:,} facilities in the CMS file could not be matched to an address and are not shown.')}\n"
        f"originator: Centers for Medicare & Medicaid Services ({origin})\n"
        f"source_url: https://data.cms.gov/provider-data/\nlicense: public domain\n"
        f"columns:\n" + "\n".join(lines) + f"\nprobe: {q(probe)}\n", encoding="utf-8")
    return folder


if __name__ == "__main__":
    which = [a for a in sys.argv[1:] if a in LAYERS] or list(LAYERS)
    for w in which:
        build(w)
