#!/usr/bin/env bash
# fine_pt_grid tile = the live per-tile aggregate it replaces (backend/fine_points.js)?
# grid_vs_live.sh z x y column [weight n|n_b]
z=$1 x=$2 y=$3 col=$4 w=${5:-n}; n=$((2**z))
env="ST_Transform(ST_TileEnvelope($z, $x, $y, margin => 0.0234375), 4326)"
px="((ST_X(geom) + 180) / 360 * $n - $x) * 256"
py="((1 - ln(tan(radians(ST_Y(geom))) + 1 / cos(radians(ST_Y(geom)))) / pi()) / 2 * $n - $y) * 256"
cat <<SQL | docker exec -i geoark-db-1 sh -c 'psql -At -F" " -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
SET max_parallel_workers_per_gather = 8;
WITH live AS (SELECT cx, cy, avg(v) v, count(*) k FROM (
  SELECT floor($px / 4)::int cx, floor($py / 4)::int cy, $col v FROM fine_pt
   WHERE geom && $env AND $col IS NOT NULL) s
  WHERE cx BETWEEN 0 AND 63 AND cy BETWEEN 0 AND 63 GROUP BY 1, 2),
grid AS (SELECT cx, cy, $col v, $w k FROM fine_pt_grid WHERE z=$z AND tx=$x AND ty=$y AND $col IS NOT NULL AND $w > 0)
SELECT 'z$z $col', count(l.cx) live_cells, count(g.cx) grid_cells,
       count(*) FILTER (WHERE l.k IS DISTINCT FROM g.k) count_diff,
       max(abs(l.v - g.v) / greatest(abs(l.v), 1e-9)) max_rel_diff
FROM live l FULL JOIN grid g USING (cx, cy);
SQL
