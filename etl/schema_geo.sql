-- Multi-level geography: the storage half of docs/DATA_LOADING_PLAN.md.
--
-- Everything else in the database keys a value by a county FIPS code. These
-- tables key it by (level, geoid), so a tract, block group, ZCTA, place or grid
-- cell can hold values and be computed on and drawn, without changing what a
-- county is.
--
-- NOTHING READS THESE YET. county_geom, place_geom and acs_county_values are
-- untouched, every op still compiles against them, and the planner prompt is
-- unchanged. That is deliberate: the geography is loaded and verified first,
-- and ops move onto it one at a time, each measured.
--
-- Idempotent. Safe to run on every load.

-- ------------------------------------------------------------ geo_unit
-- One row per analysis unit at every level.
--
-- PARTITIONED BY LEVEL because the levels differ by ~30x each (county 3k,
-- tract 85k, block group 240k, block 8M). A county lookup must never scan
-- block rows, and each partition gets its own GIST index sized to it.
CREATE TABLE IF NOT EXISTS geo_unit (
    level        TEXT NOT NULL,     -- state | county | tract | bg | zcta | place | block | grid*
    geoid        TEXT NOT NULL,     -- Census GEOID, or a grid cell id
    name         TEXT,
    state_fp     CHAR(2),
    -- The county this unit rolls up to, as county_geom spells it. Tracts, block
    -- groups and blocks nest inside a county, so rolling up is a key lookup,
    -- not a spatial join. NULL for levels that do not nest (zcta, place): those
    -- go through geo_crosswalk.
    --
    -- NOT ALWAYS LEFT(geoid, 5). county_geom is an older county vintage than
    -- TIGER 2026: Connecticut's 8 counties became 9 planning regions in 2022,
    -- and Valdez-Cordova split in 2019. A 2026 tract GEOID carries the NEW
    -- county code, which does not exist in county_geom. load_geo_units.py
    -- assigns those tracts to the old county that contains them.
    county_fips  CHAR(5),
    aland        BIGINT,            -- land area, m^2: per_area divides by this
    awater       BIGINT,
    pt           geometry(Point, 4326),         -- interior point (labels, distances)
    geom         geometry(MultiPolygon, 4326),  -- full resolution: calculations use this
    -- Pre-simplified copies for drawing at a zoom tier. Simplified once at load
    -- time, never per request. NULL means "not useful at that tier" (nobody
    -- draws 85k tracts at a national zoom): the display falls back to the next
    -- finer tier, then to geom.
    geom_z6      geometry(MultiPolygon, 4326),
    geom_z9      geometry(MultiPolygon, 4326),
    geom_z12     geometry(MultiPolygon, 4326),
    source       TEXT,              -- e.g. 'tiger2026:Census_Tract', 'county_geom'
    PRIMARY KEY (level, geoid)
) PARTITION BY LIST (level);

-- Partitions for the levels loaded so far. A level without a partition cannot
-- be inserted ("no partition of relation found"), which is the point: a typo'd
-- level fails loudly instead of creating a level nothing knows about.
CREATE TABLE IF NOT EXISTS geo_unit_state  PARTITION OF geo_unit FOR VALUES IN ('state');
CREATE TABLE IF NOT EXISTS geo_unit_county PARTITION OF geo_unit FOR VALUES IN ('county');
CREATE TABLE IF NOT EXISTS geo_unit_tract  PARTITION OF geo_unit FOR VALUES IN ('tract');
CREATE TABLE IF NOT EXISTS geo_unit_bg     PARTITION OF geo_unit FOR VALUES IN ('bg');
CREATE TABLE IF NOT EXISTS geo_unit_zcta   PARTITION OF geo_unit FOR VALUES IN ('zcta');
CREATE TABLE IF NOT EXISTS geo_unit_place  PARTITION OF geo_unit FOR VALUES IN ('place');
CREATE TABLE IF NOT EXISTS geo_unit_block  PARTITION OF geo_unit FOR VALUES IN ('block');

