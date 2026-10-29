#!/usr/bin/env python3
"""
Load every analysis level's geometry into geo_unit, and build the crosswalks
between levels that do not nest.

    python3 etl/load_geo_units.py --source-dir /data/tiger                  # what it would load
    python3 etl/load_geo_units.py --source-dir /data/tiger --commit         # all levels
    python3 etl/load_geo_units.py --source-dir /data/tiger --commit --levels tract --states 29
    python3 etl/load_geo_units.py --crosswalks --commit                     # zcta<->county, zcta<->tract
    python3 etl/load_geo_units.py --verify                                  # report only

WHAT THIS IS FOR. docs/DATA_LOADING_PLAN.md, Phase 2: tracts, block groups,
ZCTAs and places become first-class analysis units, with parent keys,
pre-simplified display geometry, and area weights to the levels they do not
nest in. Nothing reads geo_unit yet; this loads and VERIFIES it, so that when
ops move onto it the geography is already known to be right.

WHY NOT place_geom. place_geom is for filtering BY a named place
("in Springfield") and holds no values. These are units that HOLD values and
get drawn, so they need parent keys, interior points and display tiers that a
filter table has no use for.

THE COUNTY VINTAGE. geo_unit's county level is copied from county_geom, not
loaded from TIGER 2026, because county_geom is what every county value in this
database is keyed on. It is an OLDER vintage than TIGER 2026: Connecticut's 8
counties (09001...) became 9 planning regions (09110...) in 2022, and
Valdez-Cordova (02261) split in 2019. A 2026 tract GEOID carries the NEW county
code, which does not exist in county_geom, so rolling those tracts up by
LEFT(geoid, 5) would drop them. Those tracts are assigned to the old county
they overlap most, and the verification reports how cleanly they fit.

SIMPLIFICATION. One copy per display zoom tier, at about half a screen pixel
of tolerance at that zoom, computed once here so no request ever simplifies.
ST_SimplifyPreserveTopology works per polygon, so neighbours can show
hairline gaps at coarse tiers. Gap-free coverage simplification needs GEOS
3.12; this database has 3.9. Display only: calculations use full geometry.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import psycopg2

try:
    from osgeo import gdal, ogr
    gdal.UseExceptions()
    ogr.UseExceptions()
except ImportError:  # pragma: no cover
    sys.exit("GDAL is required; run this in the etl-geo container.")

# Tolerance in degrees, about half a pixel at that web-map zoom at the equator
# (360 / (256 * 2^z) degrees per pixel).
TIERS = {"z6": 0.01, "z9": 0.0013, "z12": 0.00017}

# level -> (gdb stem, layer, name column preference, tiers worth storing)
#
# A tier is stored only where the level could plausibly be drawn at that zoom
# under the viewport feature budget. Nobody draws 85k tracts at z6, and a
# block group is only legible from about z12.
TIGER_LEVELS = {
    "state": ("tlgdb_2026_us_substategeo", "State", ("name",), ("z6", "z9")),
    "tract": ("tlgdb_2026_us_substategeo", "Census_Tract", ("namelsad", "name"), ("z9", "z12")),
    "bg":    ("tlgdb_2026_us_substategeo", "Block_Group", ("namelsad", "name"), ("z12",)),
    "zcta":  ("tlgdb_2026_us_nationgeo", "ZIP_Code_Tabulation_Area_5_Digit_20",
              ("zcta5ce20", "geoid20"), ("z9", "z12")),
    "place": ("tlgdb_2026_us_substategeo", "Place", ("name",), ("z9", "z12")),
}
COUNTY_TIERS = ("z6", "z9")
ORDER = ["state", "county", "tract", "bg", "zcta", "place"]
NESTS_IN_COUNTY = {"tract", "bg"}

# (from, to). Only pairs that do not nest: tract -> county is a key lookup.
CROSSWALKS = [("zcta", "county"), ("zcta", "tract")]
# A pair is dropped when it is under this share of BOTH units' area. That is a
# generalisation sliver, not a real overlap: Springfield MO is 0.0086% in
# Christian County purely because the two layers are drawn differently.
MIN_SHARE = 0.005

STAGING = "_geo_unit_staging"


def resolve_gdb(root: Path, stem: str) -> Path | None:
    """The real geodatabase: TIGER zips unzip nested, foo.gdb/foo.gdb."""
    outer = root / f"{stem}.gdb"
    for candidate in (outer / f"{stem}.gdb", outer):
        if candidate.is_dir() and any(candidate.glob("*.gdbtable")):
            return candidate
    return None


def layer_fields(gdb: Path, layer: str) -> tuple[int, set[str]] | None:
    ds = ogr.Open(str(gdb))
    if ds is None:
        return None
    lyr = ds.GetLayerByName(layer)
    if lyr is None:
        return None
    defn = lyr.GetLayerDefn()
    fields = {defn.GetFieldDefn(i).GetName().lower() for i in range(defn.GetFieldCount())}
    n = lyr.GetFeatureCount()
    ds = None
    return n, fields


def first(cols: set[str], *candidates: str) -> str | None:
    return next((c for c in candidates if c in cols), None)


def dsn() -> str:
    return (f"host={os.environ.get('PGHOST','db')} port={os.environ.get('PGPORT','5432')} "
            f"dbname={os.environ.get('PGDATABASE','mygisdb')} "
            f"user={os.environ.get('PGUSER','geoark')} "
            f"password={os.environ.get('PGPASSWORD','')}")


def tier_sql(tiers) -> tuple[str, str, str]:
    out = []
    for t in ("z6", "z9", "z12"):
        if t in tiers:
            out.append(f"ST_Multi(ST_CollectionExtract(ST_MakeValid("
                       f"ST_SimplifyPreserveTopology(g.geom, {TIERS[t]})), 3))")
        else:
            out.append("NULL")
    return tuple(out)


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #

def load_county(conn) -> int:
    """Copy county_geom: the county definition every value is keyed on."""
    z6, z9, z12 = tier_sql(COUNTY_TIERS)
    with conn.cursor() as cur:
        cur.execute("TRUNCATE geo_unit_county")
        cur.execute(f"""
            INSERT INTO geo_unit (level, geoid, name, state_fp, county_fips, aland,
                                  awater, pt, geom, geom_z6, geom_z9, geom_z12, source)
            SELECT 'county', g.fips, g.name, g.state_fp, g.fips, g.aland, g.awater,
                   ST_PointOnSurface(g.geom), g.geom, {z6}, {z9}, {z12}, 'county_geom'
              FROM (SELECT fips, name, state_fp, aland, awater,
                           ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)) AS geom
                      FROM county_geom WHERE geom IS NOT NULL) g
        """)
        n = cur.rowcount
    conn.commit()
    return n


def load_tiger(conn, gdb: Path, level: str, states: list[str] | None) -> tuple[int, int]:
    """
    Stage one TIGER layer, then copy it into its geo_unit partition.

    Returns (rows staged, rows inserted); they must match.
    """
    stem, layer, name_pref, tiers = TIGER_LEVELS[level]
    n, cols = layer_fields(gdb, layer)
    geoid = first(cols, "geoid", "geoid20", "geoid10")
    state = first(cols, "statefp", "statefp20")
    if geoid is None:
        raise SystemExit(f"  {layer}: no GEOID column (found {sorted(cols)})")

    where = None
    if states and state:
        where = f"{state.upper()} IN ({', '.join(repr(s) for s in states)})"

    t0 = time.time()
    gdal.VectorTranslate(
        f"PG:{dsn()}", str(gdb),
        options=gdal.VectorTranslateOptions(
            format="PostgreSQL", layers=[layer], layerName=STAGING,
            where=where, dstSRS="EPSG:4326", reproject=True,
            geometryType="PROMOTE_TO_MULTI", accessMode="overwrite",
            layerCreationOptions=["GEOMETRY_NAME=geom", "PRECISION=NO",
                                  "SPATIAL_INDEX=NONE"]))
    print(f"    staged in {time.time() - t0:.0f}s")

    name = first(cols, *name_pref) or geoid
    aland = first(cols, "aland", "aland20")
    awater = first(cols, "awater", "awater20")
    lat = first(cols, "intptlat", "intptlat20")
    lon = first(cols, "intptlon", "intptlon20")
    # TIGER's own interior point is better than ST_PointOnSurface: it is the
    # Census's published label point. It is a string ("+38.1234567").
    pt = (f"ST_SetSRID(ST_MakePoint({lon}::float8, {lat}::float8), 4326)"
          if lat and lon else "ST_PointOnSurface(geom)")
    state_expr = state if state else "NULL"
    z6, z9, z12 = tier_sql(tiers)

    with conn.cursor() as cur:
        if states and not state:
            # ZCTAs carry no state code. Keep those whose label point lies in
            # one of the requested states' counties.
            cur.execute(f"""
                DELETE FROM {STAGING} s WHERE NOT EXISTS (
                  SELECT 1 FROM county_geom c
                   WHERE c.state_fp = ANY(%s)
                     AND ST_Intersects(c.geom, ST_SetSRID(ST_MakePoint(
                         s.{lon}::float8, s.{lat}::float8), 4326)))""", (states,))
        cur.execute(f"SELECT count(*) FROM {STAGING} WHERE geom IS NOT NULL")
        staged = cur.fetchone()[0]

        t0 = time.time()
        if states:
            cur.execute(f"DELETE FROM geo_unit WHERE level = %s AND geoid IN "
                        f"(SELECT {geoid} FROM {STAGING})", (level,))
        else:
            cur.execute(f"TRUNCATE geo_unit_{level}")
        cur.execute(f"""
            INSERT INTO geo_unit (level, geoid, name, state_fp, aland, awater, pt,
                                  geom, geom_z6, geom_z9, geom_z12, source)
            SELECT %s, g.geoid, g.name, g.state_fp, g.aland, g.awater, g.pt,
                   g.geom, {z6}, {z9}, {z12}, %s
              FROM (SELECT {geoid} AS geoid, {name} AS name, {state_expr} AS state_fp,
                           {aland or 'NULL'}::bigint AS aland,
                           {awater or 'NULL'}::bigint AS awater,
                           {pt} AS pt,
                           ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)) AS geom
                      FROM {STAGING} WHERE geom IS NOT NULL) g
        """, (level, f"tiger2026:{layer}"))
        inserted = cur.rowcount
        print(f"    inserted + simplified in {time.time() - t0:.0f}s")

        if level in NESTS_IN_COUNTY:
            assign_county(cur, level)
        cur.execute(f"DROP TABLE IF EXISTS {STAGING}")
    conn.commit()
    return staged, inserted


def assign_county(cur, level: str) -> None:
    """
    county_fips for a nesting level: the GEOID prefix when county_geom has that
    code, otherwise the county_geom county it overlaps most (the vintage
    bridge, see the module note).
    """
    part = f"geo_unit_{level}"
    cur.execute(f"""
        UPDATE {part} u SET county_fips = LEFT(u.geoid, 5)
          FROM county_geom c WHERE c.fips = LEFT(u.geoid, 5)""")
    cur.execute(f"""
        UPDATE {part} u SET county_fips = best.fips
          FROM (SELECT u2.geoid, b.fips
                  FROM {part} u2
                  CROSS JOIN LATERAL (
                    SELECT c.fips FROM county_geom c
                     WHERE c.geom && u2.geom AND ST_Intersects(c.geom, u2.geom)
                     ORDER BY ST_Area(ST_Intersection(c.geom, u2.geom)) DESC
                     LIMIT 1) b
                 WHERE u2.county_fips IS NULL) best
         WHERE u.geoid = best.geoid""")


def build_crosswalk(conn, src: str, dst: str, states: list[str] | None) -> int:
    """
    Area weights from `src` units to `dst` units, both directions normalised.

    Shares are normalised over the area that IS covered, not over each unit's
    whole area. The two layers are drawn at different generalisations (county
    from county_geom, ZCTA from TIGER), so along a coast a ZCTA can poke a few
    percent past every county; unnormalised, its shares would sum to 0.97 and
    every rolled-up rate there would read low.
    """
    state_filter = ""
    params: list = [src, dst]
    if states:
        state_filter = "AND LEFT(b.geoid, 2) = ANY(%s)"
        params.append(states)
    t0 = time.time()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM geo_crosswalk WHERE from_level = %s AND to_level = %s"
                    + (" AND LEFT(to_geoid, 2) = ANY(%s)" if states else ""),
                    params if states else params[:2])
        cur.execute(f"""
            WITH pairs AS (
              SELECT a.geoid AS ag, b.geoid AS bg,
                     ST_Area(ST_CollectionExtract(CASE
                         WHEN ST_CoveredBy(a.geom, b.geom) THEN a.geom
                         WHEN ST_CoveredBy(b.geom, a.geom) THEN b.geom
                         ELSE ST_Intersection(a.geom, b.geom) END, 3)::geography) AS a_int
                FROM geo_unit a
                JOIN geo_unit b ON a.geom && b.geom AND ST_Intersects(a.geom, b.geom)
               WHERE a.level = %s AND b.level = %s {state_filter}
            ), shares AS (
              SELECT ag, bg, a_int,
                     a_int / NULLIF(sum(a_int) OVER (PARTITION BY ag), 0) AS raw_from,
                     a_int / NULLIF(sum(a_int) OVER (PARTITION BY bg), 0) AS raw_to
                FROM pairs WHERE a_int > 0
            ), kept AS (
              SELECT * FROM shares WHERE raw_from >= {MIN_SHARE} OR raw_to >= {MIN_SHARE}
            )
            INSERT INTO geo_crosswalk (from_level, from_geoid, to_level, to_geoid,
                                       area_m2, from_share, to_share, w_pop)
            SELECT %s, ag, %s, bg, a_int,
                   a_int / sum(a_int) OVER (PARTITION BY ag),
                   a_int / sum(a_int) OVER (PARTITION BY bg),
                   NULL
              FROM kept
        """, [src, dst] + ([states] if states else []) + [src, dst])
        n = cur.rowcount
    conn.commit()
    print(f"    {src} -> {dst}: {n:,} pairs in {time.time() - t0:.0f}s")
    return n


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #

def verify(conn, expected: dict[str, int]) -> bool:
    """Print what geo_unit holds and whether it is right. True when clean."""
    ok = True
    cur = conn.cursor()

    print("\n  level     units   expected   invalid   size")
    cur.execute("""SELECT level, count(*), count(*) FILTER (WHERE NOT ST_IsValid(geom))
                     FROM geo_unit GROUP BY level""")
    counts = {lvl: (n, bad) for lvl, n, bad in cur.fetchall()}
    for lvl in ORDER:
        if lvl not in counts:
            continue
        n, bad = counts[lvl]
        cur.execute("SELECT pg_size_pretty(pg_total_relation_size(%s))", (f"geo_unit_{lvl}",))
        size = cur.fetchone()[0]
        exp = expected.get(lvl)
        mark = "" if exp is None or exp == n else "   <-- MISMATCH"
        ok &= exp is None or exp == n
        ok &= bad == 0
        print(f"  {lvl:<7} {n:>8,} {exp if exp is not None else '-':>10} {bad:>9}   {size}{mark}")

    for lvl in sorted(NESTS_IN_COUNTY & counts.keys(), key=ORDER.index):
        cur.execute(f"""
            SELECT count(*) FILTER (WHERE county_fips IS NULL),
                   count(*) FILTER (WHERE county_fips <> LEFT(geoid, 5)),
                   count(*) FILTER (WHERE county_fips IS NOT NULL AND NOT EXISTS
                       (SELECT 1 FROM county_geom c WHERE c.fips = u.county_fips))
              FROM geo_unit_{lvl} u""")
        none, bridged, dangling = cur.fetchone()
        print(f"\n  {lvl}: {none} with no county, {bridged} assigned across the "
              f"county vintage, {dangling} pointing at a county that does not exist")
        if bridged:
            # How well do the bridged units fit inside the old county? A tract
            # that is only 60% inside it was split by the boundary change, and
            # rolling it up whole would be wrong.
            #
            # Fit is the share of the unit's overlap with ANY county that lies
            # in the assigned one, not the share of the unit's whole area.
            # county_geom is clipped at the shoreline and TIGER tracts include
            # water, so the naive ratio read 32% for coastal tracts sitting
            # entirely inside one county: a water artifact, not a split.
            cur.execute(f"""
                SELECT LEFT(f.geoid, 5), count(*), min(f.fit),
                       count(*) FILTER (WHERE f.fit < 0.9)
                  FROM (SELECT u.geoid,
                               sum(x.a) FILTER (WHERE c.fips = u.county_fips)
                                 / NULLIF(sum(x.a), 0) AS fit
                          FROM geo_unit_{lvl} u
                          JOIN county_geom c ON c.geom && u.geom AND ST_Intersects(c.geom, u.geom)
                          CROSS JOIN LATERAL (SELECT ST_Area(ST_Intersection(c.geom, u.geom)
                                                             ::geography) AS a) x
                         WHERE u.county_fips <> LEFT(u.geoid, 5) AND u.aland > 0
                         GROUP BY u.geoid) f
                 GROUP BY 1 ORDER BY 1""")
            split_total = 0
            for code, k, worst, split in cur.fetchall():
                split_total += split
                print(f"     {code}: {k:>4} land units, worst fit {worst:.1%} inside the "
                      f"old county, {split} under 90%")
            if split_total:
                print(f"     ! {split_total} units straddle an old county line; their "
                      f"county roll-up needs crosswalk weights, not the key")
        if none:
            cur.execute(f"""SELECT LEFT(geoid, 2), count(*), count(*) FILTER (WHERE aland > 0)
                              FROM geo_unit_{lvl} WHERE county_fips IS NULL
                             GROUP BY 1 ORDER BY 2 DESC""")
            rows = cur.fetchall()
            print("     unassigned by state (with land): " +
                  ", ".join(f"{s} {k} ({land})" for s, k, land in rows))
            # Water-only units (tract 99xx, aland 0) lie outside the shoreline-
            # clipped county_geom and legitimately have no county.
            ok &= all(land == 0 for _, _, land in rows)
        ok &= dangling == 0

    if {"bg", "tract"} <= counts.keys():
        cur.execute("""
            SELECT count(*) FILTER (WHERE t.geoid IS NULL),
                   count(*) FILTER (WHERE t.geoid IS NOT NULL
                                    AND t.county_fips IS DISTINCT FROM b.county_fips)
              FROM geo_unit_bg b LEFT JOIN geo_unit_tract t ON t.geoid = LEFT(b.geoid, 11)""")
        orphan, disagree = cur.fetchone()
        print(f"\n  bg -> tract: {orphan} block groups with no tract, "
              f"{disagree} whose county differs from their tract's")
        ok &= orphan == 0 and disagree == 0

    cur.execute("SELECT DISTINCT from_level, to_level FROM geo_crosswalk ORDER BY 1, 2")
    for src, dst in cur.fetchall():
        cur.execute("""
            SELECT count(*), count(DISTINCT from_geoid), count(DISTINCT to_geoid),
                   max(abs(s - 1))
              FROM (SELECT from_geoid, to_geoid,
                           sum(from_share) OVER (PARTITION BY from_geoid) AS s
                      FROM geo_crosswalk WHERE from_level = %s AND to_level = %s) x""",
                    (src, dst))
        pairs, nf, nt, err = cur.fetchone()
        cur.execute("""SELECT count(*) FROM geo_unit u WHERE u.level = %s AND NOT EXISTS
                         (SELECT 1 FROM geo_crosswalk x WHERE x.from_level = %s
                            AND x.to_level = %s AND x.from_geoid = u.geoid)""",
                    (src, src, dst))
        missing = cur.fetchone()[0]
        cur.execute("""SELECT round(avg(k), 2), max(k) FROM (SELECT count(*) AS k
                         FROM geo_crosswalk WHERE from_level = %s AND to_level = %s
                        GROUP BY from_geoid) x""", (src, dst))
        mean_k, max_k = cur.fetchone()
        print(f"\n  crosswalk {src} -> {dst}: {pairs:,} pairs, {nf:,} {src} to {nt:,} {dst}, "
              f"mean {mean_k} / max {max_k} per {src}")
        print(f"     shares sum to 1 within {err:.1e}; {missing:,} {src} units "
              f"have no {dst} at all")
        ok &= err < 1e-9

    cur.execute("SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c "
                "WHERE c.relname LIKE 'geo_unit_%' OR c.relname = 'geo_crosswalk'")
    print(f"\n  total on disk: {cur.fetchone()[0]}")
    print(f"  {'CLEAN' if ok else 'PROBLEMS ABOVE'}\n")
    cur.close()
    return ok


# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-dir", type=Path, default=Path("/data/tiger"))
    ap.add_argument("--levels", help=f"comma list, default all of {','.join(ORDER)}")
    ap.add_argument("--states", help="comma list of state FIPS, for a quick trial load")
    ap.add_argument("--crosswalks", action="store_true",
                    help="(re)build the zcta->county and zcta->tract weights")
    ap.add_argument("--verify", action="store_true", help="report only, change nothing")
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()

    levels = args.levels.split(",") if args.levels else (
        [] if args.crosswalks or args.verify else ORDER)
    bad = [l for l in levels if l not in ORDER]
    if bad:
        sys.exit(f"  unknown level(s) {bad}; expected {ORDER}")
    states = [s.zfill(2) for s in args.states.split(",")] if args.states else None

    plan, expected = [], {}
    for level in levels:
        if level == "county":
            print(f"  ready    county   from county_geom (the vintage values are keyed on)")
            plan.append((level, None))
            continue
        stem, layer, _, tiers = TIGER_LEVELS[level]
        gdb = resolve_gdb(args.source_dir, stem)
        info = layer_fields(gdb, layer) if gdb else None
        if info is None:
            print(f"  MISSING  {level:<7}  {layer} in {stem}.gdb under {args.source_dir}")
            continue
        print(f"  ready    {level:<7} {info[0]:>8,} features  {layer}  tiers {','.join(tiers)}")
        plan.append((level, gdb))

    conn = psycopg2.connect(dsn())
    with conn.cursor() as cur:
        cur.execute(Path(__file__).with_name("schema_geo.sql").read_text())
    conn.commit()

    if args.verify or not args.commit:
        if not args.commit and (plan or args.crosswalks):
            print("\n  Nothing written; re-run with --commit.")
        verify(conn, {})
        conn.close()
        return 0

    for level, gdb in plan:
        print(f"\n  loading {level} ...")
        if level == "county":
            expected["county"] = n = load_county(conn)
        else:
            staged, n = load_tiger(conn, gdb, level, states)
            if staged != n:
                print(f"    ! staged {staged:,} but inserted {n:,}")
            if not states:
                expected[level] = layer_fields(gdb, TIGER_LEVELS[level][1])[0]
        print(f"    {level}: {n:,} units")
        with conn.cursor() as cur:
            cur.execute(f"ANALYZE geo_unit_{level}")
        conn.commit()

    if args.crosswalks:
        print("\n  building crosswalks ...")
        for src, dst in CROSSWALKS:
            build_crosswalk(conn, src, dst, states)
        with conn.cursor() as cur:
            cur.execute("ANALYZE geo_crosswalk")
        conn.commit()

    clean = verify(conn, expected)
    conn.close()
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
