-- County adjacency, materialized.
--
-- WHY A TABLE. Spatial statistics need a neighbourhood, and computing one
-- inline costs 511ms for all 18,608 adjacency pairs -- measured, with the GIST
-- index and a && prefilter already doing their job. That is payable once and
-- wasteful per query, so it is built once here and read in microseconds after.
--
-- ST_Intersects, not ST_Touches. Touches is the textbook contiguity test and it
-- is the wrong one for this layer: TIGER county polygons are generalized, so a
-- shared border is frequently represented as a hairline overlap rather than a
-- clean shared edge, and ST_Touches drops those pairs. That would silently
-- remove real neighbours from the weights and quietly change every Gi* score.
-- Intersects catches both cases; the fips inequality excludes self.
--
-- Queen contiguity: two counties are neighbours if they share ANY boundary
-- point, corner-only included. Rook (edge-sharing only) is the alternative, and
-- at county scale the difference is a handful of corner-touching pairs in the
-- gridded western states. Queen is the usual default for socio-economic data.
--
--   make neighbors

CREATE TABLE IF NOT EXISTS county_neighbors (
  fips          char(5) NOT NULL,
  neighbor_fips char(5) NOT NULL,
  PRIMARY KEY (fips, neighbor_fips)
);

TRUNCATE county_neighbors;

INSERT INTO county_neighbors (fips, neighbor_fips)
SELECT a.fips, b.fips
FROM county_geom a
JOIN county_geom b
  ON a.geom && b.geom
 AND a.fips <> b.fips
 AND ST_Intersects(a.geom, b.geom);

-- The lookup every spatial-statistics op makes is "neighbours of this county",
-- which the primary key's leading column already serves.
ANALYZE county_neighbors;

-- Report what was built, so a truncated or failed run is visible rather than
-- silently leaving an empty weights matrix -- which would make every county
-- its own island and return a Gi* of zero everywhere.
SELECT
  count(*)                                         AS pairs,
  count(DISTINCT fips)                             AS counties_with_neighbors,
  round(avg(n)::numeric, 2)                        AS mean_neighbors,
  min(n)                                           AS min_neighbors,
  max(n)                                           AS max_neighbors
FROM (SELECT fips, count(*) AS n FROM county_neighbors GROUP BY fips) s;
