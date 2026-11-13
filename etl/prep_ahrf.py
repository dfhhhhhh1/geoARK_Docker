"""Prepare the HRSA Area Health Resources File (AHRF 2024-2025) for `make ingest`.

AHRF is one row per county with a column per variable AND year (`hosp_23`,
`hosp_22`). The loader keys values by a per-row year, so this reshapes the
chosen variables to one row per (county, year) and writes three folders under
deploy/incoming/, each under the 60-measure cap:

    ahrf_workforce/          physicians by specialty, NP / PA / APRN, dentists
    ahrf_facilities/         hospitals, beds, clinics, utilization, Medicare cost
    ahrf_population_health/  Medicare enrollment, births, deaths, air quality

Left out on purpose: population estimates and density (ACS already has them and
a second total-population series changes density answers), race and sex cuts,
and the long tail of ~2,300 variables nobody will ask about.

    python etl/prep_ahrf.py [AHRF_DIR] [--sidecars]
"""
import csv
import json
import re
import sys
from pathlib import Path

INC = Path(__file__).resolve().parents[1] / "deploy" / "incoming"
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
SRC = Path(ARGS[0]) if ARGS else INC / "ahrf" / "AHRF_2024-2025_CSV" / "NCHWA-2024-2025+AHRF+COUNTY+CSV"
FILES = {"HP": "AHRF2025hp.csv", "HF": "AHRF2025hf.csv", "UTL": "AHRF2025utl.csv",
         "EXP": "AHRF2025exp.csv", "POP": "AHRF2025pop.csv", "ENV": "AHRF2025env.csv"}

