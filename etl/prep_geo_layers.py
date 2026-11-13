"""Prepare three polygon layers for `make ingest`.

    python etl/prep_geo_layers.py npl        # EPA Superfund NPL site boundaries (file geodatabase)
    python etl/prep_geo_layers.py military   # NTAD / DoD military installations (file geodatabase)
    python etl/prep_geo_layers.py parks      # National Park Service units (shapefile)
    python etl/prep_geo_layers.py acres      # EPA Brownfields properties (FRS interests download)
    python etl/prep_geo_layers.py sems       # EPA Superfund sites NOT on the NPL (FRS interests download)

Each writes deploy/incoming/<id>/<id>.geojson (EPSG:4326, XY) and a sidecar. GDAL
runs in the etl-geo container, where /incoming is read-only, so GeoJSON is
streamed out through stdout. What was kept, dropped and why is in
docs/DATA_CARPENTRY.md.

npl: the layer holds several boundary types per site (Comprehensive Site Area,
Site Boundary, Current Ground Boundary, Extent of Contamination ...), 2,115
polygons for 1,908 EPA ids. One polygon is kept per EPA id, so "how many
Superfund sites" counts sites: the first of PRIORITY that exists, then the
largest. Status codes are translated from the geodatabase's own coded-value
domain. Site contact names, phone numbers and emails are NOT carried.

military: geometries repaired with -makevalid (an invalid polygon made PostgreSQL
segfault inside the loader's state tagging). military / parks: codes translated to words; fields that only describe the
record (media ids, creator, edit dates) are not carried.
"""
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INC = ROOT / "deploy" / "incoming"
q = json.dumps

NPL_GDB = "/incoming/NPL_Boundaries/NPL_Boundaries.gdb"
MIL_GDB = "/incoming/NTAD_Military_Bases_2510229195678644654/b41a7244-a481-4833-9986-0f12b16e32d2.gdb"
PARKS_SHP = "/incoming/National_Parks/National_Parks.shp"
FRS_GDB = "/incoming/epa_brownfield_othersites/FRS_Interests_Download/FRS_INTERESTS.gdb"

NPL_STATUS = {  # the geodatabase's NPL_STATUS_CODE domain
    # Tried spelling the acronym out ("... National Priorities List (NPL)") so either wording of a question would
    # match: it made the planner drop the status filter for BOTH wordings (0 of 4 runs, vs 2 of 2 with the short
    # text for "Final NPL"). Kept short.
    "A": "Part of an NPL site", "D": "Deleted from the Final NPL", "F": "Currently on the Final NPL",
    "N": "Not on the NPL", "O": "Not a valid site or incident", "P": "Proposed for the NPL",
    "R": "Removed from proposed", "S": "Pre-proposal site", "W": "Withdrawn",
}
NPL_FED = {"Y": "Federal facility", "N": "Not a federal facility", "D": "Undetermined"}
PRIORITY = ["Comprehensive Site Area", "Comprehensive Site Boundary", "Site Boundary",
            "Total Site Polygon/OU Aggregation", "Total Site Polygon/OU Boundary Aggregation",
            "Current Ground Boundary", "OU Boundary Aggregation", "OU Boundary",
            "Extent of Contamination", "Contamination Boundary", "Contamination Boundary (Groundwater)"]

# "semi" and "excs" are not documented in the geodatabase; read as semi-active and excess (inferred)
MIL_STATUS = {"act": "Active", "care": "Caretaker", "clsd": "Closed", "semi": "Semi-active", "excs": "Excess"}
MIL_COMPONENT = {
    "usa": "Army", "usar": "Army Reserve", "armyNationalGuard": "Army National Guard",
    "usn": "Navy", "usnr": "Navy Reserve", "usmc": "Marine Corps", "usmcr": "Marine Corps Reserve",
    "usaf": "Air Force", "afr": "Air Force Reserve", "airNationalGuard": "Air National Guard",
    "whs": "Washington Headquarters Services", "other": "Other",
}


