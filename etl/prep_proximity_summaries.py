"""Prepare the GeoARK fine-point proximity summaries for `make ingest`.

Source: summarized_blocks.csv, one row per 2020 census block, made by
/scratch/US_L48GeoARK_TEMP/summarize_block.py from the 118,158,718 points in
US_L48GeoARK.gdb layer L48_All_Pt_Blk1020ZipHUC_TH_Area (2020 block centroids
plus hexagon tessellation points, lower 48). Each D_<x>_avg is the mean, over
the block's points, of the ArcGIS Near distance (metres) to the nearest <x>.

Why not the summarized_{block_groups,tracts,counties}.csv files made next to
it: summarize_eachGeo.py read Block20 with pandas, which parsed it as an
integer and dropped the leading zero for states 01-09. Their prefixes were
then taken from a 14-character string, so for AL, AZ, AR, CA, CO, CT (and the
other single-digit states) every county, tract and block group code is
shifted one digit: "county" 60730 is county 06073 split by the first tract
digit, "tract" 60730102011 is a block group. 336 of 3,159 county codes,
43,329 of 111,413 tract codes and 45,290 of 239,615 block group codes match
no unit. This script pads Block20 to 15 digits and redoes the roll-up.

Roll-up method, unchanged from summarize_eachGeo.py so the numbers mean what
they meant there: a unit's value is the UNWEIGHTED MEAN OF ITS BLOCKS' MEANS
(not weighted by points, area or population). Converted metres -> miles.

Left out on purpose:
  D_CrshStOp  identical to D_CnsMinOp in all 7,781,824 blocks (its gdb alias
              is a bare "NEAR_DIST"), so it is not a crushed-stone distance.
  D_Airport   reaches 3,189 km inside the lower 48, which fits the USACE IENC
              "Airport Areas" layer (inland waterway charts), not airports in
              general. Left out until the source layer is confirmed, so a
              "nearest airport" question cannot load it.
  F_*_list    nearest-facility id sets; not values.

    python etl/prep_proximity_summaries.py [SUMMARIZED_BLOCKS_CSV]
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
INC = APP / "deploy" / "incoming"
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else APP / "summarized_blocks.csv"
M_PER_MILE = 1609.344
DATASET_ID = "hsip_proximity"

# source code -> (output column, what the nearest thing is)
MEASURES = {
    "EMS": ("dist_ems", "emergency medical service (EMS) station"),
    "PubHealth": ("dist_public_health", "public health department"),
    "ChldCare": ("dist_child_care", "child care center"),
    "PbSchools": ("dist_public_school", "public school"),
    "Uni": ("dist_college", "college or university campus"),
    "Worship": ("dist_worship", "place of worship"),
    "PubTrans": ("dist_public_transit", "public transit route or station (HSIP public transit)"),
    "PowLines": ("dist_power_line", "electric power transmission line"),
    "SubStn": ("dist_substation", "electric substation"),
    "PowPlnts": ("dist_power_plant", "power plant"),
    "OilRef": ("dist_oil_refinery", "oil refinery (point location)"),
    "OilRefPl": ("dist_oil_refinery_site", "oil refinery site boundary (polygon)"),
    "Biodsl": ("dist_biodiesel", "biodiesel plant"),
    "ER_TRI": ("dist_tri_facility", "EPA Toxics Release Inventory (TRI) facility"),
    "ER_TSCA": ("dist_tsca_facility", "EPA Toxic Substances Control Act (TSCA) facility"),
    "SWLndfl": ("dist_landfill", "solid waste landfill"),
    "Tornado": ("dist_tornado_track", "historical tornado track"),
    "CnsMinOp": ("dist_construction_minerals", "construction minerals operation"),
    "AgrMinOp": ("dist_agricultural_minerals", "agricultural minerals operation"),
    "Abrasive": ("dist_abrasive_minerals", "refractory, abrasive or other industrial mineral operation"),
    "MiscInd": ("dist_misc_industrial_minerals", "miscellaneous industrial mineral operation"),
    "MineMnrl": ("dist_mine_mineral_site", "mine or mineral resource site (USGS MRDS)"),
    "FeMines": ("dist_ferrous_mine", "ferrous metal mine"),
    "FeMtPPln": ("dist_ferrous_processing", "ferrous metal processing plant"),
    "NonFeMtM": ("dist_nonferrous_mine", "nonferrous metal mine"),
    "NonFeMtP": ("dist_nonferrous_processing", "nonferrous metal processing plant"),
    "UrnVandD": ("dist_uranium_vanadium", "uranium and vanadium deposit"),
}
LEVELS = {  # level -> (prefix length, folder suffix, unit words)
    "county": (5, "county", "county"),
    "tract": (11, "tract", "census tract"),
    "bg": (12, "bg", "census block group"),
}


def roll_up():
    sums = {lv: defaultdict(lambda: [0.0] * len(MEASURES)) for lv in LEVELS}
    cnts = {lv: defaultdict(lambda: [0] * len(MEASURES)) for lv in LEVELS}
    n = skipped = 0
    with open(SRC, newline="", encoding="utf-8") as f:
        r = csv.reader(f)
        h = next(r)
        bi = h.index("Block20")
        idx = [h.index(f"D_{k}_avg") for k in MEASURES]
        for row in r:
            b = row[bi].strip()
            if not b.isdigit():
                skipped += 1
                continue
            b = b.zfill(15)
            vals = [(j, float(row[i])) for j, i in enumerate(idx) if row[i] != ""]
            for lv, (w, _, _) in LEVELS.items():
                key = b[:w]
                s, c = sums[lv][key], cnts[lv][key]
                for j, v in vals:
                    s[j] += v
                    c[j] += 1
            n += 1
    print(f"{SRC.name}: {n:,} blocks read, {skipped} rows without a block code skipped")
    return sums, cnts


def sidecar(level, unit):
    cols = "\n".join(
        f'  {col}: {{desc: "Average distance in miles from the {unit}\'s 2020 census blocks '
        f'to the nearest {what}", units: miles}}'
        for col, what in MEASURES.values())
    return f"""# GeoARK fine-point proximity summary. Prepared by etl/prep_proximity_summaries.py
