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
    source_kind  TEXT NOT NULL CHECK (source_kind IN ('acs_long', 'table_column')),
    table_name   TEXT NOT NULL,
    value_column TEXT,
    census_code  TEXT,
    entity_type  TEXT,
    join_column  TEXT NOT NULL DEFAULT 'fips',
    geom_table   TEXT
);
CREATE INDEX IF NOT EXISTS idx_attr_source_dataset ON attribute_source (dataset_id);
CREATE INDEX IF NOT EXISTS idx_attr_source_code    ON attribute_source (census_code);

-- Convenience view: everything the planner needs to emit SQL for one attribute.
CREATE OR REPLACE VIEW resolvable_attributes AS
SELECT s.attr_id, s.dataset_id, s.description, s.entity_type,
       s.source_kind, s.table_name, s.value_column, s.census_code, s.geom_table,
       v.kind AS acs_kind
FROM attribute_source s
LEFT JOIN acs_variables v ON v.census_code = s.census_code;
