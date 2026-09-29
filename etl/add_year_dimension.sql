-- Add a year dimension to the county value store.
--
-- WHY. The table was keyed (fips, census_code) with no time axis, so every
-- measure was a single vintage -- 2018 for the ACS load. That made
-- `combine`'s percent_change unrunnable and every trend question unanswerable:
-- "where did poverty grow fastest" had nothing to compare.
--
-- The name is historical. This table now holds long-format county measures from
-- several sources, not only the ACS, and `census_code` is really a measure code.
-- Renaming both is a separate, mechanical change; it is not done here because
-- this migration should be safe to run against a live database.
--
-- BACKFILL. Existing rows are the 2018 ACS 5-year estimates, so they are
-- stamped 2018 rather than 0 or NULL. A sentinel would have been dishonest and
-- would sort wrongly against real years the moment anything else was loaded.
--
--   make add-year

BEGIN;

ALTER TABLE acs_county_values
  ADD COLUMN IF NOT EXISTS year SMALLINT;

-- CREATE TABLE IF NOT EXISTS ignores new columns on an established database,
-- which is why this is an explicit ALTER: the loader would otherwise fail with
-- "column does not exist" on exactly the installs that already have data.
UPDATE acs_county_values SET year = 2018 WHERE year IS NULL;

ALTER TABLE acs_county_values
  ALTER COLUMN year SET NOT NULL;

-- The key has to widen, or a second vintage of the same measure collides with
-- the first and the load silently updates instead of inserting.
ALTER TABLE acs_county_values
  DROP CONSTRAINT IF EXISTS acs_county_values_pkey;
ALTER TABLE acs_county_values
  ADD PRIMARY KEY (fips, census_code, year);

-- Serves the common lookup: all years of one measure, for a trend, and the
-- "latest year available" probe the compiler makes when no year is requested.
CREATE INDEX IF NOT EXISTS idx_acs_values_code_year
  ON acs_county_values (census_code, year);

COMMIT;

SELECT year, count(DISTINCT census_code) AS measures, count(*) AS values
FROM acs_county_values GROUP BY year ORDER BY year;
