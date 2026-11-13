"""Prepare Opportunity Insights Opportunity Atlas CSVs for `make ingest`.

The raw files carry state, county and tract as separate unpadded integers
(`1,1,20100`), so no geo column is usable as it stands. This writes four
folders under deploy/incoming/, each with a GEOID column (5-digit county,
11-digit tract) and only the columns the sidecars describe:

    oi_mobility_county/   oi_mobility_tract/      outcomes, p25 parents
    oi_neighborhood_county/  oi_neighborhood_tract/  neighborhood covariates

Left out on purpose: *_se and *_count columns, race-by-gender cuts (mostly
empty at tract level), Asian/other groups, and popdensity (it would compete
with total population for "population density" questions).

    python etl/prep_opportunity_atlas.py [SRC_DIR]
"""
import csv
import sys
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else INC / "opportunity_insights_atlas"

OUTCOMES = [f"{m}_{g}_p25" for m in ("kfr", "jail")
            for g in ("pooled_pooled", "black_pooled", "hisp_pooled", "white_pooled",
                      "pooled_female", "pooled_male")]
COVARIATES = [
    "hhinc_mean2000", "med_hhinc1990", "med_hhinc2016", "mean_commutetime2000",
    "traveltime15_2010", "frac_coll_plus2000", "frac_coll_plus2010",
    "foreign_share2010", "poor_share1990", "poor_share2000", "poor_share2010",
    "share_black2000", "share_white2000", "share_hisp2000", "share_asian2000",
    "share_black2010", "share_hisp2010", "share_asian2010", "nonwhite_share2010",
    "singleparent_share1990", "singleparent_share2000", "singleparent_share2010",
    "gsmn_math_g3_2013", "rent_twobed2015", "emp2000", "mail_return_rate2010",
    "ln_wage_growth_hs_grad", "ann_avg_job_growth_2004_2013", "job_density_2013",
]
TRACT_ONLY = ["jobs_total_5mi_2015", "jobs_highpay_5mi_2015"]


def geoid(row, tract):
    s, c = int(row["state"]), int(row["county"])
    if tract:
        return f"{s:02d}{c:03d}{int(row['tract']):06d}"
    return f"{s:02d}{c:03d}"


def prep(src, out, keep, tract):
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(src, newline="", encoding="utf-8") as f, \
            open(out, "w", newline="", encoding="utf-8") as g:
        r = csv.DictReader(f)
        missing = [c for c in keep if c not in r.fieldnames]
        if missing:
            sys.exit(f"{src.name}: columns not found: {missing}")
        w = csv.writer(g)
        w.writerow(["GEOID"] + keep)
        for row in r:
            if not row["state"] or not row["county"] or (tract and not row["tract"]):
                continue
            w.writerow([geoid(row, tract)] + [row[c] for c in keep])
            n += 1
    print(f"{out.relative_to(INC)}: {n:,} rows, {len(keep)} measures")


prep(SRC / "county_outcomes_simple.csv", INC / "oi_mobility_county/oi_mobility_county.csv", OUTCOMES, False)
prep(SRC / "tract_outcomes_simple.csv", INC / "oi_mobility_tract/oi_mobility_tract.csv", OUTCOMES, True)
prep(SRC / "cty_covariates.csv", INC / "oi_neighborhood_county/oi_neighborhood_county.csv", COVARIATES, False)
prep(SRC / "tract_covariates.csv", INC / "oi_neighborhood_tract/oi_neighborhood_tract.csv", COVARIATES + TRACT_ONLY, True)