CREATE INDEX IF NOT EXISTS idx_geo_unit_gist   ON geo_unit USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_geo_unit_pt     ON geo_unit USING gist (pt);
CREATE INDEX IF NOT EXISTS idx_geo_unit_county ON geo_unit (level, county_fips);
CREATE INDEX IF NOT EXISTS idx_geo_unit_state  ON geo_unit (level, state_fp);

-- ------------------------------------------------------------ geo_values
-- Values at every level EXCEPT county.
--
-- County values stay in acs_county_values, which every op reads today. Copying
-- its ~12M rows here would duplicate ~1 GB and leave two copies to drift, so
-- there is deliberately no 'county' partition: inserting a county value here
-- fails. geo_values_all below presents both as one relation.
CREATE TABLE IF NOT EXISTS geo_values (
    level   TEXT NOT NULL,
    geoid   TEXT NOT NULL,
    code    TEXT NOT NULL,          -- same namespace as acs_county_values.census_code
    year    SMALLINT NOT NULL,
    value   DOUBLE PRECISION,
    PRIMARY KEY (level, geoid, code, year)
) PARTITION BY LIST (level);

CREATE TABLE IF NOT EXISTS geo_values_state PARTITION OF geo_values FOR VALUES IN ('state');
CREATE TABLE IF NOT EXISTS geo_values_tract PARTITION OF geo_values FOR VALUES IN ('tract');
CREATE TABLE IF NOT EXISTS geo_values_bg    PARTITION OF geo_values FOR VALUES IN ('bg');
CREATE TABLE IF NOT EXISTS geo_values_zcta  PARTITION OF geo_values FOR VALUES IN ('zcta');
CREATE TABLE IF NOT EXISTS geo_values_place PARTITION OF geo_values FOR VALUES IN ('place');
CREATE TABLE IF NOT EXISTS geo_values_block PARTITION OF geo_values FOR VALUES IN ('block');

CREATE INDEX IF NOT EXISTS idx_geo_values_code ON geo_values (level, code, year);

CREATE OR REPLACE VIEW geo_values_all AS
SELECT 'county'::text AS level, fips::text AS geoid, census_code AS code, year, value
  FROM acs_county_values
UNION ALL
SELECT level, geoid, code, year, value FROM geo_values;

-- ------------------------------------------------------------ geo_crosswalk
-- Weights between levels that do NOT nest: a ZCTA can straddle county lines,
-- a place can straddle tracts.
--
--   from_share  share of the FROM unit's area inside the TO unit.
--               Sums to ~1 over each from unit. Use it to roll a value from
--               `from` up to `to` (area-weighted mean of a rate).
--   to_share    share of the TO unit's area inside the FROM unit.
--               Use it to apportion a COUNT held by `to` down onto `from`.
--   w_pop       population-weighted equivalent. NULL until block population is
--               loaded; area weights are the fallback, and provenance must say
--               which was used.
--
-- Areas are geodesic m^2 of the full-resolution geometry, land and water both:
-- a ZCTA's water is still part of the ZCTA.
CREATE TABLE IF NOT EXISTS geo_crosswalk (
    from_level  TEXT NOT NULL,
    from_geoid  TEXT NOT NULL,
    to_level    TEXT NOT NULL,
    to_geoid    TEXT NOT NULL,
    area_m2     DOUBLE PRECISION NOT NULL,
    from_share  DOUBLE PRECISION NOT NULL,
    to_share    DOUBLE PRECISION NOT NULL,
    w_pop       DOUBLE PRECISION,
    PRIMARY KEY (from_level, from_geoid, to_level, to_geoid)
);
CREATE INDEX IF NOT EXISTS idx_geo_crosswalk_to
    ON geo_crosswalk (to_level, to_geoid, from_level);

