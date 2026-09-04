-- Phase 3: the resolution layer.
--
-- The blocker this solves: a catalog hit (attr_id) could not be turned into a
-- physical column, so generated plans were unexecutable. `attribute_source` is
-- that mapping, and everything in the planner depends on it.

-- ---------------------------------------------------------------- geometry
CREATE TABLE IF NOT EXISTS county_geom (
    fips      CHAR(5) PRIMARY KEY,
    name      TEXT,
    state_fp  CHAR(2),
    aland     BIGINT,
    awater    BIGINT,
    geom      geometry(MultiPolygon, 4326)
);
CREATE INDEX IF NOT EXISTS idx_county_geom_gist ON county_geom USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_county_geom_state ON county_geom (state_fp);

-- ------------------------------------------------------ named place geometry
--
-- Administrative boundaries other than counties: cities and towns, ZCTAs,
-- metros, urban areas. Until these existed, county_geom was the ONLY
-- administrative geometry, which meant a city restriction could not be spatial
-- at all -- "hospitals in Springfield" had to match a `city` COLUMN that only
-- 41% of facility layers even have, and that matched every Springfield in the
-- country.
--
-- Deliberately ONE table keyed on (kind, geoid) rather than a table per layer.
-- Every one of these is "a named polygon you might restrict an answer to", the
-- lookup is always name -> geometry, and a single GIST index serves all of
-- them. A table per layer would mean a compiler branch per layer.
--
-- These are NOT catalog attributes. Nobody asks "how many Census Tracts are in
-- each county"; they say "in Springfield". Loading them as searchable
-- attributes would add thousands of meaningless rows to the corpus.
CREATE TABLE IF NOT EXISTS place_geom (
    kind      TEXT NOT NULL,      -- place | zcta | cbsa | urban
    geoid     TEXT NOT NULL,
    name      TEXT,
    state_fp  CHAR(2),
    aland     BIGINT,
    geom      geometry(MultiPolygon, 4326),
    PRIMARY KEY (kind, geoid)
);
CREATE INDEX IF NOT EXISTS idx_place_geom_gist ON place_geom USING gist (geom);
-- Lookup is by lowercased name, so the index has to be too.
CREATE INDEX IF NOT EXISTS idx_place_geom_name ON place_geom (kind, lower(name));
CREATE INDEX IF NOT EXISTS idx_place_geom_state ON place_geom (state_fp);

-- ------------------------------------------------------------ ACS variables
CREATE TABLE IF NOT EXISTS acs_variables (
    census_code TEXT PRIMARY KEY,
    description TEXT,
    -- ACS suffixes: E = estimate, M = margin of error, PE/PM = percent forms.
    kind        TEXT CHECK (kind IN ('estimate', 'margin_of_error', 'percent',
                                     'percent_margin', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_acs_vars_kind ON acs_variables (kind);

-- --------------------------------------------------------------- ACS values
-- Long format, not wide: 3,982 ACS columns exceeds Postgres' 1600-column
-- ceiling, and a long table is what the planner wants to join against anyway.
CREATE TABLE IF NOT EXISTS acs_county_values (
    fips        CHAR(5) NOT NULL,
    census_code TEXT NOT NULL,
    value       DOUBLE PRECISION,
    PRIMARY KEY (fips, census_code)
);
CREATE INDEX IF NOT EXISTS idx_acs_values_code ON acs_county_values (census_code);

-- ------------------------------------------------- THE LINK (see AI-PIPELINE)
-- Resolves a catalog attribute to the physical place its values live.
-- `source_kind` discriminates the shape:
--   acs_long     -> acs_county_values WHERE census_code = <census_code>
--   table_column -> <table_name>.<value_column>
CREATE TABLE IF NOT EXISTS attribute_source (
    attr_id      TEXT PRIMARY KEY,
    dataset_id   TEXT NOT NULL,
    description  TEXT,
    -- acs_long      values live in acs_county_values, keyed by (fips, census_code)
    -- table_column   a plain column on a table that already has a fips key
    -- feature_table  a PostGIS feature collection (points/polygons) with NO fips.
    --                Facility datasets are this: they only become a (fips, value)
    --                series through a spatial aggregation against county_geom.
    source_kind  TEXT NOT NULL CHECK (source_kind IN ('acs_long', 'table_column', 'feature_table')),
    table_name   TEXT NOT NULL,
    value_column TEXT,
    census_code  TEXT,
    entity_type  TEXT,
    join_column  TEXT NOT NULL DEFAULT 'fips',
    geom_table   TEXT,
    geom_column  TEXT,          -- feature_table only: the geometry column to aggregate on
    srid         INTEGER        -- feature_table only: source SRID, for ST_Transform
);
CREATE INDEX IF NOT EXISTS idx_attr_source_dataset ON attribute_source (dataset_id);
CREATE INDEX IF NOT EXISTS idx_attr_source_code    ON attribute_source (census_code);

-- ---------------------------------------------------------------- migrations
-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
-- schema that gains columns needs explicit ALTERs. Without these, an
-- established database silently keeps the old shape and the loader fails on
-- INSERT with "column does not exist".
ALTER TABLE attribute_source ADD COLUMN IF NOT EXISTS geom_column TEXT;
ALTER TABLE attribute_source ADD COLUMN IF NOT EXISTS srid INTEGER;

-- The source_kind CHECK constraint predates 'feature_table'. Drop and recreate
-- so an existing database accepts facility rows.
ALTER TABLE attribute_source DROP CONSTRAINT IF EXISTS attribute_source_source_kind_check;
ALTER TABLE attribute_source ADD CONSTRAINT attribute_source_source_kind_check
    CHECK (source_kind IN ('acs_long', 'table_column', 'feature_table'));

-- Convenience view: everything the planner needs to emit SQL for one attribute.
DROP VIEW IF EXISTS resolvable_attributes;
CREATE VIEW resolvable_attributes AS
SELECT s.attr_id, s.dataset_id, s.description, s.entity_type,
       s.source_kind, s.table_name, s.value_column, s.census_code, s.geom_table,
       s.geom_column, s.srid,
       v.kind AS acs_kind
FROM attribute_source s
LEFT JOIN acs_variables v ON v.census_code = s.census_code;
