#!/usr/bin/env bash
# Load fine sample points from the L48 GeoARK geodatabase into fine_pt
# (etl/schema_fine_points.sql). Plan: docs/POINTS_INTEGRATION_PLAN.md.
#
#   etl/load_fine_points.sh 29            # one state (Missouri)
#   etl/load_fine_points.sh 29 --keep     # keep the staging table
#   etl/load_fine_points.sh ALL           # every state in one gdb scan
#   etl/load_fine_points.sh ALL --skip 29 # ...leaving existing partitions alone
#
# Runs on the HOST: GDAL from /opt/mamba reads the gdb, PGDump streams into the
# db container's psql (the database port is not published). Every extract scans
# the whole 168 GB gdb, because GDAL refuses its spatial index ("index depth
# suspicious") and does not use an OBJECTID filter to seek, so one state takes
# ~18 min whatever its size. ALL pays that scan once into an UNLOGGED staging
# table, then builds the state partitions from it in parallel (JOBS, default 6).
# No -spat: a bounding box clipped the Missouri Bootheel on the first try.
#
# Idempotent per state: the state's partition is dropped and rebuilt.
set -euo pipefail
ST=${1:?state FIPS (e.g. 29) or ALL}; shift
KEEP=; SKIP=
while (($#)); do case $1 in
  --keep) KEEP=1; shift;;
  --skip) SKIP=${2:?--skip needs a comma list}; shift 2;;
  *) echo "unknown arg $1" >&2; exit 2;;
