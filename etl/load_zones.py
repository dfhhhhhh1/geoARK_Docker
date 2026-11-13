#!/usr/bin/env python3
"""
Zone sets: a user's own analysis units, loaded as a level of geo_unit
(docs/GIS_OPS_PLAN.md H2).

A council-ward file, a neighborhood map, a forest boundary or a planning-area
layer is not a dataset to search: it is what other data is counted BY. So it
is loaded the way tracts and ZIP areas are, one geo_unit row per zone at its
own level (`z_<id>`), after which every op that already runs at a named unit
(summarize, count_features, per_area, rank, filter_*, the distance ops) runs
over it unchanged. The planner never chooses it: planner/levels.js reads the
unit from the question ("each St. Louis ward") against the registry written
here, `zone_set`.

    # deploy/incoming/stl_wards/stl_wards.meta.yaml
    id: stl_wards
    name: St. Louis wards
    kind: zones
    vintage: 2024
    zones:
      unit: ward                 # the word a question uses for one zone
      plural: wards              # default: unit + "s"
      aliases: [aldermanic ward] # other names for the same unit
      place: St. Louis           # names the question may use to pick this set
      id_column: DISTRICT        # one value per zone; duplicates are unioned
      name_column: NAME          # optional label

    make ingest DIR=stl_wards

WHAT IS COMPUTED, AND WHY

- `aland` is the zone's land area, because per_area divides by aland and a
  riverfront neighborhood measured with its river reads artificially sparse
  (the rule per_area already follows for counties). county_geom is clipped at
  coasts and the Great Lakes but NOT at rivers: St. Louis city is 171.5 km2
  of polygon for 159.9 km2 of TIGER land. So each piece of a zone inside a
  tract (clipped to county_geom) counts at that tract's land share of its
  clipped area. Exact for land/water as the tract has it, an estimate where
  a tract's water is unevenly split among zones. `awater` is the rest.
- `county_fips` / `state_fp` are the county the zone overlaps most, so
  filter_area and filter_place work at the zone level as they do at tracts.
- Population, if WorldPop is loaded: summed into each zone by the same 4x4
  sub-pixel rule as every other level (etl/load_raster.py zonal), so density
  questions have a numerator at a unit no published table has. Conservation
  is reported, not assumed: the zones' sum against the raster over the same
  footprint.

No catalog row is written, deliberately: a zone set is a unit, not a
measure, like the tract and ZIP boundaries.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

import psycopg2

LEVEL_RE = re.compile(r"^z_[a-z0-9_]{1,40}$")
TIERS = {"z9": 0.0013, "z12": 0.00017}     # as etl/load_geo_units.py
STAGE = "_zones_stage"
WORLDPOP_CODE = "WORLDPOP_POP"


def level_for(meta: dict) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", str(meta.get("id") or meta["name"]).lower()).strip("_")
    level = f"z_{base[:40]}"
    if not LEVEL_RE.match(level):
        raise SystemExit(f"\n  REFUSED: {level!r} is not a usable zone level name\n")
    return level


def config(meta: dict, fields: list[str]) -> dict:
    """The sidecar's `zones:` block, checked against the layer's columns."""
    z = dict(meta.get("zones") or {})
    unit = str(z.get("unit") or "").strip().lower()
    if not re.fullmatch(r"[a-z][a-z ]{1,38}[a-z]", unit):
        raise SystemExit("\n  REFUSED: zones.unit is required: the word a question uses for one\n"
                         "  zone (ward, neighborhood, council district). It is how a question\n"
                         "  reaches this zone set, so it cannot be guessed.\n")
    plural = str(z.get("plural") or (unit + "s")).strip().lower()
    aliases = [str(a).strip().lower() for a in (z.get("aliases") or []) if str(a).strip()]
    places = z.get("place") or []
    places = [places] if isinstance(places, str) else list(places)
    places = [str(p).strip() for p in places if str(p).strip()]
    if not places:
        raise SystemExit("\n  REFUSED: zones.place is required (e.g. \"St. Louis\"): two cities both\n"
                         "  have wards, and the place is what tells them apart.\n")
    by_lower = {f.lower(): f for f in fields}

    def col(key, required):
        name = z.get(key)
        if not name:
            if required:
                raise SystemExit(f"\n  REFUSED: zones.{key} is required. Columns: {', '.join(fields)}\n")
            return None
        hit = by_lower.get(str(name).lower())
        if hit is None:
            raise SystemExit(f"\n  REFUSED: zones.{key} {name!r} is not a column. "
                             f"Columns: {', '.join(fields)}\n")
        return hit

    return {"unit": unit, "plural": plural, "aliases": aliases, "places": places,
            "id_column": col("id_column", True), "name_column": col("name_column", False)}


def ensure_partitions(cur, level: str) -> None:
    """geo_unit and geo_values are LIST-partitioned by level; a new level needs both."""
    if not LEVEL_RE.match(level):
        raise ValueError(level)
    cur.execute(f"CREATE TABLE IF NOT EXISTS geo_unit_{level} PARTITION OF geo_unit "
                f"FOR VALUES IN ('{level}')")
    cur.execute(f"CREATE TABLE IF NOT EXISTS geo_values_{level} PARTITION OF geo_values "
                f"FOR VALUES IN ('{level}')")


def stage(dsn: str, data_path: Path, layer_name: str) -> None:
    from osgeo import gdal  # noqa: PLC0415
    gdal.UseExceptions()
    gdal.VectorTranslate(
        f"PG:{dsn}", gdal.OpenEx(str(data_path), gdal.OF_VECTOR),
        options=gdal.VectorTranslateOptions(
            format="PostgreSQL", layerName=STAGE, layers=[layer_name],
            dstSRS="EPSG:4326", reproject=True, geometryType="PROMOTE_TO_MULTI",
            accessMode="overwrite",
            layerCreationOptions=["GEOMETRY_NAME=geom", "FID=ogc_fid", "PRECISION=NO",
                                  "LAUNDER=NO"]))


def load(conn, dsn: str, data_path: Path, layer_name: str, fields: list[str],
         meta: dict, dataset_id: str, worldpop_path: Path | None) -> dict:
    cfg = config(meta, fields)
    level = level_for(meta)
    t0 = time.time()
    stage(dsn, data_path, layer_name)
    idc = cfg["id_column"]
    namec = cfg["name_column"]
    name_expr = f'max(s."{namec}"::text)' if namec else "NULL::text"
    tier = lambda t: (f"ST_Multi(ST_CollectionExtract(ST_MakeValid("
                      f"ST_SimplifyPreserveTopology(g.geom, {TIERS[t]})), 3))")
    with conn.cursor() as cur:
        ensure_partitions(cur, level)
        for t in ("geo_values", "geo_measure"):
            cur.execute(f"DELETE FROM {t} WHERE level = %s", (level,))
        cur.execute("DELETE FROM geo_unit WHERE level = %s", (level,))
        cur.execute(f'SELECT count(*), count(DISTINCT trim(s."{idc}"::text)), '
                    f'count(*) FILTER (WHERE s."{idc}" IS NULL OR trim(s."{idc}"::text) = \'\') '
                    f"FROM {STAGE} s")
        n_rows, n_ids, n_blank = cur.fetchone()
        if n_blank:
            raise SystemExit(f"\n  REFUSED: {n_blank} zones have no {idc}; every zone needs an id\n")
        # A zone id is the geoid within its level. Integers from a DBF arrive as
        # "5.00000000": trimmed to "5" so a question's "Ward 5" reads the same.
        geoid = (f"regexp_replace(trim(s.\"{idc}\"::text), '\\.0+$', '')")
        cur.execute(f"""
            WITH g AS (
              SELECT {geoid} AS geoid, {name_expr} AS name,
                     ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(s.geom)), 3)) AS geom
                FROM {STAGE} s GROUP BY 1),
            a AS (
              SELECT g.*, lnd.land, ST_Area(g.geom::geography) AS total, cty.fips, cty.state_fp
                FROM g
                CROSS JOIN LATERAL (
                  -- Land: the zone inside each tract, clipped to county_geom
                  -- (which drops coasts and the Great Lakes), scaled by that
                  -- tract's TIGER land share of its clipped area (which drops
                  -- rivers and inland water county_geom keeps).
                  SELECT COALESCE(sum(ST_Area(ST_Intersection(g.geom, tc.geom)::geography)
                           * LEAST(1, t.aland / NULLIF(ST_Area(tc.geom::geography), 0))), 0) AS land
                    FROM geo_unit t
                    CROSS JOIN LATERAL (SELECT ST_Intersection(t.geom, ST_Union(c.geom)) AS geom
                                          FROM county_geom c WHERE c.geom && t.geom) tc
                   WHERE t.level = 'tract' AND t.geom && g.geom AND ST_Intersects(t.geom, g.geom)) lnd
                LEFT JOIN LATERAL (
                  SELECT c.fips, c.state_fp FROM county_geom c
                   WHERE c.geom && g.geom AND ST_Intersects(c.geom, g.geom)
                   ORDER BY ST_Area(ST_Intersection(c.geom, g.geom)) DESC LIMIT 1) cty ON true)
            INSERT INTO geo_unit (level, geoid, name, state_fp, county_fips, aland, awater,
                                  pt, geom, geom_z9, geom_z12, source)
            SELECT %s, g.geoid, COALESCE(NULLIF(trim(g.name), ''), %s || ' ' || g.geoid),
                   g.state_fp, g.fips,
                   round(g.land)::bigint, round(greatest(g.total - g.land, 0))::bigint,
                   ST_PointOnSurface(g.geom), g.geom, {tier('z9')}, {tier('z12')}, %s
              FROM a g""", (level, cfg["unit"].title(), f"zones:{dataset_id}"))
        cur.execute("""SELECT count(*), count(*) FILTER (WHERE county_fips IS NULL),
                              sum(aland) / 1e6, sum(awater) / 1e6,
                              count(*) FILTER (WHERE NOT ST_IsValid(geom))
                         FROM geo_unit WHERE level = %s""", (level,))
        units, no_county, land_km2, water_km2, invalid = cur.fetchone()
        cur.execute("""SELECT state_fp, count(*) FROM geo_unit WHERE level = %s
                       GROUP BY 1 ORDER BY 2 DESC""", (level,))
        states = cur.fetchall()
        cur.execute(f"DROP TABLE IF EXISTS {STAGE}")
        cur.execute(f"ANALYZE geo_unit_{level}")
        cur.execute("""
            INSERT INTO zone_set (level, dataset_id, name, unit, plural, aliases, places,
                                  state_fp, n_units, vintage, source)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (level) DO UPDATE SET dataset_id = EXCLUDED.dataset_id,
              name = EXCLUDED.name, unit = EXCLUDED.unit, plural = EXCLUDED.plural,
              aliases = EXCLUDED.aliases, places = EXCLUDED.places,
              state_fp = EXCLUDED.state_fp, n_units = EXCLUDED.n_units,
              vintage = EXCLUDED.vintage, source = EXCLUDED.source, loaded_at = now()""",
            (level, dataset_id, meta["name"], cfg["unit"], cfg["plural"], cfg["aliases"],
             cfg["places"], states[0][0] if states else None, units,
             meta.get("end_year"), meta.get("source_url")))
    conn.commit()
    report = {"level": level, "units": units, "source_rows": n_rows, "ids": n_ids,
              "no_county": no_county, "invalid": invalid,
              "land_km2": round(float(land_km2 or 0), 3),
              "water_km2": round(float(water_km2 or 0), 3),
              "states": {s or "?": n for s, n in states}, "config": cfg,
              "seconds": round(time.time() - t0, 1)}
    report["population"] = zone_population(conn, dsn, level, dataset_id, worldpop_path)
    return report


def zone_population(conn, dsn: str, level: str, dataset_id: str,
                    worldpop_path: Path | None) -> dict | None:
    """WorldPop summed into each zone, with the conservation check."""
    if worldpop_path is None or not worldpop_path.exists():
        return None
    import load_raster  # noqa: PLC0415
    with conn.cursor() as cur:
        cur.execute("SELECT year, dataset_id FROM raster_layer WHERE code = %s", (WORLDPOP_CODE,))
        row = cur.fetchone()
    if not row:
        return None
    year, wp_dataset = row
    info = load_raster.inspect(worldpop_path)
    z = load_raster.zonal(conn, dsn, worldpop_path, info, level, "sum")
    load_raster.write_values(conn, level, z["values"], WORLDPOP_CODE, int(year), wp_dataset,
                             "Estimated population from the WorldPop 1 km gridded estimate",
                             "persons")
    # Conservation: the zones' total against the raster summed over the same
    # footprint by exact pixel-polygon overlap (a different method).
    with conn.cursor() as cur:
        cur.execute(f"""
            WITH fp AS (SELECT ST_Union(geom) AS geom FROM geo_unit WHERE level = %s),
            px AS (SELECT p.geom, p.val FROM raster_worldpop r, fp
                   CROSS JOIN LATERAL ST_PixelAsPolygons(r.rast) p
                   WHERE ST_Intersects(ST_ConvexHull(r.rast), fp.geom) AND p.val > 0)
            SELECT sum(px.val * ST_Area(ST_Intersection(px.geom, fp.geom)) / ST_Area(px.geom))
              FROM px, fp WHERE ST_Intersects(px.geom, fp.geom)""", (level,))
        exact = float(cur.fetchone()[0] or 0)
    total = float(sum(z["values"].values()))
    return {"code": WORLDPOP_CODE, "year": int(year), "units": z["units"],
            "covered": z["covered"], "tiny_filled": z["tiny_filled"],
            "total": round(total, 1), "exact_overlap_total": round(exact, 1),
            "relative_gap": round((total - exact) / exact, 5) if exact else None}