SPEC = {  # md_nf_<key>_all_pc
    "allergy": "allergy and immunology", "card_dis": "cardiovascular disease (cardiology)",
    "derm": "dermatology", "gastr": "gastroenterology", "genintmed": "general internal medicine",
    "ped_gen": "general pediatrics", "pulm_dis": "pulmonary disease", "gen_surg": "general surgery",
    "neuro_surg": "neurological surgery", "obgyn_gen": "obstetrics and gynecology", "ophth": "ophthalmology",
    "ortho": "orthopedic surgery", "otolryn": "otolaryngology (ear, nose and throat)", "urolgy": "urology",
    "anesth": "anesthesiology", "child_psych": "child and adolescent psychiatry",
    "diag_radlgy": "diagnostic radiology", "emerg_med": "emergency medicine", "neuro": "neurology",
    "psych": "psychiatry", "rad_oncolgy": "radiation oncology", "fammed_gen": "general family medicine",
    "all_med_spec": "all medical specialties", "all_surg_spec": "all surgical specialties",
}
WORKFORCE = [
    ("HP", "md_nf_activ", "Active M.D. physicians, non-federal (all specialties)", "physicians"),
    ("HP", "md_nf_all_pc", "M.D. physicians providing patient care, non-federal (all specialties)", "physicians"),
    ("HP", "phys_nf_prim_care_pc_exc_rsdt", "Primary care physicians providing patient care, non-federal, excluding hospital residents and those 75 or older", "physicians"),
    ("HP", "do_nf_prim_care_pc_excl_rsdnt", "D.O. primary care physicians providing patient care, non-federal, excluding hospital residents", "physicians"),
] + [("HP", f"md_nf_{k}_all_pc", f"M.D. physicians in {v} providing patient care, non-federal", "physicians")
     for k, v in SPEC.items()] + [
    ("HP", "np_npi", "Nurse practitioners with a CMS National Provider Identifier", "providers"),
    ("HP", "pa_npi", "Physician assistants with a CMS National Provider Identifier", "providers"),
    ("HP", "aprn_npi", "Advanced practice registered nurses with a CMS National Provider Identifier", "providers"),
    ("HP", "crna_npi", "Certified registered nurse anesthetists with a CMS National Provider Identifier", "providers"),
    ("HP", "apn_midwvs_npi", "Advanced practice nurse midwives with a CMS National Provider Identifier", "providers"),
    ("HP", "chiro_npi", "Chiropractors with a CMS National Provider Identifier", "providers"),
    ("HP", "opto_npi", "Optometrists with a CMS National Provider Identifier", "providers"),
    ("HP", "podtrst_npi", "Podiatrists with a CMS National Provider Identifier", "providers"),
    ("HP", "dent_npi", "Dentists with a CMS National Provider Identifier", "providers"),
    ("HP", "dent_nf_prvprac", "Dentists in private practice, non-federal", "dentists"),
]
FACILITIES = [
    ("HF", "hosp", "Total number of hospitals", "hospitals"),
    ("HF", "stgh", "Number of short-term general hospitals", "hospitals"),
    ("HF", "critcl_access_hosp", "Number of critical access hospitals", "hospitals"),
    ("HF", "stgh_resdncy_tranng", "Number of short-term general hospitals with residency training programs", "hospitals"),
    ("HF", "stgh_med_sch_affil", "Number of short-term general hospitals affiliated with a medical school", "hospitals"),
    ("HF", "stgh_obstetrc_care", "Number of hospitals with obstetric care", "hospitals"),
    ("HF", "stgh_neonat_icu", "Number of hospitals with neonatal intensive care", "hospitals"),
    ("HF", "stgh_med_surg_icu", "Number of hospitals with a medical or surgical intensive care unit", "hospitals"),
    ("HF", "stgh_psych_care", "Number of hospitals with psychiatric care", "hospitals"),
    ("HF", "stgh_burn_care", "Number of hospitals with burn care", "hospitals"),
    ("HF", "hosp_adm", "Hospital admissions, all hospitals", "admissions"),
    ("HF", "hosp_beds", "Hospital beds, all hospitals", "beds"),
    ("HF", "stgh_hosp_beds", "Hospital beds in short-term general hospitals", "beds"),
    ("HF", "hosp_licd_beds", "Licensed hospital beds, all hospitals", "beds"),
    ("HF", "hosp_nh_beds", "Nursing home beds in hospitals", "beds"),
    ("HF", "rural_hlth_clincs", "Number of Medicare-certified rural health clinics", "clinics"),
    ("HF", "comn_hlth_ctr_grants_only", "Number of federally funded community health center grantees", "centers"),
    ("HF", "home_hlth_agencs", "Number of Medicare-certified home health agencies", "agencies"),
    ("HF", "hospcs", "Number of hospices", "hospices"),
    ("HF", "comn_mentl_hlth_ctr", "Number of community mental health centers", "centers"),
    ("HF", "nhsc_activ_sites", "Number of active National Health Service Corps sites", "sites"),
    ("HF", "nhsc_fte_prim_care_provdrs", "National Health Service Corps primary care providers, full-time equivalents", "FTE"),
    ("HF", "nhsc_fte_mentl_hlth_provdr", "National Health Service Corps mental health providers, full-time equivalents", "FTE"),
    ("HF", "nhsc_fte_dent_provdrs", "National Health Service Corps dental providers, full-time equivalents", "FTE"),
    ("UTL", "hosp_inpat_dys", "Hospital inpatient days, all hospitals", "days"),
    ("UTL", "stgh_ed_vists", "Emergency department visits at short-term general hospitals", "visits"),
    ("UTL", "ed_vists_per_1k_medcr_ffs", "Emergency department visits per 1,000 Medicare fee-for-service beneficiaries", "visits per 1,000"),
    ("UTL", "stgh_outpt_vists", "Outpatient visits at short-term general hospitals", "visits"),
    ("UTL", "stgh_surg_opertn", "Surgical operations at short-term general hospitals", "operations"),
    ("UTL", "stgh_medcr_inpat_dys", "Medicare inpatient days at short-term general hospitals", "days"),
    ("UTL", "stgh_medcd_inpat_dys", "Medicaid inpatient days at short-term general hospitals", "days"),
    ("UTL", "stgh_opertng_rms", "Number of operating rooms at short-term general hospitals", "rooms"),
    ("EXP", "actl_ffs_costs", "Total actual Medicare fee-for-service costs", "dollars"),
    ("EXP", "actl_per_cap_ffs_cost", "Actual per-capita Medicare fee-for-service cost per beneficiary", "dollars per beneficiary"),
    ("EXP", "inpat_actl_ffs_cost_per_cap", "Inpatient actual per-capita Medicare fee-for-service cost per beneficiary", "dollars per beneficiary"),
]
POPHEALTH = [
    ("POP", "medcr_aged_enrolld_med", "Medicare enrollment, aged 65 and older", "enrollees"),
    ("POP", "medcr_disbld_enrolld_med", "Medicare enrollment, disabled", "enrollees"),
    ("POP", "medcr_ffs", "Medicare fee-for-service beneficiaries", "beneficiaries"),
    ("POP", "medcr_ffs_eligbl_medcd_pct", "Percent of Medicare beneficiaries also eligible for Medicaid", "percent"),
    ("POP", "medcr_ffs_hcc_score_avg", "Average HCC risk score of Medicare fee-for-service beneficiaries (higher means sicker)", "score"),
    ("POP", "medcr_adv_penet_enroll_pct", "Medicare Advantage penetration, percent of eligible beneficiaries enrolled", "percent"),
    ("POP", "medcr_pdp_penet_enroll_pct", "Medicare prescription drug plan penetration, percent enrolled", "percent"),
    ("POP", "vetn_popn_est", "Estimated number of veterans", "persons"),
    ("POP", "urban_popn_pct", "Percent of the population living in urban areas (census definition)", "percent"),
    ("POP", "pers_deep_povty_pct", "Percent of persons in deep poverty (income below 50 percent of the poverty level)", "percent"),
    ("POP", "births_3yr_avg", "Total live births, 3-year average", "births per year"),
    ("POP", "lo_birth_wgt_3yr_avg", "Low birth weight births, 3-year average", "births per year"),
    ("POP", "very_lo_birth_wgt_3yr_avg", "Very low birth weight births, 3-year average", "births per year"),
    ("POP", "births_pretrm_3yr_avg", "Preterm births, 3-year average", "births per year"),
    ("POP", "births_to_teens_3yr_lt18_avg", "Births to teen mothers under 18, 3-year average", "births per year"),
    ("POP", "birth_unmarrd_3yr_avg", "Births to unmarried mothers, 3-year average", "births per year"),
    ("POP", "inf_mort_rate_5yr_lt1_avg", "Infant mortality rate, 5-year average", "deaths per 1,000 live births"),
    ("POP", "deth_3yr_avg", "Total deaths, 3-year average", "deaths per year"),
    ("POP", "covid_deth", "COVID-19 deaths", "deaths"),
    ("ENV", "good_air_qulty_dys_pct", "Percent of days with good air quality", "percent"),
    ("ENV", "annul_partclt_mattr_2_5_avg", "Annual average fine particulate matter (PM2.5) concentration", "micrograms per cubic meter"),
    ("ENV", "dys_8_hr_ozone_over_naaqs_avg", "Days per year with 8-hour ozone above the national air quality standard, average", "days"),
    ("ENV", "desg_tox_site_ctrl", "Number of designated toxic sites under control", "sites"),
    ("ENV", "desg_tox_site_not_ctrl", "Number of designated toxic sites not under control", "sites"),
]
SETS = {"ahrf_workforce": WORKFORCE, "ahrf_facilities": FACILITIES, "ahrf_population_health": POPHEALTH}
META = {
    "ahrf_workforce": ("AHRF health workforce",
                       "Counts of physicians by specialty, nurse practitioners, physician assistants, dentists and other clinicians in each county, from the HRSA Area Health Resources File.",
                       "how many physicians are in each county"),
    "ahrf_facilities": ("AHRF health facilities and utilization",
                        "Hospitals, beds, clinics, health centers, emergency department visits, inpatient days and Medicare costs for each county, from the HRSA Area Health Resources File.",
                        "which counties have the fewest hospital beds"),
    "ahrf_population_health": ("AHRF Medicare, births, deaths and air quality",
                               "Medicare enrollment, births, low birth weight, infant mortality, deaths, air quality and toxic sites for each county, from the HRSA Area Health Resources File.",
                               "which counties have the highest infant mortality"),
}