-- ------------------------------------------------------------ geo_measure
-- One row per (measure, level) that HOLDS VALUES, whatever table they live in.
--
-- The catalog stays one row per measure (a row per level would triple the
-- search corpus, and corpus size is what limits retrieval). Which levels a
-- measure exists at is a property of the measure, recorded here. A measure
-- loaded only below county has NO catalog row yet: nothing can plan over it
-- until ops are level-aware (Phase 6), and a catalog row the planner cannot
-- use would only compete with ones it can.
CREATE TABLE IF NOT EXISTS geo_measure (
    code        TEXT NOT NULL,     -- acs_county_values.census_code / geo_values.code
    level       TEXT NOT NULL,
    dataset_id  TEXT NOT NULL,     -- the ledger id (ing_<id>_01)
    label       TEXT,
    description TEXT,
    units       TEXT,
    min_year    SMALLINT,
    max_year    SMALLINT,
    n_units     INTEGER,           -- units at that level with a value
    PRIMARY KEY (code, level)
);
CREATE INDEX IF NOT EXISTS idx_geo_measure_dataset ON geo_measure (dataset_id);

-- ------------------------------------------------------------ dataset_load
-- What THIS database holds, per ledger entry. The ledger (etl/data_manifest.yaml,
-- in git) says what should be loaded and from which bytes; this says what was.
-- `make replay` compares the two: an entry whose files_sha matches here is up
-- to date and skipped.
CREATE TABLE IF NOT EXISTS dataset_load (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    files_sha   TEXT NOT NULL,     -- sha256 over the ledger's sorted "path sha256" lines
    rows        BIGINT,
    via         TEXT NOT NULL,     -- 'ingest' | 'replay' | 'restore'
    loaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ rasters
-- A raster is kept AS a raster (raster_<id>, tiled, in-db) and DERIVED into
-- per-unit values (zonal statistics) and a grid pyramid of real polygons.
-- See etl/load_raster.py and docs/DATA_LOADING_PLAN.md section 4.
CREATE EXTENSION IF NOT EXISTS postgis_raster;

CREATE TABLE IF NOT EXISTS raster_layer (
    id           TEXT PRIMARY KEY,        -- short id, also the grid cell id prefix
    table_name   TEXT NOT NULL,
    dataset_id   TEXT NOT NULL,
    code         TEXT NOT NULL,           -- the measure its zonal values are stored under
    aggregate    TEXT NOT NULL CHECK (aggregate IN ('sum', 'mean')),
    year         SMALLINT NOT NULL,
    srid         INTEGER NOT NULL,
    origin_x     DOUBLE PRECISION NOT NULL,
    origin_y     DOUBLE PRECISION NOT NULL,
    pixel_x      DOUBLE PRECISION NOT NULL,
    pixel_y      DOUBLE PRECISION NOT NULL,   -- negative: rows go south
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    nodata       DOUBLE PRECISION,
    tile_size    INTEGER NOT NULL,
    tiles        INTEGER,
    valid_pixels BIGINT,
    total        DOUBLE PRECISION,        -- sum of every valid pixel: the conservation check
    loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Grid pyramid levels. Nominal sizes: a cell is the block of native pixels
-- nearest that size (a 30-arc-second raster: 4x4, 16x16, 64x64 pixels), so
-- every cell is an exact aggregate of whole pixels, never a resampling.
CREATE TABLE IF NOT EXISTS geo_unit_grid4k  PARTITION OF geo_unit FOR VALUES IN ('grid4k');
CREATE TABLE IF NOT EXISTS geo_unit_grid16k PARTITION OF geo_unit FOR VALUES IN ('grid16k');
CREATE TABLE IF NOT EXISTS geo_unit_grid64k PARTITION OF geo_unit FOR VALUES IN ('grid64k');
CREATE TABLE IF NOT EXISTS geo_values_grid4k  PARTITION OF geo_values FOR VALUES IN ('grid4k');
CREATE TABLE IF NOT EXISTS geo_values_grid16k PARTITION OF geo_values FOR VALUES IN ('grid16k');
CREATE TABLE IF NOT EXISTS geo_values_grid64k PARTITION OF geo_values FOR VALUES IN ('grid64k');

-- On-demand zonal statistics for ANY polygon (a buffer, a user's shape, a
-- level with no precomputed values), inside the read-only transaction like
-- every other op. ST_Clip keeps pixels whose CENTRE is inside, so for units
-- much smaller than a pixel this reads 0; the precomputed per-level values
-- (load_raster.py, 4x4 sub-pixel weighting) are the better answer there.
CREATE OR REPLACE FUNCTION geoark_zonal(raster_table regclass, g geometry, stat text DEFAULT 'sum')
RETURNS double precision LANGUAGE plpgsql STABLE AS $$
DECLARE result double precision;
BEGIN
  IF stat NOT IN ('sum', 'mean', 'count', 'min', 'max') THEN
    RAISE EXCEPTION 'geoark_zonal: stat must be sum, mean, count, min or max';
  END IF;
  EXECUTE format($q$
    WITH s AS (
      SELECT (ST_SummaryStats(ST_Clip(rast, 1, $1, true), 1, true)) AS st
        FROM %s WHERE ST_Intersects(rast, $1))
    SELECT CASE %L
      WHEN 'sum'   THEN sum((st).sum)
      WHEN 'count' THEN sum((st).count)
      WHEN 'mean'  THEN sum((st).sum) / NULLIF(sum((st).count), 0)
      WHEN 'min'   THEN min((st).min)
      WHEN 'max'   THEN max((st).max) END
      FROM s WHERE (st).count > 0$q$, raster_table, stat)
  INTO result USING g;
  RETURN result;
END $$;

-- ------------------------------------------------------------ dataset_info
-- Dataset-level metadata the map and provenance can show: a name and where the
-- data came from. geo_measure carries only the ledger id. Written by ingest and
-- replay from the sidecar/XML metadata the ledger already records.
CREATE TABLE IF NOT EXISTS dataset_info (
    dataset_id   TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    originator   TEXT,
    source_url   TEXT,
    license      TEXT,
    start_year   SMALLINT,
    end_year     SMALLINT
);

-- ------------------------------------------------------------ across levels
-- docs/DATA_LOADING_PLAN.md Phase 6: the two moves between levels that every
-- level-aware op will be built on. Both return a coverage figure, because a
-- derived value built from half its parts must not look like a stored one.
--
-- How a FROM unit relates to a TO unit, as (part, whole, share of the part
-- inside the whole):
--   tract / bg / block -> county   the parent key (county_fips): share 1
--   bg -> tract                    LEFT(geoid, 11): share 1
--   anything with a crosswalk      geo_crosswalk, in either direction
CREATE OR REPLACE FUNCTION geoark_level_link(p_part text, p_whole text)
RETURNS TABLE (part text, whole text, share double precision)
LANGUAGE sql STABLE AS $$
  SELECT u.geoid, u.county_fips::text, 1.0::float8 FROM geo_unit u
   WHERE p_whole = 'county' AND p_part IN ('tract', 'bg', 'block')
     AND u.level = p_part AND u.county_fips IS NOT NULL
  UNION ALL
  SELECT u.geoid, LEFT(u.geoid, 11), 1.0::float8 FROM geo_unit u
   WHERE p_part = 'bg' AND p_whole = 'tract' AND u.level = 'bg'
  UNION ALL
  SELECT x.from_geoid, x.to_geoid, x.from_share FROM geo_crosswalk x
   WHERE x.from_level = p_part AND x.to_level = p_whole
  UNION ALL
  -- The reverse rows: to_share is the share of the TO unit inside the FROM
  -- unit, which from this side is the share of the part inside the whole.
  SELECT x.to_geoid, x.from_geoid, x.to_share FROM geo_crosswalk x
   WHERE x.from_level = p_whole AND x.to_level = p_part
$$;

-- Fine -> coarse. 'sum' for counts (a tract's people belong to its county);
-- 'wmean' for rates, weighted by p_weight_code at the fine level (a
-- population), or by land area when no weight is given. A rate is never
-- summed, and an unweighted mean of rates over-counts small units.
CREATE OR REPLACE FUNCTION geoark_aggregate(
    p_code text, p_year int, p_from text, p_to text, p_method text,
    p_weight_code text DEFAULT NULL, p_weight_year int DEFAULT NULL)
RETURNS TABLE (geoid text, value double precision, coverage double precision, parts int)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_method NOT IN ('sum', 'wmean') THEN
    RAISE EXCEPTION 'geoark_aggregate: method must be sum or wmean';
  END IF;
  RETURN QUERY EXECUTE format($q$
    WITH src AS (SELECT v.geoid, v.value FROM geo_values_all v
                  WHERE v.level = %1$L AND v.code = %2$L AND v.year = %3$s),
         w AS (%4$s),
         link AS (SELECT * FROM geoark_level_link(%1$L, %5$L))
    SELECT l.whole,
           CASE WHEN %6$L = 'sum'
                THEN sum(s.value * l.share)
                ELSE sum(s.value * w.w * l.share) FILTER (WHERE s.value IS NOT NULL)
                     / NULLIF(sum(w.w * l.share) FILTER (WHERE s.value IS NOT NULL), 0) END,
           sum(COALESCE(w.w, 0) * l.share) FILTER (WHERE s.value IS NOT NULL)
             / NULLIF(sum(COALESCE(w.w, 0) * l.share), 0),
           count(s.value)::int
      FROM link l
      LEFT JOIN src s ON s.geoid = l.part
      LEFT JOIN w ON w.geoid = l.part
     GROUP BY l.whole
    HAVING count(s.value) > 0$q$,
    p_from, p_code, p_year,
    CASE WHEN p_weight_code IS NULL
         THEN format('SELECT geoid, aland::float8 AS w FROM geo_unit WHERE level = %L', p_from)
         ELSE format($w$SELECT geoid, value AS w FROM geo_values_all
                        WHERE level = %1$L AND code = %2$L
                          AND year = COALESCE(%3$s, (SELECT max(year) FROM geo_values_all
                                                       WHERE level = %1$L AND code = %2$L))$w$,
                     p_from, p_weight_code, COALESCE(p_weight_year::text, 'NULL')) END,
    p_to, p_method);
END $$;

-- Coarse -> fine. 'share' splits a COUNT among the fine units by their weight
-- (a county's total over its tracts by tract population); 'copy' gives every
-- fine unit its whole's value, which is the only honest move for a rate when
-- nothing finer is known. Either way the result is an estimate, and callers
-- must say so.
CREATE OR REPLACE FUNCTION geoark_apportion(
    p_code text, p_year int, p_from text, p_to text, p_method text,
    p_weight_code text DEFAULT NULL, p_weight_year int DEFAULT NULL)
RETURNS TABLE (geoid text, value double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_method NOT IN ('share', 'copy') THEN
    RAISE EXCEPTION 'geoark_apportion: method must be share or copy';
  END IF;
  RETURN QUERY EXECUTE format($q$
    WITH src AS (SELECT v.geoid, v.value FROM geo_values_all v
                  WHERE v.level = %1$L AND v.code = %2$L AND v.year = %3$s),
         w AS (%4$s),
         link AS (SELECT * FROM geoark_level_link(%5$L, %1$L)),
         part AS (SELECT l.part, l.whole, COALESCE(w.w, 0) * l.share AS pw, l.share
                    FROM link l LEFT JOIN w ON w.geoid = l.part)
    SELECT p.part,
           sum(CASE WHEN %6$L = 'copy' THEN s.value * p.share
                    ELSE s.value * p.pw / NULLIF(t.total, 0) END)
             / CASE WHEN %6$L = 'copy' THEN NULLIF(sum(p.share), 0) ELSE 1 END
      FROM part p
      JOIN src s ON s.geoid = p.whole
      JOIN (SELECT whole, sum(pw) AS total FROM part GROUP BY whole) t ON t.whole = p.whole
     GROUP BY p.part$q$,
    p_from, p_code, p_year,
    CASE WHEN p_weight_code IS NULL
         THEN format('SELECT geoid, aland::float8 AS w FROM geo_unit WHERE level = %L', p_to)
         ELSE format($w$SELECT geoid, value AS w FROM geo_values_all
                        WHERE level = %1$L AND code = %2$L
                          AND year = COALESCE(%3$s, (SELECT max(year) FROM geo_values_all
                                                       WHERE level = %1$L AND code = %2$L))$w$,
                     p_to, p_weight_code, COALESCE(p_weight_year::text, 'NULL')) END,
    p_to, p_method);
END $$;
