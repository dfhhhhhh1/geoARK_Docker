#!/usr/bin/env python3
"""
Feature layers from the GeoARK paper's Supplementary File A that the
truncated HSIP archive never delivered, rebuilt from current public
publishers (HIFLD Open was retired in 2025). docs/DATA_CARPENTRY.md,
"Supplementary File A feature layers (2026-11-20)", records each decision.

Two steps per layer, so a reload reproduces the same rows:

    python3 etl/prep_supp_a_layers.py fetch <layer|all>   # download -> deploy/incoming/_raw/supa_<layer>.*
    python3 etl/prep_supp_a_layers.py prep  <layer|all>   # raw -> deploy/incoming/<folder>/ (data + sidecar)
    python3 etl/prep_supp_a_layers.py list

`fetch` talks to the publisher (an ArcGIS service, paged by OBJECTID range
with f=geojson, or a file download). `prep` reads only the saved raw file, so
it is deterministic: re-running it reproduces the loaded file byte for byte.
Points are written as CSV with latitude / longitude; lines and polygons as
GeoJSON with coordinates rounded to 6 decimals (~0.1 m).

Standard library only, except openpyxl for the EIA-860M workbook.
"""

from __future__ import annotations

import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCOMING = ROOT / "deploy" / "incoming"
RAW = INCOMING / "_raw"

NTAD = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services"
FEMA = "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services"
KYREHOST = "https://services5.arcgis.com/HDRa0B57OVrv2E1q/arcgis/rest/services"
HRSA = "https://gisportal.hrsa.gov/server/rest/services"
UA = {"User-Agent": "geoark-etl/1.0 (data preparation)"}


# --------------------------------------------------------------------------
# download helpers

