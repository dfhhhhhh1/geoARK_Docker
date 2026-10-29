#!/usr/bin/env python3
"""
Load a table of values keyed by a geographic unit, at ANY level.

Called by etl/ingest.py for `kind: table` (a CSV/XLSX/TSV with no geometry),
and by etl/replay.py. Not usually run directly.

    one row per unit, one column per measure ("wide"):

        FIPS,         E_TOTPOP, EP_POV150, RPL_THEMES
        01001020100,  1865,     15.1,      0.2183

WHAT DECIDES THE LEVEL. The sidecar's `level:` if given. Otherwise the length
of the unit codes, after zero-padding codes a spreadsheet stripped:
2 state, 5 county OR zcta, 7 place, 11 tract, 12 block group, 15 block.

FIVE DIGITS IS AMBIGUOUS. A county FIPS and a ZIP code are both five digits,
and plenty of codes are both (29077 is Greene County, Missouri and a ZIP in
South Carolina). Loading ZIP values as counties puts every number on the wrong
place, with nothing visibly wrong. So: the column name decides if it says
(zcta/zip vs fips/county), then MEMBERSHIP decides if it is lopsided (the codes
match one level's units almost entirely and the other's clearly less), and
otherwise the load is refused and the sidecar has to say.

WHERE VALUES GO.
  county      acs_county_values, which every existing op reads, plus a catalog
              row per measure so search can find it.
  any other   geo_values, plus geo_measure. NO catalog row: nothing can plan
              over a tract measure until ops are level-aware (Phase 6), and a
              catalog row the planner cannot use competes with ones it can.

THE COUNTY VINTAGE. county_geom predates Connecticut's 2022 planning regions
and the 2019 Valdez-Cordova split. A current county file carries 09110..09190
and 02063/02066, which county_geom does not have. Those rows are reported and
NOT loaded: a planning region is not a county here, and splitting its value
across the old counties needs weights this file does not have. The tract file
of the same release fills them, because tracts roll up to the old counties.
"""

from __future__ import annotations

import csv
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dataset_meta  # noqa: E402
from load_county_values import detect_encoding  # noqa: E402

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

LEVEL_BY_LENGTH = {2: "state", 7: "place", 11: "tract", 12: "bg", 15: "block"}
GEO_NAMES = ("geoid", "geo_id", "fips", "fips_code", "fipscode", "stcofips", "stcnty",
             "countyfips", "county_fips", "tractfips", "tract_fips", "zcta5", "zcta",
             "zcta5ce20", "zip", "zipcode", "zip_code", "locationid", "bg_fips", "geoid20")
ZCTA_HINT = re.compile(r"zcta|zip", re.I)
COUNTY_HINT = re.compile(r"cnty|county|stcofips|^fips$|fips_code|fipscode", re.I)
# Columns that are identifiers or labels, never measures, even when they parse
# as numbers: ST "01" and STCNTY "01001" are perfectly good floats.
NOT_MEASURE = re.compile(
    r"^(st|state|st_abbr|stcnty|cnty|county|countyfp|statefp|tractce|blkgrpce|"
    r"fips|geoid|geo_id|geoidfq|zcta5?|zcta5ce20|zip|zipcode|tract|blkgrp|place|"
    r"location|locationname|name|objectid|fid|id|year|lat|lon|latitude|longitude)$", re.I)

# Missing-value sentinels: SVI writes -999, ACS annotates with -666666666 and
# friends. Loaded as numbers, -999 is a percentile three orders of magnitude
# below zero and drags every mean it touches. The sidecar's `missing:` adds to
# these.
SENTINELS = {-999.0, -9999.0, -666666666.0, -888888888.0, -999999999.0,
             -222222222.0, -333333333.0, -555555555.0}

# Wide releases bloat the corpus, which is what limits retrieval. Past this
# many measure columns the sidecar must narrow them (include/exclude) or the
# load must say --allow-wide.
WIDE_LIMIT = 50

# A county measure below this many counties cannot answer a national question,
# so it is loaded but not put in the catalog (same gate as load_county_values).
MIN_COUNTIES = 500


# --------------------------------------------------------------------------- #
# reading
# --------------------------------------------------------------------------- #