# from summarized_blocks.csv (block means of the 118M-point US_L48GeoARK.gdb layer).
id: {DATASET_ID}
name: "GeoARK distance to nearest facility"
kind: table
level: {level}
geo_column: GEOID
vintage: 2020
description: "Average distance from where people could live to the nearest of 27 kinds of facility or hazard (EMS stations, schools, public health departments, power lines, landfills, refineries, mines, toxic release sites), lower 48 states. Computed in ArcGIS from 118 million sample points (2020 census block centroids plus a hexagon grid), averaged to each block and then over the blocks in each {unit}. Distances are planar in World Cylindrical Equal Area. Not weighted by population."
originator: GeoARK project (University of Missouri); facility layers from HSIP / HIFLD
license: research use
columns:
{cols}
probe: "which {unit}s are farthest from an EMS station"
"""


def write(sums, cnts):
    cols = [c for c, _ in MEASURES.values()]
    for lv, (_, suffix, unit) in LEVELS.items():
        d = INC / f"{DATASET_ID}_{suffix}"
        d.mkdir(parents=True, exist_ok=True)
        out = d / f"{DATASET_ID}_{suffix}.csv"
        with open(out, "w", newline="", encoding="utf-8") as g:
            w = csv.writer(g)
            w.writerow(["GEOID"] + cols)
            for key in sorted(sums[lv]):
                s, c = sums[lv][key], cnts[lv][key]
                w.writerow([key] + [f"{s[j] / c[j] / M_PER_MILE:.4f}" if c[j] else ""
                                    for j in range(len(cols))])
        (d / f"{DATASET_ID}_{suffix}.meta.yaml").write_text(sidecar(lv, unit), encoding="utf-8")
        print(f"{out.relative_to(INC)}: {len(sums[lv]):,} units, {len(cols)} measures")


if __name__ == "__main__":
    write(*roll_up())
