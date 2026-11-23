#!/usr/bin/env bash
# Precomputed zoomed-out tiles for the fine points (backend/fine_points.js).
#
#   etl/build_fine_point_grid.sh          # after any etl/load_fine_points.sh run
#
# A zoomed-out map tile is the mean of the points in each 4x4 px cell (64x64
# cells per 256 px tile). Computed live it reads every point in the tile: a z5
# tile is ~15M points and 18 s, so a zoomed-out view held the API's whole
# database pool for minutes. fine_pt_grid holds those cell means for every
# zoom from BASE_Z down to MIN_Z, so such a tile is one indexed read of at most
# 4,096 rows.
#
# Exact, not an approximation: a level-z cell is exactly 2x2 level-(z+1)
# cells (Web Mercator pixels nest), and each mean is carried up weighted by
# its count. Two counts suffice because nulls come in two classes, checked at
# build time (the build fails if a cell breaks it):
#   n   all points; hosp, parks, child care, biodiesel, construction minerals
#       and ferrous mines are never null
#   n_b points with the other 24 distances, which are null together (the
#       source's northern gap, docs/POINTS_INTEGRATION_PLAN.md)
set -euo pipefail
DB=${DB_CONTAINER:-geoark-db-1}
JOBS=${JOBS:-8}
BASE_Z=${BASE_Z:-9}
MIN_Z=${MIN_Z:-3}
psql_db() { docker exec -i "$DB" sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$@"; }
psql_at() { docker exec -i "$DB" sh -c 'psql -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$@"; }

# The 30 columns backend/fine_points.js draws, by null class.
A="hosp_mi parks_mi child_care_mi biodiesel_mi construction_minerals_mi ferrous_mine_mi"
B="ems_mi vha_mi public_health_mi public_school_mi college_mi worship_mi public_transit_mi
   power_line_mi substation_mi power_plant_mi oil_refinery_mi oil_refinery_site_mi
   tri_facility_mi tsca_facility_mi landfill_mi tornado_track_mi agricultural_minerals_mi
   abrasive_minerals_mi misc_industrial_minerals_mi mine_mineral_site_mi ferrous_processing_mi
   nonferrous_mine_mi nonferrous_processing_mi uranium_vanadium_mi"
ALL="$A $B"
# jn SEP: join stdin lines with SEP
jn() { sed ':a;N;$!ba;s/\n/'"$1"'/g'; }
COLS=$(for c in $ALL; do echo "$c"; done | jn ", ")
DEFS=$(for c in $ALL; do echo "$c real"; done | jn ", ")
AVGS=$(for c in $ALL; do echo "avg($c)::real"; done | jn ", ")
# A point outside both classes makes its cell "mixed"
MIXED=$( { for c in $A; do echo "count($c)<>count(*)"; done
           for c in $B; do echo "count($c)<>count(ems_mi)"; done; } | jn " OR ")
UP=$( { for c in $A; do echo "(sum($c*n)/sum(n))::real"; done
        for c in $B; do echo "(sum($c*n_b)/nullif(sum(n_b),0))::real"; done; } | jn ", ")
N=$((2 ** BASE_Z * 64))   # base-level cells across the world

t0=$SECONDS
psql_db <<SQL
DROP TABLE IF EXISTS fine_pt_grid_stage;
CREATE UNLOGGED TABLE fine_pt_grid_stage (gx int, gy int, n int, n_b int, mixed boolean, $DEFS);
DROP TABLE IF EXISTS fine_pt_grid_new;
CREATE TABLE fine_pt_grid_new (z smallint, tx int, ty int, cx smallint, cy smallint,
                               n int, n_b int, $DEFS);
SQL

# 1. Per state partition, in parallel: base-level cell means. A cell on a
#    state line gets one row per state here, merged in step 2.
states=$(echo "SELECT right(c.relname, 2) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
               WHERE i.inhparent = 'fine_pt'::regclass ORDER BY 1;" | psql_at)
build_state() {
  psql_db <<SQL
SET work_mem = '512MB';
INSERT INTO fine_pt_grid_stage
SELECT gx, gy, count(*), count(ems_mi), $MIXED, $AVGS FROM (
  SELECT floor((ST_X(geom) + 180) / 360 * $N)::int AS gx,
         floor((1 - ln(tan(radians(ST_Y(geom))) + 1 / cos(radians(ST_Y(geom)))) / pi()) / 2 * $N)::int AS gy,
         $COLS
    FROM fine_pt_$1) p
GROUP BY gx, gy;
SQL
}
export -f build_state psql_db; export DB N MIXED AVGS COLS
xargs -P "$JOBS" -I{} bash -c 'build_state {}' <<<"$states"
echo "base cells per state: $((SECONDS - t0)) s"

bad=$(echo "SELECT count(*) FROM fine_pt_grid_stage WHERE mixed;" | psql_at)
[[ $bad == 0 ]] || { echo "ERROR: $bad cells break the two null classes; the merge would be wrong" >&2; exit 1; }

# 2. Merge state lines into the base level, then each coarser level from the
#    one below it: cell (gx, gy) at z is (gx>>1, gy>>1) at z-1.
psql_db <<SQL
SET work_mem = '1GB';
INSERT INTO fine_pt_grid_new
SELECT $BASE_Z, gx >> 6, gy >> 6, gx & 63, gy & 63, sum(n), sum(n_b), $UP
  FROM fine_pt_grid_stage GROUP BY gx, gy;
DROP TABLE fine_pt_grid_stage;
SQL
for ((z = BASE_Z - 1; z >= MIN_Z; z--)); do
  psql_db <<SQL
SET work_mem = '1GB';
INSERT INTO fine_pt_grid_new
SELECT $z, gx >> 6, gy >> 6, gx & 63, gy & 63, sum(n), sum(n_b), $UP FROM (
  SELECT (tx * 64 + cx) >> 1 AS gx, (ty * 64 + cy) >> 1 AS gy, * FROM fine_pt_grid_new WHERE z = $((z + 1))) s
GROUP BY gx, gy;
SQL
done

# 3. Swap in, ordered by tile so a tile's rows are adjacent on disk.
psql_db <<SQL
SET maintenance_work_mem = '2GB';
CREATE INDEX fine_pt_grid_new_tile ON fine_pt_grid_new (z, tx, ty);
CLUSTER fine_pt_grid_new USING fine_pt_grid_new_tile;
ANALYZE fine_pt_grid_new;
BEGIN;
DROP TABLE IF EXISTS fine_pt_grid;
ALTER TABLE fine_pt_grid_new RENAME TO fine_pt_grid;
ALTER INDEX fine_pt_grid_new_tile RENAME TO fine_pt_grid_tile;
COMMIT;
SQL
echo "SELECT z, count(*) cells, sum(n) points FROM fine_pt_grid GROUP BY z ORDER BY z;
      SELECT pg_size_pretty(pg_total_relation_size('fine_pt_grid')) size;" \
  | docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
echo "built in $((SECONDS - t0)) s"
