"""Write the four Opportunity Atlas sidecars (descriptions and units shared by the county and tract files).

Run after etl/prep_opportunity_atlas.py. Recorded in docs/DATA_CARPENTRY.md.
"""
import json
from pathlib import Path
INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
q = json.dumps
GRP = {"pooled_pooled": "all children", "black_pooled": "Black children", "hisp_pooled": "Hispanic children",
       "white_pooled": "White children", "pooled_female": "daughters", "pooled_male": "sons"}
out = {}
for g, who in GRP.items():
    out[f"kfr_{g}_p25"] = (f"Adult household income rank of {who} who grew up in low-income households "
                           f"(parents at the 25th percentile): mean national income percentile rank around age 35, "
                           f"children born 1978-83", "percentile rank 0-1")
    out[f"jail_{g}_p25"] = (f"Incarceration rate of {who} who grew up in low-income households "
                            f"(parents at the 25th percentile): share in jail or prison on April 1, 2010", "share 0-1")
cov = {
 "hhinc_mean2000": ("Mean household income, 2000", "dollars"),
 "med_hhinc1990": ("Median household income, 1990", "dollars"),
 "med_hhinc2016": ("Median household income, 2016", "dollars"),
 "mean_commutetime2000": ("Mean commute time of workers, 2000", "minutes"),
 "traveltime15_2010": ("Share of workers with a commute under 15 minutes, 2010", "share 0-1"),
 "frac_coll_plus2000": ("Share of adults with a college degree or more, 2000", "share 0-1"),
 "frac_coll_plus2010": ("Share of adults with a college degree or more, 2010", "share 0-1"),
 "foreign_share2010": ("Share of residents born outside the US, 2010", "share 0-1"),
 "poor_share1990": ("Share of residents below the poverty line, 1990", "share 0-1"),
 "poor_share2000": ("Share of residents below the poverty line, 2000", "share 0-1"),
 "poor_share2010": ("Share of residents below the poverty line, 2010", "share 0-1"),
 "share_black2000": ("Share of residents who are Black, 2000", "share 0-1"),
 "share_white2000": ("Share of residents who are White, 2000", "share 0-1"),
 "share_hisp2000": ("Share of residents who are Hispanic, 2000", "share 0-1"),
 "share_asian2000": ("Share of residents who are Asian, 2000", "share 0-1"),
 "share_black2010": ("Share of residents who are Black, 2010", "share 0-1"),
 "share_hisp2010": ("Share of residents who are Hispanic, 2010", "share 0-1"),
 "share_asian2010": ("Share of residents who are Asian, 2010", "share 0-1"),
 "nonwhite_share2010": ("Share of residents who are not White, 2010", "share 0-1"),
 "singleparent_share1990": ("Share of households with children headed by a single parent, 1990", "share 0-1"),
 "singleparent_share2000": ("Share of households with children headed by a single parent, 2000", "share 0-1"),
 "singleparent_share2010": ("Share of households with children headed by a single parent, 2010", "share 0-1"),
 "gsmn_math_g3_2013": ("Average third-grade math test score, 2013 (standardized)", "standardized score"),
 "rent_twobed2015": ("Median monthly rent for a two-bedroom unit, 2015", "dollars"),
 "emp2000": ("Employment rate of adults, 2000", "share 0-1"),
 "mail_return_rate2010": ("Census mail return rate, 2010 (a measure of social capital)", "percent"),
 "ln_wage_growth_hs_grad": ("Growth in log wages of high school graduates, 1990 to 2010", "log points"),
 "ann_avg_job_growth_2004_2013": ("Average annual job growth rate, 2004 to 2013", "share per year"),
 "job_density_2013": ("Job density, 2013 (jobs per square mile)", "jobs per square mile"),
 "jobs_total_5mi_2015": ("Total jobs within 5 miles of the tract, 2015", "jobs"),
 "jobs_highpay_5mi_2015": ("High-paying jobs within 5 miles of the tract, 2015", "jobs"),
}
def cols(d, keys):
    return "\n".join(f"  {k}: {{desc: {q(d[k][0])}, units: {q(d[k][1])}}}" for k in keys)
def write(folder, id_, name, level, desc, keys, d, probe, vintage):
    note = ("" if level == "county" else
            " Tract values use 2010 census tract boundaries, so tracts split or merged in 2020 do not match.")
    txt = f"""# Opportunity Insights {name}. Prepared by etl/prep_opportunity_atlas.py (GEOID padded, columns selected).
id: {id_}
name: {q(name)}
kind: table
level: {level}
geo_column: GEOID
vintage: {q(vintage)}
description: {q(desc + note)}
originator: Opportunity Insights (Harvard University)
source_url: https://opportunityinsights.org/data/
license: CC BY 4.0
columns:
{cols(d, keys)}
probe: {q(probe)}
"""
    (INC / folder / f"{folder}.meta.yaml").write_text(txt, encoding="utf-8")
om = list(out)
cv = [k for k in cov if not k.startswith("jobs_")]
TRACT_JOBS = ["jobs_total_5mi_2015", "jobs_highpay_5mi_2015"]  # tract file only
mob = "Economic mobility outcomes of children who grew up in low-income households, by where they grew up, from the Opportunity Atlas (tax records, children born 1978-83)."
nb = "Neighborhood characteristics from the Opportunity Atlas: income, poverty, education, family structure, race, commuting, jobs and school scores."
write("oi_mobility_county", "oi_mobility", "Opportunity Atlas economic mobility", "county", mob, om, out, "which counties have the lowest upward mobility for low-income children", "1978-1983")
write("oi_mobility_tract", "oi_mobility", "Opportunity Atlas economic mobility", "tract", mob, om, out, "which census tracts have the lowest upward mobility for low-income children", "1978-1983")
write("oi_neighborhood_county", "oi_neighborhood", "Opportunity Atlas neighborhood characteristics", "county", nb, cv, cov, "which counties have the highest share of single-parent households", "1990-2016")
write("oi_neighborhood_tract", "oi_neighborhood", "Opportunity Atlas neighborhood characteristics", "tract", nb, cv + TRACT_JOBS, cov, "which census tracts have the highest share of single-parent households", "1990-2016")