def load(code):
    with open(SRC / FILES[code], newline="", encoding="utf-8-sig", errors="replace") as f:
        r = csv.DictReader(f)
        return r.fieldnames, list(r)


def prep(folder, measures):
    cache, out_rows, found = {}, {}, {}
    for code, base, _, _ in measures:
        if code not in cache:
            cache[code] = load(code)
        header, rows = cache[code]
        pat = re.compile(rf"^{re.escape(base)}_(\d{{2}})$")
        cols = [(h, 2000 + int(pat.match(h).group(1))) for h in header if pat.match(h)]
        if not cols:
            sys.exit(f"{folder}: no column {base}_NN in {FILES[code]}")
        found[base] = sorted({y for _, y in cols})
        for row in rows:
            fips = row["fips_st_cnty"].strip().zfill(5)
            for h, y in cols:
                v = row[h].strip()
                if v and re.fullmatch(r"-?\d+(\.\d+)?", v):
                    out_rows.setdefault((fips, y), {})[base] = v
    bases = [b for _, b, _, _ in measures]
    out = INC / folder / f"{folder}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as g:
        w = csv.writer(g)
        w.writerow(["GEOID", "YEAR"] + bases)
        for (fips, y), d in sorted(out_rows.items()):
            w.writerow([fips, y] + [d.get(b, "") for b in bases])
    yrs = sorted({y for ys in found.values() for y in ys})
    print(f"{folder}: {len(out_rows):,} county-year rows, {len(bases)} measures, years {yrs[0]}-{yrs[-1]}")


def sidecar(folder, measures):
    name, desc, probe = META[folder]
    q = json.dumps
    cols = "\n".join(f"  {b}: {{desc: {q(d)}, units: {q(u)}}}" for _, b, d, u in measures)
    (INC / folder / f"{folder}.meta.yaml").write_text(
        f"# HRSA Area Health Resources File 2024-2025 (county). Prepared by etl/prep_ahrf.py:\n"
        f"# one row per county and year, selected variables only.\n"
        f"id: {folder}\nname: {q(name)}\nkind: table\nlevel: county\ngeo_column: GEOID\n"
        f"year_column: YEAR\ndescription: {q(desc)}\n"
        f"originator: HRSA National Center for Health Workforce Analysis\n"
        f"source_url: https://data.hrsa.gov/topics/health-workforce/ahrf\nlicense: public domain\n"
        f"columns:\n{cols}\nprobe: {q(probe)}\n", encoding="utf-8")
    print("sidecar", folder)


for folder, measures in SETS.items():
    prep(folder, measures)
    if "--sidecars" in sys.argv:
        sidecar(folder, measures)
