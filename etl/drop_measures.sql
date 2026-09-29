-- Remove measures that a loader bug created, so a corrected re-run replaces
-- them rather than sitting alongside them.
--
-- Loading is idempotent per (fips, code, year), which means a BAD code is never
-- overwritten by the good one -- it is simply a different key, and both survive.
-- Retrieval then has to choose between "Bachelor's degree or higher" and
-- "Bachelor's degree or higher, -12", which are the same measure with one of
-- them mislabelled. Deleting the bad key is the only thing that fixes it.
--
--   psql ... -v codes="'A','B'" -f drop_measures.sql
--
-- Defaults to the nine mangled by the ERS year-range bug: attribute names like
-- "2008-12" matched only the leading year, leaving "-12" glued to the label.

\set codes '''BACHELOR_S_DEGREE_OR_HIGHER_12'',''BACHELOR_S_DEGREE_OR_HIGHER_23'',''CENSUS_POP'',''HIGH_SCHOOL_GRADUATE_OR_EQUIVALENCY_12'',''HIGH_SCHOOL_GRADUATE_OR_EQUIVALENCY_23'',''LESS_THAN_HIGH_SCHOOL_GRADUATE_12'',''LESS_THAN_HIGH_SCHOOL_GRADUATE_23'',''SOME_COLLEGE_OR_ASSOCIATE_DEGREE_12'',''SOME_COLLEGE_OR_ASSOCIATE_DEGREE_23'''

BEGIN;

SELECT census_code, count(*) AS values_to_drop
FROM acs_county_values
WHERE census_code IN (:codes)
GROUP BY census_code ORDER BY census_code;

DELETE FROM acs_county_values WHERE census_code IN (:codes);
DELETE FROM attribute_source  WHERE attr_id     IN (:codes);

COMMIT;

SELECT count(*) AS remaining_measures FROM attribute_source;