def ogr_geojson(src, layer, select, makevalid=False, where=None):
    cmd = ["docker", "compose", "--profile", "etl", "run", "--rm", "-T", "--entrypoint", "ogr2ogr", "etl-geo",
           "-f", "GeoJSON", "/vsistdout/", src] + ([layer] if layer else []) + [
           "-t_srs", "EPSG:4326", "-dim", "XY", "-select", select, "-lco", "COORDINATE_PRECISION=6"]
    if where:
        cmd += ["-where", where]
    if makevalid:
        # Fort Gregg-Adams (VA) made PostgreSQL segfault (GEOS) in the loader's ST_Intersects against
        # county_geom. -makevalid alone did not help; simplifying by 0.00001 degrees (~1 m) did.
        cmd += ["-makevalid", "-simplify", "0.00001"]
    r = subprocess.run(cmd, cwd=ROOT / "deploy", capture_output=True, check=True,
                       env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    return json.loads(r.stdout)


def write(folder, features, name=None):
    out = INC / folder / f"{folder}.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    fc = {"type": "FeatureCollection", "features": features}
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"{folder}: {len(features):,} features -> {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")


def sidecar(folder, head, columns, probe):
    cols = "\n".join(f"  {k}: {q(v)}" if isinstance(v, str) else f"  {k}: {{{', '.join(f'{a}: {q(b)}' for a, b in v.items())}}}"
                     for k, v in columns.items())
    (INC / folder / f"{folder}.meta.yaml").write_text(
        head.rstrip() + f"\ncolumns:\n{cols}\nprobe: {q(probe)}\n", encoding="utf-8")


def npl():
    fields = ["EPA_ID", "SITE_NAME", "SITE_FEATURE_TYPE", "EPA_PROGRAM", "NPL_STATUS_CODE",
              "FEDERAL_FACILITY_DETER_CODE", "STREET_ADDR_TXT", "CITY_NAME", "COUNTY", "STATE_CODE",
              "ZIP_CODE", "REGION_CODE", "Shape_Area"]
    fc = ogr_geojson(NPL_GDB, "SITE_BOUNDARIES_SF", ",".join(fields))
    by_id = defaultdict(list)
    for f in fc["features"]:
        by_id[f["properties"]["EPA_ID"]].append(f)

    def rank(f):
        t = f["properties"].get("SITE_FEATURE_TYPE")
        return (PRIORITY.index(t) if t in PRIORITY else len(PRIORITY), -(f["properties"].get("Shape_Area") or 0))

    out, chosen_types = [], Counter()
    for epa_id, fs in by_id.items():
        f = sorted(fs, key=rank)[0]
        p = f["properties"]
        chosen_types[p.get("SITE_FEATURE_TYPE")] += 1
        out.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "site_name": (p["SITE_NAME"] or "").strip(),
            "epa_id": epa_id,
            "npl_status": NPL_STATUS.get(p["NPL_STATUS_CODE"], p["NPL_STATUS_CODE"] or ""),
            "federal_facility": NPL_FED.get(p["FEDERAL_FACILITY_DETER_CODE"], ""),
            "epa_program": p["EPA_PROGRAM"] or "",
            "boundary_type": p["SITE_FEATURE_TYPE"] if p["SITE_FEATURE_TYPE"] not in (None, "<Null>") else "",
            "address": (p["STREET_ADDR_TXT"] or "").strip(),
            "city": (p["CITY_NAME"] or "").strip(),
            "county": (p["COUNTY"] or "").strip(),
            "state": (p["STATE_CODE"] or "").strip(),
            "zip": (p["ZIP_CODE"] or "").strip(),
            "epa_region": p["REGION_CODE"],
        }})
    print(f"npl: {len(fc['features']):,} polygons for {len(by_id):,} sites; boundary types kept: {dict(chosen_types.most_common(6))}")
    print(f"   status: {dict(Counter(f['properties']['npl_status'] for f in out))}")
    write("epa_npl_sites", out)
    sidecar("epa_npl_sites", """# EPA Superfund National Priorities List site boundaries (geodatabase NPL_Boundaries, layer SITE_BOUNDARIES_SF).
# Prepared by etl/prep_geo_layers.py npl: one polygon per EPA id (see the script), status codes translated,
# site contact names / phones / emails not carried.
id: epa_npl_sites
name: "EPA Superfund NPL site boundaries"
kind: features
entity_type: COUNTY
vintage: 2025
description: "Boundaries of Superfund sites on or formerly on the National Priorities List (final, proposed and deleted), one polygon per site, with status, whether the site is a federal facility, and address. The boundary is the site's comprehensive area where EPA publishes one, otherwise its site boundary."
originator: US EPA Superfund Enterprise Management System
source_url: https://www.epa.gov/superfund/superfund-data-and-reports
license: public domain""", {
        "site_name": {"as": "name", "desc": "Name of the Superfund site"},
        "epa_id": {"desc": "EPA site identification number"},
        "npl_status": {"as": "status", "desc": "Status of the site on the National Priorities List: currently on the Final NPL, deleted from the Final NPL, proposed, or part of an NPL site"},
        "federal_facility": {"desc": "Whether the Superfund site is a federal facility"},
        "epa_program": {"desc": "EPA cleanup program that manages the site"},
        "boundary_type": {"desc": "Kind of boundary the polygon represents, such as comprehensive site area or site boundary"},
        "address": {"as": "address", "desc": "Street address of the site"},
        "city": {"as": "city", "desc": "City of the Superfund site"},
        "county": {"as": "county", "desc": "County of the Superfund site"},
        "state": {"as": "state", "desc": "State of the Superfund site"},
        "zip": {"as": "zip", "desc": "ZIP code of the Superfund site"},
        "epa_region": {"desc": "EPA region number"},
    }, "where are the Superfund sites in Missouri")