def read_rows(path: Path) -> tuple[list[str], list[list[str]]]:
    """Header and rows of a CSV / TSV / TXT / XLSX / Census-API JSON file."""
    suf = path.suffix.lower()
    if suf in (".xlsx", ".xlsm"):
        import openpyxl  # noqa: PLC0415
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.worksheets[0]
        it = ws.iter_rows(values_only=True)
        header = [str(h or "").strip() for h in next(it)]
        rows = [["" if v is None else str(v) for v in r] for r in it]
        return header, rows
    if suf == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if not (isinstance(data, list) and data and isinstance(data[0], list)):
            raise SystemExit(f"\n  REFUSED: {path.name} is JSON but not a Census-API "
                             f"style table (a list of rows, header first)\n")
        return [str(h) for h in data[0]], [["" if v is None else str(v) for v in r]
                                           for r in data[1:]]
    enc = detect_encoding(path)
    with path.open(encoding=enc, newline="") as fh:
        sample = fh.read(65536)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t|;")
        except csv.Error:
            dialect = csv.excel
        rd = csv.reader(fh, dialect)
        header = [h.strip().lstrip("﻿") for h in next(rd)]
        rows = [r for r in rd if any(c.strip() for c in r)]
    return header, rows


def is_census_json(path: Path) -> bool:
    if path.suffix.lower() != ".json":
        return False
    try:
        with path.open(encoding="utf-8") as fh:
            head = fh.read(4096).lstrip()
        return head.startswith("[[") or head.startswith("[ [")
    except OSError:
        return False