def _get(url: str, params: dict | None = None, tries: int = 6, timeout: int = 180) -> bytes:
    q = url + ("?" + urllib.parse.urlencode(params) if params else "")
    for i in range(tries):
        try:
            req = urllib.request.Request(q, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  retry {i + 1}: {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise RuntimeError("unreachable")


def _getjson(url: str, params: dict) -> dict:
    d = json.loads(_get(url, params))
    if isinstance(d, dict) and "error" in d:
        raise RuntimeError(f"{url}: {d['error']}")
    return d


def fetch_arcgis(url: str, out: Path, where: str = "1=1", page: int = 1000) -> None:
    """Every feature of one layer as a GeoJSON FeatureCollection (all fields, 4326)."""
    meta = _getjson(url, {"f": "json"})
    oid = next(f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID")
    page = min(page, int(meta.get("maxRecordCount") or page))
    st = _getjson(url + "/query", {"where": where, "f": "json", "outStatistics": json.dumps([
        {"statisticType": "min", "onStatisticField": oid, "outStatisticFieldName": "lo"},
        {"statisticType": "max", "onStatisticField": oid, "outStatisticFieldName": "hi"}])})
    a = st["features"][0]["attributes"]
    lo, hi = int(a["lo"]), int(a["hi"])
    n_expected = _getjson(url + "/query", {"where": where, "returnCountOnly": "true", "f": "json"})["count"]
    print(f"  {meta.get('name')}: {n_expected:,} features, {oid} {lo}..{hi}", file=sys.stderr)
    feats = []
    start = lo
    while start <= hi:
        end = start + page - 1
        d = json.loads(_get(url + "/query", {
            "where": f"({where}) AND {oid} >= {start} AND {oid} <= {end}",
            "outFields": "*", "outSR": 4326, "f": "geojson", "returnGeometry": "true"}))
        if "error" in d:
            raise RuntimeError(d["error"])
        feats.extend(d.get("features", []))
        start = end + 1
    if len(feats) != n_expected:
        raise RuntimeError(f"fetched {len(feats)} features, service reports {n_expected}")
    fc = {"type": "FeatureCollection",
          "source": url, "fetched": time.strftime("%Y-%m-%d"),
          "service_last_edit": (meta.get("editingInfo") or {}).get("lastEditDate"),
          "features": feats}
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {len(feats):,} features to {out}", file=sys.stderr)


def fetch_file(url: str, out: Path) -> None:
    out.write_bytes(_get(url, timeout=600))
    print(f"  wrote {out} ({out.stat().st_size:,} bytes)", file=sys.stderr)


# --------------------------------------------------------------------------
# value cleaning

def clean(v) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    if s.upper() in ("NOT AVAILABLE", "NULL", "N/A", "NONE", "-999", "-999.0"):
        return ""
    return " ".join(s.split())


def r6(x):
    if isinstance(x, list):
        return [r6(y) for y in x]
    return round(x, 6) if isinstance(x, float) else x


def point_of(f) -> tuple[float, float] | None:
    g = f.get("geometry") or {}
    if g.get("type") == "Point":
        x, y = g["coordinates"][:2]
    elif g.get("type") == "MultiPoint" and g["coordinates"]:
        x, y = g["coordinates"][0][:2]
    else:
        return None
    if x is None or y is None or (abs(x) < 1e-9 and abs(y) < 1e-9):
        return None
    if not (-180 <= x <= 180 and -90 <= y <= 90):
        return None
    return (round(y, 7), round(x, 7))


# --------------------------------------------------------------------------
# the layers. `cols` maps OUTPUT column -> source field (or a callable on the
# properties). Points become CSV, everything else GeoJSON.

def _title(s: str) -> str:
    return s.title() if s and s.isupper() else s


LAYERS: dict[str, dict] = {}


def layer(name, **kw):
    LAYERS[name] = kw


# -- HSIP successors ---------------------------------------------------------

layer("petroleum_ports",
      folder="ntad_petroleum_ports", geom="point",
      url=f"{NTAD}/Petroleum_Ports/FeatureServer/0",
      cols={"name": "NAME", "type": "TYPE", "status": "STATUS", "operator": "OPERATOR",
            "county": "COUNTY", "state": "STATE", "source_date": "SOURCEDATE"},
      meta=dict(
          id="ntad_petroleum_ports", name="Petroleum Ports", vintage=2026,
          description="Ports and port facilities that handle petroleum products (crude oil and refined fuels): marine and inland waterway terminals, with operator and status.",
          originator="U.S. DOT Bureau of Transportation Statistics, National Transportation Atlas Database (successor host of the HIFLD Petroleum Ports layer)",
          source_url="https://geodata.bts.gov/ (NTAD, service Petroleum_Ports)",
          keywords=["petroleum ports", "oil ports", "fuel ports", "petroleum terminals on water", "energy infrastructure"],
          columns={"name": {"as": "name", "desc": "Port or facility name"},
                   "type": {"as": "type", "desc": "Kind of port facility"},
                   "status": {"as": "status", "desc": "Operating status"},
                   "operator": {"as": "owner", "desc": "Operator of the port facility"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "source_date": {"skip": True}},
          probe="where are the petroleum ports in Texas"))

layer("pol_terminals",
      folder="ntad_pipeline_terminals", geom="point",
      url=f"{NTAD}/NTAD_Intermodal_Freight_Facilities_Pipeline_Terminals/FeatureServer/0",
      cols={"name": "TERM_NAME", "company": "COMP_NAME", "address": "ADDRESS", "city": "CITY",
            "state": "STATE", "county": "COUNTY", "county_fips": "CNTY_FIPS",
            "products": lambda p: "; ".join(lbl for fld, lbl in (
                ("CRUDE_OIL", "crude oil"), ("REFINED", "refined products"), ("GASOLINE", "gasoline"),
                ("DISTILLATE", "distillate"), ("JETFUEL", "jet fuel"), ("ETHANOL", "ethanol"),
                ("BIODIESEL", "biodiesel"), ("NGL", "natural gas liquids"), ("PET_CHEM", "petrochemicals"))
                if clean(p.get(fld)).upper() in ("Y", "YES", "1", "TRUE")),
            "modes": lambda p: "; ".join(lbl for fld, lbl in (("TRUCK", "truck"), ("RAIL", "rail"), ("WATER", "water"))
                                         if clean(p.get(fld)).upper() in ("Y", "YES", "1", "TRUE")),
            "capacity_barrels": "CAPACITY"},
      meta=dict(
          id="ntad_pipeline_terminals", name="Petroleum Product Terminals (POL terminals)", vintage=2024,
          description="Petroleum, oil and lubricants (POL) bulk terminals where pipelines deliver crude oil, gasoline, diesel, jet fuel, ethanol and other products to truck, rail or water transport, with the products handled and storage capacity.",
          originator="U.S. DOT Bureau of Transportation Statistics, NTAD Intermodal Freight Facilities: Pipeline Terminals (successor of the HIFLD POL / Petroleum Terminals layer; carries the HIFLD id)",
          source_url="https://geodata.bts.gov/ (NTAD, service NTAD_Intermodal_Freight_Facilities_Pipeline_Terminals)",
          keywords=["petroleum terminals", "POL terminals", "fuel terminals", "oil terminals", "tank farms", "bulk fuel storage"],
          columns={"name": {"as": "name", "desc": "Terminal name"},
                   "company": {"as": "owner", "desc": "Operating company"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "state": {"as": "state", "desc": "State"},
                   "county": {"as": "county", "desc": "County"},
                   "county_fips": {"skip": True},
                   "products": {"as": "type", "desc": "Products handled at the terminal (crude oil, gasoline, distillate, jet fuel, ethanol ...)"},
                   "modes": {"desc": "Outbound transport modes served: truck, rail, water"},
                   "capacity_barrels": {"desc": "Storage capacity", "units": "barrels"}},
          probe="how many petroleum terminals are in each state"))

layer("pol_pumping_stations",
      folder="pol_pumping_stations", geom="point",
      url=f"{KYREHOST}/POL_Pumping_Stations/FeatureServer/0",
      cols={"name": "NAME", "type": "TYPE", "status": "STATUS", "commodity": "COMMODITY",
            "operator": "OPERATOR", "city": "CITY", "county": "COUNTY", "state": "STATE",
            "source_date": "SOURCEDATE"},
      meta=dict(
          id="pol_pumping_stations", name="POL Pumping Stations", vintage=2021,
          description="Pumping stations on petroleum, oil and lubricants (POL) pipelines that move crude oil and refined products, with commodity and operator. A 2021 snapshot of the retired HIFLD layer.",
          originator="HIFLD Open (DHS), 2021 release, as re-published on ArcGIS Online (owner clibby007, org HDRa0B57OVrv2E1q); HIFLD Open was retired in 2025 and no agency successor publishes this layer",
          source_url=f"{KYREHOST}/POL_Pumping_Stations/FeatureServer/0",
          keywords=["pipeline pumping stations", "oil pump stations", "petroleum pipeline", "POL pumping stations"],
          columns={"name": {"as": "name", "desc": "Station name"},
                   "type": {"as": "type", "desc": "Station type"},
                   "status": {"as": "status", "desc": "Operating status"},
                   "commodity": {"desc": "Commodity pumped (crude oil, refined products ...)"},
                   "operator": {"as": "owner", "desc": "Pipeline operator"},
                   "city": {"as": "city", "desc": "City"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "source_date": {"skip": True}},
          probe="where are the oil pipeline pumping stations in Oklahoma"))

layer("prison_boundaries",
      folder="prison_boundaries", geom="polygon",
      url=f"{FEMA}/Prison_Boundaries_RAPT/FeatureServer/1",
      cols={"name": "NAME", "type": "TYPE", "status": "STATUS", "security_level": "SECURELVL",
            "population": "POPULATION", "capacity": "CAPACITY", "address": "ADDRESS",
            "city": "CITY", "county": "COUNTY", "state": "STATE", "zip": "ZIP"},
      meta=dict(
          id="prison_boundaries", name="Prison Boundaries", vintage=2025,
          description="Outlines of correctional facilities: federal, state and local prisons, jails, juvenile detention and immigration detention centers, with type, security level, inmate population and capacity.",
          originator="FEMA Resilience Analysis and Planning Tool (RAPT) copy of the HIFLD Prison Boundaries layer (DHS), last edited 2025-12",
          source_url=f"{FEMA}/Prison_Boundaries_RAPT/FeatureServer/1",
          keywords=["prisons", "jails", "correctional facilities", "detention centers", "penitentiaries", "incarceration"],
          columns={"name": {"as": "name", "desc": "Facility name"},
                   "type": {"as": "type", "desc": "Facility type (state, federal, county, local, multi, juvenile ...)"},
                   "status": {"as": "status", "desc": "Open or closed"},
                   "security_level": {"desc": "Security level (minimum, medium, maximum, close ...)"},
                   "population": {"desc": "Inmate population", "units": "persons"},
                   "capacity": {"desc": "Design capacity", "units": "persons"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"}},
          probe="how many prisons are in each county in Georgia"))

layer("public_health_departments",
      folder="public_health_departments", geom="point",
      url=f"{FEMA}/Public_Health_Departments_HIFLD/FeatureServer/41",
      cols={"name": "NAME", "govt_level": "GOVT_LEVEL", "address": "ADDRESS", "city": "CITY",
            "county": "COUNTY", "state": "STATE", "zip": "ZIP"},
      meta=dict(
          id="public_health_departments", name="Public Health Departments", vintage=2026,
          description="Offices of state and local public health departments and agencies, with the level of government they serve.",
          originator="FEMA National Integration Center copy of the HIFLD Open Public Health Departments layer (DHS), last edited 2026-01",
          source_url=f"{FEMA}/Public_Health_Departments_HIFLD/FeatureServer/41",
          keywords=["public health departments", "health departments", "county health department", "local health agency"],
          columns={"name": {"as": "name", "desc": "Department name"},
                   "govt_level": {"as": "type", "desc": "Level of government (state, county, city ...)"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"}},
          probe="where are the public health departments in Ohio"))

layer("urgent_care",
      folder="urgent_care_facilities", geom="point",
      url=f"{FEMA}/Urgent_Care_Facilities_RAPT/FeatureServer/11",
      cols={"name": "name", "address": "address", "city": "city", "county": "county",
            "state": "state", "zip": "zip"},
      meta=dict(
          id="urgent_care_facilities", name="Urgent Care Facilities", vintage=2025,
          description="Urgent care centers: walk-in clinics that treat illness and injury needing prompt care but not an emergency department.",
          originator="FEMA Resilience Analysis and Planning Tool (RAPT) copy of the HIFLD Urgent Care Facilities layer (DHS; Urgent Care Association member list), last edited 2025-09",
          source_url=f"{FEMA}/Urgent_Care_Facilities_RAPT/FeatureServer/11",
          keywords=["urgent care", "walk-in clinics", "urgent care centers", "immediate care"],
          columns={"name": {"as": "name", "desc": "Facility name"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"}},
          probe="how many urgent care centers are in each county in Florida"))


VHA_SVC = {"VAMC": "VA Medical Center", "HCC": "Health Care Center",
           "MSCBOC": "Multi-Specialty Community Based Outpatient Clinic",
           "PCCBOC": "Primary Care Community Based Outpatient Clinic",
           "OOS": "Other Outpatient Services", "CLC": "Community Living Center",
           "DRRTP": "Domiciliary Residential Rehabilitation Treatment Program",
           "VTCR": "Vet Center", "MVCTR": "Mobile Vet Center", "MCS": "Mobile Clinic Services"}


def _vha_type(p):
    code = clean(p.get("VHA_PRIM_SVC")).upper()
    if code in VHA_SVC:
        return VHA_SVC[code]
    for fld, lbl in (("VHA_VAH", "VA Medical Center"), ("VHA_HCC", "Health Care Center"),
                     ("VHA_MSCBOC", "Multi-Specialty Community Based Outpatient Clinic"),
                     ("VHA_PCCBOC", "Primary Care Community Based Outpatient Clinic"),
                     ("VHA_CLC", "Community Living Center"),
                     ("VHA_DRRTP", "Domiciliary Residential Rehabilitation Treatment Program"),
                     ("VHA_MVCTR", "Mobile Vet Center"), ("VHA_VCTR2", "Vet Center"),
                     ("VHA_OOS", "Other Outpatient Services")):
        if clean(p.get(fld)).upper() in ("Y", "YES", "1", "TRUE", "X"):
            return lbl
    return clean(p.get("VHA_COCCLASSIFICATIONID"))


layer("vha_facilities",
      folder="vha_facilities", geom="point",
      url=f"{HRSA}/HealthCareFacilities/VHAFacilities_FS/MapServer/0",
      cols={"name": "VHA_STA_NAME", "type": _vha_type, "station_number": "VHA_STA_NO",
            "address": "VHA_S_ADD1", "city": "VHA_S_CITY", "state": "VHA_S_STATE",
            "zip": "VHA_S_ZIP", "visn": "VHA_VISN"},
      meta=dict(
          id="vha_facilities", name="Veterans Health Administration Medical Facilities", vintage=2026,
          description="VA health care sites: VA medical centers, health care centers, community based outpatient clinics, community living centers, residential rehabilitation programs and Vet Centers.",
          originator="U.S. Department of Veterans Affairs, as published by HRSA's Health Care Facilities service (data.hrsa.gov)",
          source_url=f"{HRSA}/HealthCareFacilities/VHAFacilities_FS/MapServer/0",
          keywords=["VA hospitals", "veterans health", "VA clinics", "VA medical centers", "veterans affairs", "CBOC"],
          columns={"name": {"as": "name", "desc": "Station name"},
                   "type": {"as": "type", "desc": "Kind of VA site (VA Medical Center, Community Based Outpatient Clinic, Vet Center ...)"},
                   "station_number": {"desc": "VA station number"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"},
                   "visn": {"desc": "Veterans Integrated Service Network number"}},
          probe="how far is each county from the nearest VA medical center"))

def _ipcd(p):
    # FAC_TYPE is a numeric code with no domain in the service, so the class is derived from the
    # MODE_* flags the service does define: the most specific mode the facility serves.
    modes = [lbl for fld, lbl in (("MODE_AIR", "air"), ("MODE_FERRY", "ferry"), ("MODE_RAIL", "rail"),
                                  ("MODE_BUS", "bus"), ("MODE_BIKE", "bike share"))
             if str(p.get(fld)) == "1"]
    kind = {"air": "Airport", "ferry": "Ferry terminal", "rail": "Rail station", "bus": "Bus station",
            "bike share": "Bike share station"}.get(modes[0] if modes else "", "Other passenger facility")
    return kind, "; ".join(modes)


layer("transit_stations",
      folder="ntad_passenger_stations", geom="point",
      url=f"{NTAD}/NTAD_Intermodal_Passenger_Connectivity_Database/FeatureServer/0",
      cols={"name": "FAC_NAME", "type": lambda p: _ipcd(p)[0], "modes": lambda p: _ipcd(p)[1], "address": "ADDRESS",
            "city": "CITY", "state": "STATE", "zip": "ZIPCODE", "metro_area": "METRO_AREA"},
      meta=dict(
          id="ntad_passenger_stations", name="Public Transit and Passenger Stations", vintage=2025,
          description="Passenger transportation stations and terminals: rail transit and commuter rail stations, Amtrak stations, intercity bus and ferry terminals and airports, with the modes each serves (Intermodal Passenger Connectivity Database).",
          originator="U.S. DOT Bureau of Transportation Statistics, Intermodal Passenger Connectivity Database (successor of the HIFLD Public Transit Stations layer)",
          source_url="https://geodata.bts.gov/ (NTAD, service NTAD_Intermodal_Passenger_Connectivity_Database)",
          keywords=["transit stations", "train stations", "subway stations", "bus terminals", "ferry terminals", "intermodal stations", "commuter rail"],
          columns={"name": {"as": "name", "desc": "Facility name"},
                   "type": {"as": "type", "desc": "Facility class from the modes served: Airport, Ferry terminal, Rail station, Bus station, Bike share station"},
                   "modes": {"desc": "Passenger modes served (air, ferry, rail, bus, bike share)"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"},
                   "metro_area": {"skip": True}},
          probe="where are the train and transit stations in Illinois"))

layer("transit_routes",
      folder="ntad_transit_routes", geom="line", reduce="route",
      url=f"{NTAD}/NTAD_National_Transit_Map_Routes/FeatureServer/0",
      cols={"name": lambda p: clean(p.get("route_long_name")) or clean(p.get("route_short_name")),
            "route_number": "route_short_name", "mode": "route_type_text", "agency_ntd_id": "ntd_id"},
      meta=dict(
          id="ntad_transit_routes", name="Public Transit Routes", vintage=2026,
          description="Lines of fixed-route public transit: bus, rail, subway, light rail, streetcar and ferry routes from agency GTFS feeds, one line per route (its longest shape; branches and the reverse direction are not separate lines).",
          originator="U.S. DOT Bureau of Transportation Statistics, National Transit Map routes (successor of the HIFLD Public Transit Routes layer)",
          source_url="https://geodata.bts.gov/datasets/usdot::national-transit-map-routes",
          keywords=["transit routes", "bus routes", "rail lines", "subway lines", "public transportation"],
          include=["name", "mode"],
          columns={"name": {"as": "name", "desc": "Route name"},
                   "mode": {"as": "type", "desc": "Transit mode (Bus, Rail, Subway, Tram, Ferry ...)"}},
          probe="where are the bus routes in Missouri"))

layer("road_tunnels",
      folder="ntad_road_tunnels", geom="point",
      url=f"{NTAD}/NTAD_National_Tunnel_Inventory/FeatureServer/0",
      xy=("portal_longitude_i14", "portal_latitude_i13"),
      cols={"name": "tunnel_name_i2", "tunnel_number": "tunnel_number_i1",
            "facility_carried": "facility_carried_i10", "route_number": "route_number_i7",
            "year_built": "year_built_a1", "lanes": "total_number_of_lanes_a3",
            "average_daily_traffic": "adt_a4", "state_code": "state_code_i3"},
      meta=dict(
          id="ntad_road_tunnels", name="Road Tunnels", vintage=2025,
          description="Highway tunnels in the FHWA National Tunnel Inventory, at the tunnel portal, with the road carried, year built, lanes and average daily traffic.",
          originator="Federal Highway Administration National Tunnel Inventory, via BTS NTAD (successor of the HIFLD Road Tunnels layer)",
          source_url="https://geodata.bts.gov/ (NTAD, service NTAD_National_Tunnel_Inventory)",
          keywords=["tunnels", "road tunnels", "highway tunnels", "national tunnel inventory"],
          columns={"name": {"as": "name", "desc": "Tunnel name"},
                   "tunnel_number": {"desc": "Tunnel number in the National Tunnel Inventory"},
                   "facility_carried": {"desc": "Road carried through the tunnel"},
                   "route_number": {"desc": "Route number"},
                   "year_built": {"desc": "Year built"},
                   "lanes": {"desc": "Total number of lanes"},
                   "average_daily_traffic": {"desc": "Average daily traffic", "units": "vehicles per day"},
                   "state_code": {"skip": True}},
          probe="where are the road tunnels in Pennsylvania"))

layer("solid_waste_landfills",
      folder="solid_waste_landfills", geom="point",
      url=f"{KYREHOST}/Solid_Waste_Landfill_Facilities/FeatureServer/0",
      cols={"name": "NAME", "type": "TYPE", "status": "STATUS", "owner": "OWNER",
            "address": "ADDRESS", "city": "CITY", "county": "COUNTY", "state": "STATE", "zip": "ZIP",
            "source_date": "SOURCEDATE"},
      meta=dict(
          id="solid_waste_landfills", name="Solid Waste Landfill Facilities", vintage=2021,
          description="Solid waste disposal facilities: municipal solid waste, construction and demolition (C&D) and industrial landfills, and waste transfer stations (more than half of the records), open and closed, with type, owner and status. A 2021 snapshot of the retired HIFLD layer, compiled from state permit lists.",
          originator="HIFLD Open (DHS), 2021 release, as re-published on ArcGIS Online (owner clibby007, org HDRa0B57OVrv2E1q); HIFLD Open was retired in 2025",
          source_url=f"{KYREHOST}/Solid_Waste_Landfill_Facilities/FeatureServer/0",
          keywords=["landfills", "dumps", "solid waste", "garbage disposal sites", "waste disposal"],
          columns={"name": {"as": "name", "desc": "Landfill name"},
                   "type": {"as": "type", "desc": "Facility type: Municipal (solid waste landfill), C&D (construction and demolition landfill), Industrial, Transfer (transfer station, not a landfill), or a combination"},
                   "status": {"as": "status", "desc": "Open, closed or other status"},
                   "owner": {"as": "owner", "desc": "Owner"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"},
                   "source_date": {"skip": True}},
          probe="how many open landfills are in each county in Michigan"))

layer("supplemental_colleges",
      folder="supplemental_colleges", geom="point",
      url=f"{KYREHOST}/Supplemental_Colleges/FeatureServer/0",
      cols={"name": "NAME",
            # HIFLD college TYPE is the IPEDS control code
            "control": lambda p: {"1": "Public", "2": "Private not-for-profit", "3": "Private for-profit"}.get(clean(p.get("TYPE")), ""),
            "status": "STATUS", "address": "ADDRESS",
            "city": "CITY", "county": "COUNTY", "state": "STATE", "zip": "ZIP",
            "total_enrollment": "TOT_ENROLL", "source_date": "SOURCEDATE"},
      meta=dict(
          id="supplemental_colleges", name="Supplemental Colleges", vintage=2021,
          description="Branch, satellite, extension and center campuses of colleges and universities that IPEDS does not list as separate institutions (community college centers, university satellite campuses, early-college and correctional-facility sites), public and private. A 2021 snapshot of the retired HIFLD layer.",
          originator="HIFLD Open (DHS), 2021 release, as re-published on ArcGIS Online (owner clibby007, org HDRa0B57OVrv2E1q); HIFLD Open was retired in 2025",
          source_url=f"{KYREHOST}/Supplemental_Colleges/FeatureServer/0",
          keywords=["satellite campuses", "branch campuses", "college centers", "extension campuses", "community college sites", "postsecondary"],
          columns={"name": {"as": "name", "desc": "Campus name (institution - campus)"},
                   "control": {"as": "type", "desc": "Control: Public, Private not-for-profit or Private for-profit"},
                   "status": {"as": "status", "desc": "Status"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"},
                   "total_enrollment": {"desc": "Total enrollment", "units": "students"},
                   "source_date": {"skip": True}},
          probe="where are the satellite college campuses in North Carolina"))

layer("uranium_vanadium",
      folder="uranium_vanadium_deposits", geom="point",
      url=f"{KYREHOST}/Uranium_and_Vanadium_Deposits/FeatureServer/0",
      cols={"name": "SITE_NAME", "type": "DEP_TYPE", "status": "DEV_STAT",
            "commodities": "COM_MAJOR", "production_size": "PROD_SIZE", "operation_type": "OPER_TYPE",
            "county": "COUNTY", "state": "STATE", "mrds_id": "MRDS_ID"},
      meta=dict(
          id="uranium_vanadium_deposits", name="Uranium Vanadium Deposits", vintage=2021,
          description="Uranium and vanadium mines, prospects and occurrences from the USGS Mineral Resources Data System, with development status, deposit type and production size.",
          originator="USGS Mineral Resources Data System, via the HIFLD Open 2021 release, as re-published on ArcGIS Online (org HDRa0B57OVrv2E1q)",
          source_url=f"{KYREHOST}/Uranium_and_Vanadium_Deposits/FeatureServer/0",
          keywords=["uranium mines", "vanadium", "uranium deposits", "radioactive minerals", "mining"],
          columns={"name": {"as": "name", "desc": "Site name"},
                   "type": {"as": "type", "desc": "Deposit type"},
                   "status": {"as": "status", "desc": "Development status (producer, past producer, prospect, occurrence)"},
                   "commodities": {"desc": "Major commodities"},
                   "production_size": {"desc": "Production size class"},
                   "operation_type": {"desc": "Operation type (surface, underground ...)"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"},
                   "mrds_id": {"desc": "USGS Mineral Resources Data System record id"}},
          probe="where are the uranium mines in Utah"))

# -- uncatalogued layers ---------------------------------------------------------

layer("places_of_worship",
      folder="places_of_worship", geom="point",
      url=f"{FEMA}/All_Places_Of_Worship__HiFLD_Open_/FeatureServer/42",
      cols={"name": "NAME", "address": "STREET", "city": "CITY", "state": "STATE", "zip": "ZIP",
            "match_type": "MATCH_TYPE"},
      meta=dict(
          id="places_of_worship", name="Places of Worship", vintage=2025,
          description="Churches, synagogues, mosques, temples and other religious congregations registered as tax-exempt organizations, placed by geocoding their addresses.",
          originator="HIFLD Open All Places of Worship (DHS; from IRS exempt-organization records), as copied by FEMA, last edited 2025-09",
          source_url=f"{FEMA}/All_Places_Of_Worship__HiFLD_Open_/FeatureServer/42",
          keywords=["churches", "places of worship", "mosques", "synagogues", "temples", "congregations", "religious organizations"],
          include=["name", "address", "city", "state", "zip"],
          columns={"name": {"as": "name", "desc": "Organization name"},
                   "address": {"as": "address", "desc": "Street address"},
                   "city": {"as": "city", "desc": "City"},
                   "state": {"as": "state", "desc": "State"},
                   "zip": {"as": "zip", "desc": "ZIP code"}},
          probe="how many churches are in each county in Alabama"))


# -- power plants: built from EIA-860M, one row per plant ---------------------

EIA860M_URL = "https://www.eia.gov/electricity/data/eia860m/xls/september_generator2026.xlsx"
FUEL = {**{c: "Coal" for c in "BIT SUB LIG ANT RC WC SGC SC".split()},
        "NG": "Natural Gas", **{c: "Other Gas" for c in "OG BFG SGP PG".split()},
        "NUC": "Nuclear", "SUN": "Solar", "WND": "Wind", "WAT": "Hydroelectric",
        **{c: "Petroleum" for c in "DFO RFO JF KER PC WO RG".split()},
        "GEO": "Geothermal", "MWH": "Battery Storage",
        **{c: "Biomass" for c in "AB BLQ LFG MSB MSN MSW OBG OBL OBS SLW WDL WDS".split()}}

layer("power_plants",
      folder="eia_power_plants", geom="point", builder="eia860m", raw_ext="xlsx",
      file_url=EIA860M_URL,
      cols={"name": None, "type": None, "operator": None, "sector": None, "capacity_mw": None,
            "generators": None, "technologies": None, "plant_id": None, "county": None, "state": None},
      meta=dict(
          id="eia_power_plants", name="Power Plants", vintage=2026,
          description="Operating electric power plants of 1 MW or more, one point per plant, with primary energy source (coal, natural gas, nuclear, solar, wind, hydro ...), operator, sector and total nameplate capacity, from EIA's monthly generator inventory (September 2026).",
          originator="U.S. Energy Information Administration, Form EIA-860M Preliminary Monthly Electric Generator Inventory (successor of the HIFLD and EPA FRS Power Plants layers)",
          source_url="https://www.eia.gov/electricity/data/eia860m/",
          keywords=["power plants", "power stations", "electric generation", "coal plants", "nuclear plants", "solar farms", "wind farms", "energy infrastructure"],
          columns={"name": {"as": "name", "desc": "Plant name"},
                   "type": {"as": "type", "desc": "Primary energy source: the source with the most nameplate capacity at the plant (Coal, Natural Gas, Nuclear, Solar, Wind, Hydroelectric, Petroleum, Biomass, Geothermal, Battery Storage, Other)"},
                   "operator": {"as": "owner", "desc": "Operating entity (of the largest generator)"},
                   "sector": {"desc": "EIA sector (electric utility, independent power producer, commercial, industrial)"},
                   "capacity_mw": {"desc": "Total nameplate capacity of the plant's operating generators", "units": "MW"},
                   "generators": {"desc": "Number of operating generators"},
                   "technologies": {"desc": "Generating technologies at the plant"},
                   "plant_id": {"desc": "EIA plant id"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"}},
          not_searchable=["plant_id", "generators"],
          probe="where are the coal power plants in Kentucky"))


def eia860m_rows(path: Path) -> list[list]:
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    plants: dict = {}
    for sheet in ("Operating", "Operating_PR"):
        it = wb[sheet].iter_rows(values_only=True)
        hdr = None
        for r in it:
            if r and r[0] == "Entity ID":
                hdr = list(r)
                break
        ix = {h: i for i, h in enumerate(hdr) if h}
        for r in it:
            if not r or r[ix["Plant ID"]] in (None, ""):
                continue
            if not isinstance(r[ix["Plant ID"]], (int, float)):
                continue  # trailing notes rows
            pid = int(r[ix["Plant ID"]])
            try:
                mw = float(r[ix["Nameplate Capacity (MW)"]] or 0)
            except (TypeError, ValueError):
                mw = 0.0
            esc = clean(r[ix["Energy Source Code"]]).upper()
            fuel = FUEL.get(esc, "Other")
            if fuel == "Hydroelectric" and clean(r[ix["Prime Mover Code"]]).upper() == "PS":
                fuel = "Hydroelectric Pumped Storage"
            P = plants.setdefault(pid, {"name": clean(r[ix["Plant Name"]]), "state": clean(r[ix["Plant State"]]),
                                        "county": clean(r[ix["County"]]), "sector": clean(r[ix["Sector"]]),
                                        "lat": r[ix["Latitude"]], "lon": r[ix["Longitude"]],
                                        "fuel": {}, "tech": {}, "op": {}, "n": 0, "mw": 0.0})
            P["fuel"][fuel] = P["fuel"].get(fuel, 0) + mw
            t = clean(r[ix["Technology"]])
            P["tech"][t] = P["tech"].get(t, 0) + mw
            op = clean(r[ix["Entity Name"]])
            P["op"][op] = P["op"].get(op, 0) + mw
            P["n"] += 1
            P["mw"] += mw
    rows = []
    for pid in sorted(plants):
        P = plants[pid]
        try:
            lat, lon = round(float(P["lat"]), 7), round(float(P["lon"]), 7)
        except (TypeError, ValueError):
            continue
        top = lambda d: sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))  # noqa: E731
        rows.append([P["name"], top(P["fuel"])[0][0], top(P["op"])[0][0], P["sector"],
                     f"{P['mw']:.1f}", P["n"], "; ".join(k for k, _ in top(P["tech"])),
                     pid, P["county"], P["state"], lat, lon])
    return rows, len(plants)


# -- file downloads read through GDAL (ogr2ogr in etl-geo) ---------------------

LIVING_ATLAS = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services"

LANDSLIDE = {  # USGS OFR 97-289 attribute domain (lsoverp020.shp.xml), verbatim meaning
    "high": ("High incidence", "High landslide incidence: more than 15% of the area is involved in landsliding"),
    "mod": ("Moderate incidence", "Moderate landslide incidence: 1.5-15% of the area is involved in landsliding"),
    "low": ("Low incidence", "Low landslide incidence: less than 1.5% of the area is involved in landsliding"),
    "combo-hi": ("High susceptibility, moderate incidence", "High susceptibility to landsliding and moderate incidence"),
    "sus-high": ("High susceptibility, low incidence", "High susceptibility to landsliding and low incidence"),
    "sus-mod": ("Moderate susceptibility, low incidence", "Moderate susceptibility to landsliding and low incidence"),
    "no-data": ("No data", "No data exist for these areas"),
}

layer("landslides",
      folder="usgs_landslide_regions", geom="polygon", raw_ext="zip",
      file_url="https://stacks.stanford.edu/object/pv886qw6092",
      ogr=("/vsizip/{raw}/lsoverp020.shp", "lsoverp020"),
      cols={"type": lambda p: LANDSLIDE.get(clean(p.get("INC_SUS")), ("", ""))[0],
            "description": lambda p: LANDSLIDE.get(clean(p.get("INC_SUS")), ("", ""))[1]},
      drop_if=lambda row: row["type"] in ("", "No data"),
      meta=dict(
          id="usgs_landslide_regions", name="Landslide Incidence and Susceptibility", vintage=1997,
          description="Areas of the conterminous United States by landslide incidence (share of the area involved in landsliding) and susceptibility, from the USGS Landslide Overview Map (1:4,000,000; Radbruch-Hall and others 1982, digitized 1997). A national overview: not for site decisions.",
          originator="U.S. Geological Survey, Open-File Report 97-289 (Godt), National Atlas edition lsoverp020, via the Stanford Digital Repository",
          source_url="https://pubs.usgs.gov/publication/ofr97289B",
          keywords=["landslides", "landslide hazard", "landslide susceptibility", "slope failure", "mass wasting"],
          columns={"type": {"as": "type", "desc": "Landslide incidence or susceptibility class (High incidence, Moderate incidence, Low incidence, High susceptibility with moderate or low incidence, Moderate susceptibility with low incidence)"},
                   "description": {"desc": "Definition of the class, from the USGS metadata"}},
          probe="which counties in Pennsylvania overlap areas of high landslide incidence"))


def _pga_type(p):
    lo, hi = _pga_band(p)
    if hi is None:
        return f"{lo:g} %g or more"
    return f"under {hi:g} %g" if lo == hi or hi <= 2 else f"{lo:g}-{hi:g} %g"


# The contour levels the shapefile actually uses (distinct ACC_VAL): no 100 or 150.
PGA_LEVELS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 30, 40, 50, 60, 80, 120, 160, 200]


def _pga_band(p):
    # ACC_VAL is the contour bounding the polygon. A "valley" polygon is a local minimum inside
    # that contour, so its values lie BELOW it (USGS metadata, VALLEY domain).
    v = int(p.get("ACC_VAL") or 0)
    i = PGA_LEVELS.index(v) if v in PGA_LEVELS else None
    if str(p.get("VALLEY")) == "1":
        return (PGA_LEVELS[i - 1], v) if i else (0, PGA_LEVELS[1])
    return (v, PGA_LEVELS[i + 1] if i is not None and i + 1 < len(PGA_LEVELS) else None)


layer("seismic_hazard",
      folder="usgs_seismic_hazard_2pct50", geom="polygon", raw_ext="zip",
      file_url="https://www.sciencebase.gov/catalog/file/get/5db9be62e4b06957974eb5ca?f=__disk__61%2F6d%2F59%2F616d5946c55443ce5da351fc75817c2ae65abd3f",
      ogr=("/vsizip/{raw}/GIS Shapefiles/PGA_2pc50yrs/uspga250poly.shp", "uspga250poly"),
      cols={"type": _pga_type,
            "pga_min": lambda p: _pga_band(p)[0],
            "pga_max": lambda p: "" if _pga_band(p)[1] is None else _pga_band(p)[1]},
      meta=dict(
          id="usgs_seismic_hazard_2pct50", name="Seismic Hazard (2% in 50 years)", vintage=2014,
          description="Earthquake shaking hazard zones of the conterminous United States: peak horizontal ground acceleration with a 2% probability of being exceeded in 50 years (about once in 2,475 years), as contour bands in percent of gravity, from the 2014 USGS National Seismic Hazard Model.",
          originator="U.S. Geological Survey, Data Release for the 2014 National Seismic Hazard Model for the Conterminous U.S. (ScienceBase 5db9be62e4b06957974eb5ca)",
          source_url="https://www.sciencebase.gov/catalog/item/5db9be62e4b06957974eb5ca",
          keywords=["earthquake hazard", "seismic hazard", "ground shaking", "peak ground acceleration", "earthquake risk zones"],
          columns={"type": {"as": "type", "desc": "Peak ground acceleration band, percent of g (2% in 50 years)"},
                   "pga_min": {"desc": "Lower bound of the band: peak ground acceleration with 2% probability of exceedance in 50 years", "units": "percent of g"},
                   "pga_max": {"desc": "Upper bound of the band (blank for the highest band)", "units": "percent of g"}},
          probe="which counties have a peak ground acceleration of 40 %g or more in the seismic hazard map"))

layer("waterbodies",
      folder="usgs_waterbodies_small_scale", geom="polygon", raw_ext="tar.gz",
      file_url="https://prd-tnm.s3.amazonaws.com/StagedProducts/Small-scale/data/Hydrography/wtrbdyp010g.shp_nt00886.tar.gz",
      ogr=("/vsitar/{raw}/wtrbdyp010g.shp", "wtrbdyp010g"),
      cols={"name": "Name", "type": "Feature", "area_sq_mi": lambda p: round(float(p.get("Area_sq_mi") or 0), 3),
            "state": "State"},
      meta=dict(
          id="usgs_waterbodies_small_scale", name="Lakes, Reservoirs and Waterbodies (small scale)", vintage=2014,
          description="Lakes, reservoirs, swamps and marshes, glaciers and wide rivers of the United States at 1:1,000,000 scale (National Atlas / small-scale NHD waterbodies), with name and type.",
          originator="U.S. Geological Survey, National Map Small-Scale Collection, Waterbodies (wtrbdyp010g, 2014)",
          source_url="https://www.usgs.gov/national-map-small-scale-collection",
          keywords=["lakes", "reservoirs", "waterbodies", "ponds", "swamps", "marshes", "glaciers", "surface water"],
          columns={"name": {"as": "name", "desc": "Waterbody name"},
                   "type": {"as": "type", "desc": "Waterbody type (Lake, Reservoir, Swamp or Marsh, Glacier, Lake Intermittent, Lake Dry, Stream, Canal)"},
                   "area_sq_mi": {"desc": "Area as published", "units": "square miles"},
                   "state": {"as": "state", "desc": "State"}},
          probe="where are the largest lakes in Minnesota"))

layer("coal_fields",
      folder="usgs_coal_fields", geom="polygon",
      url=f"{LIVING_ATLAS}/USA_Coal_Fields_view/FeatureServer/0",
      cols={"name": "NAME", "type": "RANK", "province": "PROVINCE", "age": "AGE"},
      meta=dict(
          id="usgs_coal_fields", name="US Coal Fields", vintage=1996,
          description="Coal-bearing areas (coal fields) of the conterminous United States, with coal rank (anthracite, bituminous, subbituminous, lignite), geologic age and coal province, from the USGS coal fields map.",
          originator="U.S. Geological Survey coal fields of the conterminous United States (Tully 1996, OFR 96-92), as published in Esri Living Atlas",
          source_url=f"{LIVING_ATLAS}/USA_Coal_Fields_view/FeatureServer/0",
          keywords=["coal fields", "coal deposits", "coal basins", "lignite", "bituminous coal", "coal resources"],
          columns={"name": {"as": "name", "desc": "Coal field or region name"},
                   "type": {"as": "type", "desc": "Coal rank (anthracite, bituminous, subbituminous, lignite ...)"},
                   "province": {"desc": "Coal province"},
                   "age": {"desc": "Geologic age of the coal"}},
          probe="which counties in Wyoming lie over coal fields"))

layer("plate_boundaries",
      folder="plate_boundaries", geom="line",
      urls=[(f"{LIVING_ATLAS}/Plate_Boundaries/FeatureServer/0", "Ridge"),
            (f"{LIVING_ATLAS}/Plate_Boundaries/FeatureServer/1", "Transform"),
            (f"{LIVING_ATLAS}/Plate_Boundaries/FeatureServer/2", "Trench")],
      cols={"type": "_kind", "name": "geogdesc", "plates": "platecode"},
      meta=dict(
          id="plate_boundaries", name="Tectonic Plate Boundaries", vintage=2021,
          description="Boundaries between the Earth's tectonic plates: spreading ridges, transform faults and subduction trenches, worldwide.",
          originator="University of Texas Institute for Geophysics PLATES project boundaries, as published in Esri Living Atlas",
          source_url=f"{LIVING_ATLAS}/Plate_Boundaries/FeatureServer",
          keywords=["plate boundaries", "tectonic plates", "subduction zones", "fault lines", "mid-ocean ridges", "transform faults"],
          columns={"type": {"as": "type", "desc": "Boundary type: Ridge (spreading), Transform (sliding) or Trench (subduction)"},
                   "name": {"as": "name", "desc": "Geographic description of the boundary"},
                   "plates": {"desc": "Plate code"}},
          probe="which counties are within 50 miles of a tectonic plate boundary"))


def ogr_features(name: str) -> list[dict]:
    import os
    import subprocess
    L = LAYERS[name]
    raw = "/incoming/_raw/" + raw_path(name).name
    src, lyr = L["ogr"]
    cmd = ["docker", "compose", "--profile", "etl", "run", "--rm", "-T", "--entrypoint", "ogr2ogr", "etl-geo",
           "-f", "GeoJSON", "/vsistdout/", src.format(raw=raw), lyr, "-t_srs", "EPSG:4326", "-dim", "XY",
           "-makevalid", "-lco", "COORDINATE_PRECISION=6"]
    r = subprocess.run(cmd, cwd=ROOT / "deploy", capture_output=True, check=True,
                       env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    return json.loads(r.stdout)["features"]


layer("sand_gravel",
      folder="usgs_sand_gravel_operations", geom="point", builder="mineplant", raw_ext="zip",
      file_url="https://mrdata.usgs.gov/mineplant/mineplant-csv.zip",
      cols={"name": None, "company": None, "type": None, "county": None, "state": None},
      meta=dict(
          id="usgs_sand_gravel_operations", name="Sand and Gravel Operations", vintage=2003,
          description="Construction sand and gravel pits and plants in the United States from the USGS Mineral Industry Locations survey (2003 canvass), with operating company.",
          originator="U.S. Geological Survey, Active Mines and Mineral Plants in the US (mineplant), commodity Sand and Gravel; the source of the HIFLD Sand and Gravel Operations layer",
          source_url="https://mrdata.usgs.gov/mineplant/",
          keywords=["sand and gravel", "gravel pits", "sand mines", "aggregate mining", "quarries"],
          columns={"name": {"as": "name", "desc": "Site name"},
                   "company": {"as": "owner", "desc": "Operating company"},
                   "type": {"as": "type", "desc": "Mine (M) or processing plant (P), as published"},
                   "county": {"as": "county", "desc": "County"},
                   "state": {"as": "state", "desc": "State"}},
          not_searchable=["type"],  # every Sand and Gravel record in the 2003 file is a mine (M)
          probe="where are the sand and gravel operations in Minnesota"))


def mineplant_rows(path: Path):
    import io
    import zipfile
    z = zipfile.ZipFile(path)
    # The file is Latin-1 (accented place names); decided for the whole file.
    rows, n = [], 0
    for r in csv.DictReader(io.TextIOWrapper(z.open("mineplant.csv"), encoding="latin-1")):
        if r["COMMODITY"] != "Sand and Gravel":
            continue
        n += 1
        try:
            lat, lon = round(float(r["LATITUDE"]), 7), round(float(r["LONGITUDE"]), 7)
        except ValueError:
            continue
        if abs(lat) < 1e-9 and abs(lon) < 1e-9:
            continue
        kind = {"M": "Mine", "P": "Plant"}.get(clean(r["PLANT_MIN"]).upper(), clean(r["PLANT_MIN"]))
        rows.append([clean(r["SITE_NAME"]), clean(r["COMPANY_NA"]), kind, clean(r["COUNTY"]),
                     clean(r["STATE_LOCA"]), lat, lon])
    return rows, n


def _lines(g):
    return g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]


def _len_deg(g):
    import math
    t = 0.0
    for ln in _lines(g):
        for (x1, y1), (x2, y2) in zip(ln, ln[1:]):
            t += math.hypot((x2 - x1) * math.cos(math.radians((y1 + y2) / 2)), y2 - y1)
    return t


def _rdp(pts, eps):
    """Douglas-Peucker on lon/lat, eps in degrees of latitude (x scaled by cos(lat))."""
    import math
    if len(pts) < 3:
        return pts
    k = math.cos(math.radians(pts[0][1]))
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i][:2], pts[j][:2]
        dx, dy = (x2 - x1) * k, y2 - y1
        n = math.hypot(dx, dy)
        best, idx = -1.0, None
        for m in range(i + 1, j):
            px, py = (pts[m][0] - x1) * k, pts[m][1] - y1
            d = abs(dx * py - dy * px) / n if n else math.hypot(px, py)
            if d > best:
                best, idx = d, m
        if idx is not None and best > eps:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, f in zip(pts, keep) if f]


def reduce_routes(feats, eps=0.00005):
    """One feature per (feed_id, route_id): the longest shape, simplified (~5 m)."""
    best = {}
    for f in feats:
        g = f.get("geometry")
        if not g or not g.get("coordinates"):
            continue
        p = f["properties"]
        key = (p.get("feed_id"), p.get("route_id"))
        L = _len_deg(g)
        if key not in best or L > best[key][0] or (L == best[key][0] and str(p.get("shape_id")) < str(best[key][1]["properties"].get("shape_id"))):
            best[key] = (L, f)
    out, v0, v1 = [], 0, 0
    for key in sorted(best, key=lambda k: (str(k[0]), str(k[1]))):
        f = best[key][1]
        lines = []
        for ln in _lines(f["geometry"]):
            v0 += len(ln)
            s_ = _rdp([c[:2] for c in ln], eps)
            v1 += len(s_)
            if len(s_) >= 2:
                lines.append(s_)
        if lines:
            f["geometry"] = ({"type": "LineString", "coordinates": lines[0]} if len(lines) == 1
                             else {"type": "MultiLineString", "coordinates": lines})
            out.append(f)
    print(f"  routes: {len(feats):,} shapes -> {len(out):,} routes, vertices {v0:,} -> {v1:,}")
    return out


# --------------------------------------------------------------------------

def raw_path(name: str) -> Path:
    L = LAYERS[name]
    return RAW / f"supa_{name}.{L.get('raw_ext', 'geojson')}"


def fetch(name: str) -> None:
    L = LAYERS[name]
    RAW.mkdir(parents=True, exist_ok=True)
    if L.get("file_url"):
        fetch_file(L["file_url"], raw_path(name))
    elif L.get("urls"):
        # several layers of one service, merged; each feature records which one in `_kind`
        merged = []
        for url, kind in L["urls"]:
            tmp = raw_path(name).with_suffix(".part")
            fetch_arcgis(url, tmp)
            for f in json.loads(tmp.read_text(encoding="utf-8"))["features"]:
                f.setdefault("properties", {})["_kind"] = kind
                merged.append(f)
            tmp.unlink()
        raw_path(name).write_text(json.dumps({"type": "FeatureCollection", "source": [u for u, _ in L["urls"]],
                                              "fetched": time.strftime("%Y-%m-%d"), "features": merged},
                                             separators=(",", ":")), encoding="utf-8")
    else:
        fetch_arcgis(L["url"], raw_path(name), where=L.get("where", "1=1"))


def _value(p: dict, src) -> str:
    v = src(p) if callable(src) else p.get(src)
    v = clean(v)
    return _title(v) if v.isupper() and len(v) > 3 and not v.isdigit() else v


def _sidecar(L: dict, data_name: str) -> str:
    m = dict(L["meta"])
    m.setdefault("kind", "features")
    m.setdefault("license", "public domain")
    lines = [f"# {m['name']}: built by python3 etl/prep_supp_a_layers.py prep {L['_name']}",
             "# from the raw download saved by `fetch` (deploy/incoming/_raw/). Do not edit by hand:",
             "# edit the LAYERS entry in that script and re-run prep.",
             ]
    order = ["id", "name", "kind", "entity_type", "file", "vintage", "description", "originator",
             "source_url", "license", "keywords", "include", "columns", "probe"]
    m.setdefault("entity_type", "COUNTY")
    m["file"] = data_name
    # Only described, non-skipped columns become catalog rows (never latitude /
    # longitude, ids or source dates): every row is a search entry.
    m.setdefault("include", [c for c, spec in m.get("columns", {}).items()
                             if not (isinstance(spec, dict) and spec.get("skip"))
                             and c not in m.get("not_searchable", [])])
    m.pop("not_searchable", None)
    for k in order:
        if k not in m:
            continue
        v = m[k]
        if k == "columns":
            lines.append("columns:")
            for c, spec in v.items():
                lines.append(f"  {c}: {json.dumps(spec, ensure_ascii=False)}")
        else:
            lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
    return "\n".join(lines) + "\n"


def prep(name: str) -> None:
    L = LAYERS[name]
    L["_name"] = name
    folder = INCOMING / L["folder"]
    folder.mkdir(parents=True, exist_ok=True)
    cols = list(L["cols"])
    kept = nogeo = dropped = 0
    if L.get("builder") in ("eia860m", "mineplant"):
        data_name = f"{L['folder']}.csv"
        rows, n_src = (eia860m_rows if L["builder"] == "eia860m" else mineplant_rows)(raw_path(name))
        feats = range(n_src)
        nogeo = n_src - len(rows)
        with open(folder / data_name, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(cols + ["latitude", "longitude"])
            w.writerows(rows)
        kept = len(rows)
    elif L.get("ogr"):
        feats = ogr_features(name)
    else:
        raw = json.loads(raw_path(name).read_text(encoding="utf-8"))
        feats = raw["features"]
        if L.get("reduce") == "route":
            feats = reduce_routes(feats)
    if L.get("builder"):
        pass
    elif L["geom"] == "point":
        data_name = f"{L['folder']}.csv"
        rows = []
        for f in feats:
            p = f.get("properties") or {}
            if L.get("xy"):
                try:
                    ll = (round(float(p[L["xy"][1]]), 7), round(float(p[L["xy"][0]]), 7))
                    if ll[1] > 0:  # NTI stores west longitudes positive in some rows
                        ll = (ll[0], -ll[1])
                except (TypeError, ValueError, KeyError):
                    ll = None
            else:
                ll = point_of(f)
            if not ll:
                nogeo += 1
                continue
            rows.append([_value(p, L["cols"][c]) for c in cols] + [ll[0], ll[1]])
        with open(folder / data_name, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(cols + ["latitude", "longitude"])
            w.writerows(rows)
        kept = len(rows)
    else:
        data_name = f"{L['folder']}.geojson"
        out = []
        for f in feats:
            g = f.get("geometry")
            if not g or not g.get("coordinates"):
                nogeo += 1
                continue
            p = f.get("properties") or {}
            props = {c: _value(p, L["cols"][c]) for c in cols}
            if L.get("drop_if") and L["drop_if"](props):
                dropped += 1
                continue
            out.append({"type": "Feature",
                        "properties": props,
                        "geometry": {"type": g["type"], "coordinates": r6(g["coordinates"])}})
        (folder / data_name).write_text(
            json.dumps({"type": "FeatureCollection", "features": out}, separators=(",", ":"), ensure_ascii=False),
            encoding="utf-8")
        kept = len(out)
    for old in folder.glob("*.meta.yaml"):
        old.unlink()
    (folder / f"{L['folder']}.meta.yaml").write_text(_sidecar(L, data_name), encoding="utf-8")
    print(f"  {name}: {len(feats):,} source features, {kept:,} written to {folder / data_name}, "
          f"{nogeo:,} without usable geometry, {dropped:,} dropped by rule")
    for c in cols:
        vals = [r for r in (_iter_col(folder / data_name, c, L["geom"]))]
        filled = sum(1 for v in vals if v)
        distinct = len(set(vals))
        print(f"    {c:24s} filled {filled:7,} / {len(vals):,}  distinct {distinct:,}")


def _iter_col(path: Path, col: str, geom: str):
    if geom == "point":
        with open(path, encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                yield r[col]
    else:
        for f in json.loads(path.read_text(encoding="utf-8"))["features"]:
            yield f["properties"][col]


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in ("fetch", "prep", "list"):
        print(__doc__)
        return 2
    if sys.argv[1] == "list":
        for k, L in LAYERS.items():
            print(f"{k:28s} {L['folder']:28s} {L['geom']:8s} {L.get('url') or L.get('file_url')}")
        return 0
    names = list(LAYERS) if sys.argv[2:] == ["all"] else sys.argv[2:]
    for n in names:
        (fetch if sys.argv[1] == "fetch" else prep)(n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