def military():
    fc = ogr_geojson(MIL_GDB, "Military_Bases",
                     "siteName,stateNameCode,siteOperationalStatus,siteReportingComponent,isJointBase,countryName",
                     makevalid=True)
    out, skipped = [], Counter()
    for f in fc["features"]:
        p = f["properties"]
        out.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "site_name": (p["siteName"] or "").strip(),
            "state": (p["stateNameCode"] or "").strip(),
            "operational_status": MIL_STATUS.get(p["siteOperationalStatus"], p["siteOperationalStatus"] or ""),
            "branch": MIL_COMPONENT.get(p["siteReportingComponent"], p["siteReportingComponent"] or ""),
            "joint_base": "Yes" if (p["isJointBase"] or "").lower() in ("yes", "y", "true") else "No",
            "country": "United States" if (p["countryName"] or "").strip().lower() == "usa" else (p["countryName"] or "").strip(),
        }})
        skipped[p["siteOperationalStatus"]] += 1
    print(f"military: status codes {dict(skipped)}; countries {dict(Counter(f['properties']['country'] for f in out).most_common(4))}")
    write("dod_military_bases", out)
    sidecar("dod_military_bases", """# US military installations and sites (NTAD, from the DoD Military Installations, Ranges and Training Areas data).
# Prepared by etl/prep_geo_layers.py military: codes translated to words; CUI flag, media / sds ids and
# FIRRMA flag not carried.
id: dod_military_bases
name: "Military installations"
kind: features
entity_type: COUNTY
vintage: 2025
description: "Polygons of US military installations, bases and training sites, with the owning branch (Army, Navy, Air Force, Marine Corps, National Guard and reserves), operational status (active, semi-active, caretaker, excess, closed), and whether it is a joint base."
originator: US Department of Defense, via Bureau of Transportation Statistics NTAD
source_url: https://www.bts.gov/ntad
license: public domain""", {
        "site_name": {"as": "name", "desc": "Name of the military installation or site"},
        "state": {"as": "state", "desc": "State or territory code of the installation"},
        "operational_status": {"as": "status", "desc": "Operational status of the installation: active, caretaker, or closed"},
        "branch": {"as": "owner", "desc": "Military branch or component that reports the installation, such as Army, Navy, Air Force, Marine Corps, Army National Guard"},
        "joint_base": {"desc": "Whether the installation is a joint base"},
        "country": {"desc": "Country of the installation"},
    }, "where are the military bases in Texas")