def to_float(raw: str, missing: set[float]) -> float | None:
    s = (raw or "").strip().replace(",", "").replace("$", "").replace("%", "")
    if s in ("", ".", "NA", "N/A", "null", "None", "*", "**", "-", "(X)"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if math.isnan(v) or math.isinf(v) or v in missing:
        return None
    return v


def clean_geoid(raw: str) -> str:
    """Digits only. Census GEO_IDs ("1400000US29077000100") keep what follows US."""
    s = (raw or "").strip()
    if "US" in s:
        s = s.split("US", 1)[1]
    return re.sub(r"[^0-9]", "", s)


# --------------------------------------------------------------------------- #
# deciding
# --------------------------------------------------------------------------- #

def pick_geo_column(header: list[str], rows: list[list[str]], meta: dict) -> int:
    if meta.get("geo_column"):
        want = meta["geo_column"].lower()
        for i, h in enumerate(header):
            if h.lower() == want:
                return i
        raise SystemExit(f"\n  REFUSED: geo_column {meta['geo_column']!r} is not a column. "
                         f"Columns: {', '.join(header[:20])}\n")
    lower = [h.lower() for h in header]
    for name in GEO_NAMES:
        if name in lower:
            return lower.index(name)
    raise SystemExit("\n  REFUSED: no column looks like a geographic code (FIPS, GEOID,\n"
                     "  ZCTA5 ...). Name it with  geo_column:  in the sidecar.\n")


def normalise_codes(raw: list[str]) -> tuple[list[str], int]:
    """
    Codes zero-padded to the file's own width.

    A spreadsheet turns 01001 into 1001. The width is the most common length
    among the longest codes, and only codes ONE digit short are padded: a code
    two digits short is not a dropped leading zero, it is a different level.
    """
    codes = [clean_geoid(c) for c in raw]
    lengths = Counter(len(c) for c in codes if c)
    if not lengths:
        raise SystemExit("\n  REFUSED: the geographic column is empty\n")
    width = max(lengths, key=lambda L: (lengths[L] + lengths.get(L - 1, 0), L))
    return [c.zfill(width) if len(c) == width - 1 else c for c in codes], width


def decide_level(meta: dict, column: str, codes: list[str], width: int, conn) -> tuple[str, str]:
    """(level, how it was decided). Refuses rather than guess between county and ZCTA."""
    if meta.get("level"):
        return meta["level"], "sidecar"
    if width in LEVEL_BY_LENGTH:
        return LEVEL_BY_LENGTH[width], f"{width}-digit codes"
    if width != 5:
        raise SystemExit(f"\n  REFUSED: {width}-digit codes match no level. Set  level:  in "
                         f"the sidecar.\n")
    if ZCTA_HINT.search(column):
        return "zcta", f"column name {column!r}"
    if COUNTY_HINT.search(column):
        return "county", f"column name {column!r}"
    uniq = {c for c in codes if c}
    with conn.cursor() as cur:
        cur.execute("SELECT fips FROM county_geom")
        counties = {r[0] for r in cur.fetchall()}
        cur.execute("SELECT geoid FROM geo_unit WHERE level = 'zcta'")
        zctas = {r[0] for r in cur.fetchall()}
    c_rate = len(uniq & counties) / len(uniq)
    z_rate = len(uniq & zctas) / len(uniq)
    how = f"membership: {c_rate:.0%} match counties, {z_rate:.0%} match ZCTAs"
    if c_rate >= 0.9 and z_rate <= 0.7:
        return "county", how
    if z_rate >= 0.9 and c_rate <= 0.7:
        return "zcta", how
    raise SystemExit(f"\n  REFUSED: 5-digit codes could be counties or ZCTAs ({how}).\n"
                     f"  Loading ZIP values as counties puts every number on the wrong\n"
                     f"  place, so set  level: county  or  level: zcta  in the sidecar.\n")


def code_for(meta: dict, column: str) -> str:
    """
    The measure code. Default "<ID>_<COLUMN>" upper-cased; `code_rewrite`
    (a list of [regex, replacement]) can map a column onto an EXISTING measure
    code instead, so one measure carries values at several levels.
    """
    for pattern, repl in meta.get("code_rewrite") or []:
        if re.search(pattern, column):
            return re.sub(pattern, repl, column)
    base = re.sub(r"[^A-Za-z0-9]+", "_", str(meta.get("id") or meta["name"])).strip("_").upper()
    col = re.sub(r"[^A-Za-z0-9]+", "_", column).strip("_").upper()
    return f"{base[:20]}_{col}"[:60]


def measure_columns(header, rows, geo_idx, meta, missing) -> tuple[list[int], list[str]]:
    """Columns that hold numbers: >= 95% of non-empty cells parse."""
    year_col = (meta.get("year_column") or "").lower()
    keep, dropped_text = [], []
    for i, h in enumerate(header):
        if i == geo_idx or not h or h.lower() == year_col or NOT_MEASURE.match(h):
            continue
        if not dataset_meta.column_selected(meta, h):
            continue
        cells = [r[i] for r in rows[:2000] if i < len(r) and r[i].strip()]
        if not cells:
            continue
        # Parsed WITHOUT the sentinel set: a -999 is still a number for the
        # purpose of deciding whether the column is numeric.
        ok = sum(1 for c in cells if to_float(c, set()) is not None)
        if ok / len(cells) >= 0.95:
            keep.append(i)
        else:
            dropped_text.append(h)
    return keep, dropped_text


# --------------------------------------------------------------------------- #
# the plan, then the write
# --------------------------------------------------------------------------- #

def plan(path: Path, meta: dict, conn, allow_wide: bool = False) -> dict:
    """Everything about the load, decided, with nothing written."""
    header, rows = read_rows(path)
    missing = SENTINELS | {float(x) for x in (meta.get("missing") or [])}
    geo_idx = pick_geo_column(header, rows, meta)
    codes, width = normalise_codes([r[geo_idx] if geo_idx < len(r) else "" for r in rows])
    level, how = decide_level(meta, header[geo_idx], codes, width, conn)

    cols, text_cols = measure_columns(header, rows, geo_idx, meta, missing)
    if not cols:
        raise SystemExit("\n  REFUSED: no numeric measure columns after include/exclude\n")
    if len(cols) > WIDE_LIMIT and not allow_wide:
        raise SystemExit(
            f"\n  REFUSED: {len(cols)} measure columns. Every one becomes a search\n"
            f"  entry, and corpus size is what limits retrieval quality. Narrow them\n"
            f"  with  include: / exclude:  in the sidecar, or pass --allow-wide.\n")

    year_idx = None
    if meta.get("year_column"):
        lower = [h.lower() for h in header]
        if meta["year_column"].lower() not in lower:
            raise SystemExit(f"\n  REFUSED: year_column {meta['year_column']!r} not found\n")
        year_idx = lower.index(meta["year_column"].lower())
    fixed_year = meta.get("end_year")
    if year_idx is None and not fixed_year:
        raise SystemExit("\n  REFUSED: no year. Values are keyed by year; give  vintage:\n"
                         "  (e.g. 2022, or 2018-2022, dated by its END year as ACS does)\n"
                         "  or  year_column:  in the sidecar.\n")

    known = unit_codes(conn, level)
    matched = {c for c in codes if c in known}
    unmatched = sorted({c for c in codes if c and c not in known})

    measures = []
    for i in cols:
        h = header[i]
        spec = dataset_meta.column_meta(meta, h)
        measures.append({"col": i, "column": h, "code": code_for(meta, h),
                         "label": spec.get("desc") or h, "units": spec.get("units") or ""})
    # A column mapped onto an EXISTING measure code (code_rewrite) borrows that
    # measure's description, so "ACCESS2_CrudePrev" at ZCTA level reads the
    # same as the county measure it is the same thing as.
    with conn.cursor() as cur:
        cur.execute("SELECT attr_id, description FROM attribute_source WHERE attr_id = ANY(%s)",
                    ([m["code"] for m in measures],))
        existing = dict(cur.fetchall())
    for m in measures:
        if m["label"] == m["column"] and existing.get(m["code"]):
            m["label"] = existing[m["code"]]
    dupes = [c for c, n in Counter(m["code"] for m in measures).items() if n > 1]
    if dupes:
        raise SystemExit(f"\n  REFUSED: two columns map to the same code: {dupes[:5]}\n")

    return {"path": path, "header": header, "rows": rows, "geo_idx": geo_idx,
            "codes": codes, "width": width, "level": level, "level_how": how,
            "measures": measures, "text_cols": text_cols, "year_idx": year_idx,
            "fixed_year": fixed_year, "missing": missing,
            "matched": matched, "unmatched": unmatched, "n_known": len(known)}


def unit_codes(conn, level: str) -> set[str]:
    with conn.cursor() as cur:
        if level == "county":
            cur.execute("SELECT fips FROM county_geom")
        else:
            cur.execute("SELECT geoid FROM geo_unit WHERE level = %s", (level,))
        return {r[0].strip() for r in cur.fetchall()}


def describe_plan(p: dict) -> None:
    n_rows, n_codes = len(p["rows"]), len({c for c in p["codes"] if c})
    print(f"  level      {p['level']}  ({p['level_how']})")
    print(f"  geo column {p['header'][p['geo_idx']]}  ({p['width']}-digit codes)")
    print(f"  rows       {n_rows:,}  ({n_codes:,} distinct units)")
    print(f"  match      {len(p['matched']):,} of {n_codes:,} units exist at this level "
          f"({p['n_known']:,} known)")
    if p["unmatched"]:
        ex = ", ".join(p["unmatched"][:10])
        print(f"  ! {len(p['unmatched'])} codes match no {p['level']} and will be skipped: {ex}"
              f"{' ...' if len(p['unmatched']) > 10 else ''}")
        ct = [c for c in p["unmatched"] if c[:3] in ("091",) or c in ("02063", "02066")]
        if p["level"] == "county" and ct:
            print(f"    {len(ct)} of them are the newer county vintage (CT planning regions,\n"
                  f"    Valdez-Cordova split) that county_geom predates. Load the tract file\n"
                  f"    of the same release to fill those counties.")
    yr = f"column {p['header'][p['year_idx']]}" if p["year_idx"] is not None \
        else str(p["fixed_year"])
    print(f"  year       {yr}")
    print(f"  measures   {len(p['measures'])}"
          + (f"   ({len(p['text_cols'])} text columns skipped: "
             f"{', '.join(p['text_cols'][:4])}{' ...' if len(p['text_cols']) > 4 else ''})"
             if p["text_cols"] else ""))
    for m in p["measures"][:10]:
        print(f"     {m['column']:<22} -> {m['code']:<30} {m['label'][:40]}")
    if len(p["measures"]) > 10:
        print(f"     ... and {len(p['measures']) - 10} more")


def values(p: dict):
    """(geoid, code, year, value) for every matched unit and parsed value."""
    for r, code in zip(p["rows"], p["codes"]):
        if code not in p["matched"]:
            continue
        if p["year_idx"] is not None:
            ys = dataset_meta.YEAR_RE.findall(r[p["year_idx"]] if p["year_idx"] < len(r) else "")
            if not ys:
                continue
            year = int(ys[-1])
        else:
            year = int(p["fixed_year"])
        for m in p["measures"]:
            i = m["col"]
            v = to_float(r[i], p["missing"]) if i < len(r) else None
            if v is not None:
                yield code, m["code"], year, v


def write_values(conn, p: dict, dataset_id: str, replace_codes: list[str] | None) -> dict:
    """
    Values, geo_measure, and (county only) attribute_source, in ONE transaction.

    Returns per-measure stats for the catalog step. `replace_codes` are this
    dataset's codes from a previous load, deleted first so a narrowed include
    list does not leave stale measures behind.
    """
    from psycopg2.extras import execute_values  # noqa: PLC0415
    level = p["level"]
    county = level == "county"
    rows = list(values(p))
    stats: dict[str, dict] = {}
    for g, code, year, _ in rows:
        s = stats.setdefault(code, {"units": set(), "years": set()})
        s["units"].add(g)
        s["years"].add(year)

    with conn.cursor() as cur:
        if replace_codes:
            if county:
                cur.execute("DELETE FROM acs_county_values WHERE census_code = ANY(%s)",
                            (replace_codes,))
            else:
                cur.execute("DELETE FROM geo_values WHERE level = %s AND code = ANY(%s)",
                            (level, replace_codes))
            cur.execute("DELETE FROM geo_measure WHERE dataset_id = %s AND level = %s",
                        (dataset_id, level))
        if county:
            execute_values(cur, """
                INSERT INTO acs_county_values (fips, census_code, year, value) VALUES %s
                ON CONFLICT (fips, census_code, year) DO UPDATE SET value = EXCLUDED.value
            """, rows, page_size=10_000)
        else:
            execute_values(cur, """
                INSERT INTO geo_values (geoid, code, year, value, level) VALUES %s
                ON CONFLICT (level, geoid, code, year) DO UPDATE SET value = EXCLUDED.value
            """, [(g, c, y, v, level) for g, c, y, v in rows], page_size=10_000)

        by_code = {m["code"]: m for m in p["measures"]}
        execute_values(cur, """
            INSERT INTO geo_measure (code, level, dataset_id, label, description, units,
                                     min_year, max_year, n_units) VALUES %s
            ON CONFLICT (code, level) DO UPDATE SET
              dataset_id = EXCLUDED.dataset_id, label = EXCLUDED.label,
              description = EXCLUDED.description, units = EXCLUDED.units,
              min_year = EXCLUDED.min_year, max_year = EXCLUDED.max_year,
              n_units = EXCLUDED.n_units
        """, [(c, level, dataset_id, by_code[c]["column"], by_code[c]["label"],
               by_code[c]["units"] or None, min(s["years"]), max(s["years"]), len(s["units"]))
              for c, s in stats.items()])

        if county:
            # Live immediately, without waiting for a relink. relink rebuilds
            # the same rows from the catalog (attr_label = code), see
            # load_reference_data.build_attribute_source.
            execute_values(cur, """
                INSERT INTO attribute_source (attr_id, dataset_id, description, source_kind,
                                              table_name, value_column, census_code, entity_type)
                VALUES %s
                ON CONFLICT (attr_id) DO UPDATE SET description = EXCLUDED.description,
                                                   census_code = EXCLUDED.census_code
            """, [(c, dataset_id, by_code[c]["label"], "acs_long", "acs_county_values",
                   None, c, "COUNTY")
                  for c, s in stats.items() if len(s["units"]) >= MIN_COUNTIES])
    conn.commit()
    return {"rows": len(rows), "measures": {
        c: {"units": len(s["units"]), "min_year": min(s["years"]), "max_year": max(s["years"])}
        for c, s in stats.items()}}