esac; done
[[ $ST =~ ^([0-9]{2}|ALL)$ ]] || { echo "state must be 2 digits or ALL" >&2; exit 2; }
GDB=${GDB:-/scratch/US_L48GeoARK_TEMP/US_L48GeoARK.gdb}
LAYER=L48_All_Pt_Blk1020ZipHUC_TH_Area
DB=${DB_CONTAINER:-geoark-db-1}
JOBS=${JOBS:-6}
APP=$(cd "$(dirname "$0")/.." && pwd)
export PROJ_LIB=${PROJ_LIB:-/opt/mamba/share/proj}
STAGE=fine_pt_stage_${ST,,}
psql_db() { docker exec -i "$DB" sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$@"; }
psql_out() { docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$@"; }

COLS="State20,Block20,GRID_ID,ZIP_CODE,huc12,ThiessenArea,HospEDist,ParksEdist,PowerLineDen,DIST_VHA"
COLS+=",D_EMS,D_PubHealth,D_ChldCare,D_PbSchools,D_Uni,D_Worship,D_PubTrans,D_PowLines"
COLS+=",D_SubStn,D_PowPlnts,D_OilRef,D_OilRefPl,D_Biodsl,D_ER_TRI,D_ER_TSCA,D_SWLndfl"
COLS+=",D_Tornado,D_CnsMinOp,D_AgrMinOp,D_Abrasive,D_MiscInd,D_MineMnrl,D_FeMines"
COLS+=",D_FeMtPPln,D_NonFeMtM,D_NonFeMtP,D_UrnVandD,F_EMS"

# build_partition <state> : fine_pt_<state> from $STAGE rows of that state.
build_partition() {
  local S=$1 t=$SECONDS
  psql_db <<SQL
SET work_mem = '512MB'; SET maintenance_work_mem = '1GB';
DROP TABLE IF EXISTS fine_pt_$S;
CREATE TABLE fine_pt_$S PARTITION OF fine_pt FOR VALUES IN ('$S');
INSERT INTO fine_pt_$S
SELECT '$S', objectid, block20, grid_id, grid_id = 'BLOCK2020_ID', zip_code, huc12,
       thiessenarea, geom,
       hospedist  * cos(radians(ST_Y(geom))) / 1609.344,   -- Web Mercator raster
       parksedist * cos(radians(ST_Y(geom))) / 1609.344,   -- Web Mercator raster
       dist_vha / 1609.344, powerlineden,
       d_ems/1609.344, d_pubhealth/1609.344, d_chldcare/1609.344, d_pbschools/1609.344,
       d_uni/1609.344, d_worship/1609.344, d_pubtrans/1609.344, d_powlines/1609.344,
       d_substn/1609.344, d_powplnts/1609.344, d_oilref/1609.344, d_oilrefpl/1609.344,
       d_biodsl/1609.344, d_er_tri/1609.344, d_er_tsca/1609.344, d_swlndfl/1609.344,
       d_tornado/1609.344, d_cnsminop/1609.344, d_agrminop/1609.344, d_abrasive/1609.344,
       d_miscind/1609.344, d_minemnrl/1609.344, d_femines/1609.344, d_femtppln/1609.344,
       d_nonfemtm/1609.344, d_nonfemtp/1609.344, d_urnvandd/1609.344, f_ems
FROM $STAGE WHERE state20 = '$S'
ORDER BY ST_GeoHash(geom, 10);          -- spatial order on disk, instead of CLUSTER
CREATE INDEX ON fine_pt_$S USING gist (geom);
CREATE INDEX ON fine_pt_$S (block20);
ANALYZE fine_pt_$S;
SQL
  echo "[$S] partition built in $((SECONDS - t)) s"
}

# extract <stage table> <where> : one full gdb scan into an UNLOGGED staging table.
# PG_USE_COPY: PGDump otherwise writes one INSERT per row.
extract() {
  ogr2ogr --config PG_USE_COPY YES -f PGDump /vsistdout/ "$GDB" "$LAYER" -where "$2" -select "$COLS" \
    -t_srs EPSG:4326 -nln "$1" -nlt POINT -lco SPATIAL_INDEX=NONE -lco FID=objectid \
    -lco GEOMETRY_NAME=geom -lco CREATE_SCHEMA=OFF -lco DROP_TABLE=IF_EXISTS -lco UNLOGGED=ON \
    2> >(grep -v "index depth" >&2) | psql_db > /dev/null
}

psql_db < "$APP/etl/schema_fine_points.sql"
t0=$SECONDS

if [[ $ST == ALL ]]; then
  # ogr2ogr is one core: ~110k rows/s parsed, but only ~14k rows/s written, so
  # one national extract is >2 h. NGROUPS (default 8) extracts run at once, each over a
  # disjoint set of states (balanced by land area: the hexagons cover it), so
  # each pays the parse but writes only its share. The page cache keeps the
  # repeated reads of the gdb off the disk.
  NG=${NGROUPS:-8}
  GLIST=$(echo "SELECT state_fp, aland FROM geo_unit WHERE level = 'state'
                AND state_fp NOT IN ('02','15','60','66','69','72','78');" \
          | docker exec -i "$DB" sh -c 'psql -At -F" " -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
          | python3 -c '
import sys
skip = set(sys.argv[2].split(",")) - {""}; n = int(sys.argv[1])
rows = sorted(((int(a), s) for s, a in (l.split() for l in sys.stdin)), reverse=True)
groups = [[0, []] for _ in range(n)]
for a, s in rows:
    if s in skip: continue
    g = min(groups); g[0] += a; g[1].append(s)
for _, ss in groups:
    if ss: print(",".join(sorted(ss)))' "$NG" "$SKIP")
  echo "[ALL] extracting $(wc -l <<<"$GLIST") state groups in parallel (full scan each)..."
  k=0; pids=()
  while read -r g; do
    k=$((k+1)); in=$(sed "s/[0-9][0-9]/'&'/g" <<<"$g")
    ( extract fine_pt_stage_g$k "State20 IN ($in)"; echo "[g$k: $g] staged in $((SECONDS - t0)) s" ) &
    pids+=($!)
  done <<<"$GLIST"
  for p in "${pids[@]}"; do wait "$p"; done
  # state -> its group's staging table
  k=0; MAP=
  while read -r g; do k=$((k+1)); for s in ${g//,/ }; do MAP+="$s fine_pt_stage_g$k"$'\n'; done; done <<<"$GLIST"
  for i in $(seq 1 "$k"); do
    echo "SET maintenance_work_mem='2GB'; CREATE INDEX ON fine_pt_stage_g$i (state20); ANALYZE fine_pt_stage_g$i;"
  done | psql_db
  export -f build_partition psql_db; export DB
  sed '/^$/d' <<<"$MAP" | xargs -P "$JOBS" -L1 bash -c 'STAGE=$1 build_partition $0'
  [[ -n $KEEP ]] || for i in $(seq 1 "$k"); do echo "DROP TABLE fine_pt_stage_g$i;"; done | psql_db
else
  echo "[$ST] extracting from gdb (full scan)..."
  extract "$STAGE" "State20='$ST'"
  echo "[$ST] staged in $((SECONDS - t0)) s"
  build_partition "$ST"
  [[ -n $KEEP ]] || echo "DROP TABLE $STAGE;" | psql_db
fi

echo "SELECT tableoid::regclass part, count(*) points, count(DISTINCT block20) blocks
      FROM fine_pt GROUP BY 1 ORDER BY 1;
      SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) total
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'fine_pt'::regclass;" | psql_out
echo "[$ST] done in $((SECONDS - t0)) s"