def parks():
    fc = ogr_geojson(PARKS_SHP, None, "UNIT_CODE,UNIT_NAME,STATE,REGION,UNIT_TYPE,Status")
    out = []
    for f in fc["features"]:
        p = f["properties"]
        out.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "unit_name": (p["UNIT_NAME"] or "").strip(),
            "unit_code": (p["UNIT_CODE"] or "").strip(),
            "unit_type": (p["UNIT_TYPE"] or "").strip(),
            "state": (p["STATE"] or "").strip(),
            "nps_region": (p["REGION"] or "").strip(),
            "status": (p["Status"] or "").strip(),
        }})
    print(f"parks: types {dict(Counter(f['properties']['unit_type'] for f in out).most_common(5))}; status {dict(Counter(f['properties']['status'] for f in out))}")
    write("nps_park_units", out)
    sidecar("nps_park_units", """# National Park Service units (boundaries). Prepared by etl/prep_geo_layers.py parks: selected fields only.
id: nps_park_units
name: "National Park Service units"
kind: features
entity_type: COUNTY
vintage: 2025
description: "Boundary polygons of National Park Service units: national parks, monuments, historic sites, historical parks, memorials, preserves, recreation areas, battlefields, seashores and others, with type and state."
originator: National Park Service
source_url: https://irma.nps.gov/DataStore/
license: public domain""", {
        "unit_name": {"as": "name", "desc": "Name of the National Park Service unit"},
        "unit_code": {"desc": "Four-letter NPS unit code"},
        "unit_type": {"as": "type", "desc": "Type of NPS unit: national park, national monument, national historic site, national historical park, national memorial, national preserve, national recreation area, national battlefield, national seashore"},
        "state": {"as": "state", "desc": "State or states the unit lies in"},
        "nps_region": {"desc": "National Park Service region"},
        "status": {"desc": "Boundary status of the unit"},
    }, "where are the national parks in Utah")


FRS_FIELDS = ("REGISTRY_ID,PRIMARY_NAME,LOCATION_ADDRESS,CITY_NAME,COUNTY_NAME,FIPS_CODE,STATE_CODE,POSTAL_CODE,"
              "ACCURACY_VALUE,REF_POINT_DESC,PGM_SYS_ID,ACTIVE_STATUS,FED_FACILITY_CODE,EPA_REGION_CODE")
FRS_FED = {"Y": "Yes", "N": "No"}


def frs_features(layer, where=None, status_blank=""):
    fc = ogr_geojson(FRS_GDB, layer, FRS_FIELDS, where=where)
    out, no_geom = [], 0
    for f in fc["features"]:
        p = f["properties"]
        if not f.get("geometry") or not f["geometry"].get("coordinates"):
            no_geom += 1
            continue
        out.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "name": (p["PRIMARY_NAME"] or "").strip(),
            "program_id": (p["PGM_SYS_ID"] or "").strip(),
            "registry_id": (p["REGISTRY_ID"] or "").strip(),
            "status": (p["ACTIVE_STATUS"] or "").strip().capitalize() or status_blank,
            "address": (p["LOCATION_ADDRESS"] or "").strip(),
            "city": (p["CITY_NAME"] or "").strip(),
            "county": (p["COUNTY_NAME"] or "").strip().title(),
            "county_fips": (p["FIPS_CODE"] or "").strip(),
            "state": (p["STATE_CODE"] or "").strip(),
            "zip": (p["POSTAL_CODE"] or "").strip(),
            "federal_facility": FRS_FED.get(p["FED_FACILITY_CODE"], ""),
            "epa_region": (p["EPA_REGION_CODE"] or "").strip(),
            "coordinate_accuracy_m": p["ACCURACY_VALUE"],
            "coordinate_source": (p["REF_POINT_DESC"] or "").strip(),
        }})
    print(f"   {len(fc['features']):,} read, {no_geom} without coordinates; "
          f"states {len({f['properties']['state'] for f in out})}; "
          f"accuracy stated on {sum(1 for f in out if f['properties']['coordinate_accuracy_m'] is not None):,}")
    return out


FRS_COLUMNS = {
    "name": {"as": "name", "desc": "Name of the facility or site in the EPA Facility Registry Service"},
    "program_id": {"desc": "Identifier of the site in the EPA program system"},
    "registry_id": {"desc": "EPA Facility Registry Service registry identifier"},
    "address": {"as": "address", "desc": "Street address"},
    "city": {"as": "city", "desc": "City"},
    "county": {"as": "county", "desc": "County"},
    "county_fips": {"desc": "Five-digit county FIPS code"},
    "state": {"as": "state", "desc": "State or territory code"},
    "zip": {"as": "zip", "desc": "ZIP code"},
    "federal_facility": {"desc": "Whether the site is a federal facility"},
    "epa_region": {"desc": "EPA region number"},
    "coordinate_accuracy_m": {"desc": "Estimated accuracy of the site coordinates (EPA Facility Registry Service accuracy value, stated for some sites only)"},
    "coordinate_source": {"desc": "How the coordinates were obtained, such as an address match or a reference point description"},
}


def acres():
    out = frs_features("ACRES")
    write("epa_brownfields", out)
    cols = {k: dict(v) for k, v in FRS_COLUMNS.items()}
    sidecar("epa_brownfields", """# EPA Brownfields properties from ACRES (Assessment, Cleanup and Redevelopment Exchange System), taken from
# the EPA Facility Registry Service interests geodatabase (layer ACRES). Prepared by etl/prep_geo_layers.py acres.
# Several ACRES properties can sit at one registry facility; every property is kept.
id: epa_brownfields
name: "EPA Brownfields properties"
kind: features
entity_type: COUNTY
vintage: 2025
description: "Properties in EPA's Brownfields program (ACRES): sites where redevelopment may be complicated by the presence or possible presence of a hazardous substance, pollutant or contaminant, with address and county. Points are placed from addresses and are approximate. Some of these properties are also Superfund sites."
originator: US EPA Office of Brownfields and Land Revitalization, via the Facility Registry Service
source_url: https://www.epa.gov/frs/frs-data-download-options
license: public domain""", cols, "how many Brownfields properties are in each county")


def sems():
    out = frs_features("SEMS", where="INTEREST_TYPE = 'SUPERFUND (NON-NPL)'", status_blank="Not stated")
    write("epa_superfund_nonnpl", out)
    cols = {k: dict(v) for k, v in FRS_COLUMNS.items()}
    cols["status"] = {"as": "status", "desc": "Status of the site relative to the National Priorities List: not on the NPL, removed from proposed NPL, part of an NPL site, withdrawn, or not stated"}
    sidecar("epa_superfund_nonnpl", """# EPA Superfund sites that are NOT on the National Priorities List (SEMS inventory, interest type
# SUPERFUND (NON-NPL)), from the Facility Registry Service interests geodatabase (layer SEMS).
# Prepared by etl/prep_geo_layers.py sems. The 1,766 NPL sites in the same layer are deliberately left out:
# they are already loaded as epa_npl_sites (1,751 of their ids have a boundary polygon there).
id: epa_superfund_nonnpl
name: "EPA Superfund sites not on the NPL"
kind: features
entity_type: COUNTY
vintage: 2025
description: "Sites in EPA's Superfund inventory (SEMS) that are not on the National Priorities List: sites assessed or tracked under CERCLA that were not listed, were removed from or withdrawn from proposal, or are part of an NPL site. For sites on the NPL see the Superfund NPL site boundaries layer. Points are placed from addresses and are approximate."
originator: US EPA Superfund Enterprise Management System, via the Facility Registry Service
source_url: https://www.epa.gov/frs/frs-data-download-options
license: public domain""", cols, "how many Superfund sites that are not on the NPL are in each state")


if __name__ == "__main__":
    which = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not which:
        sys.exit(__doc__)
    for w in which:
        {"npl": npl, "military": military, "parks": parks, "acres": acres, "sems": sems}[w]()
