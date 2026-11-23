#!/usr/bin/env bash
# Load one state's fine sample points from the L48 GeoARK geodatabase into
# fine_pt (etl/schema_fine_points.sql). Plan: docs/POINTS_INTEGRATION_PLAN.md.
#
#   etl/load_fine_points.sh 29            # Missouri
#   etl/load_fine_points.sh 29 --keep     # keep the staging table
#
# Runs on the HOST: GDAL from /opt/mamba reads the gdb, PGDump streams into the
# db container's psql (the database port is not published). Every run scans the
# whole 168 GB gdb, because GDAL refuses its spatial index ("index depth
# suspicious"), so one state is ~7 min whatever its size. No -spat: a bounding
# box adds no speed and clipped the Missouri Bootheel on the first try.
#
# Idempotent per state: the state's partition is dropped and rebuilt.
set -euo pipefail
ST=${1:?state FIPS, e.g. 29}; KEEP=${2:-}
[[ $ST =~ ^[0-9]{2}$ ]] || { echo "state must be 2 digits" >&2; exit 2; }
GDB=${GDB:-/scratch/US_L48GeoARK_TEMP/US_L48GeoARK.gdb}
LAYER=L48_All_Pt_Blk1020ZipHUC_TH_Area
DB=${DB_CONTAINER:-geoark-db-1}
APP=$(cd "$(dirname "$0")/.." && pwd)
export PROJ_LIB=${PROJ_LIB:-/opt/mamba/share/proj}
STAGE=fine_pt_stage_$ST
psql_db() { docker exec -i "$DB" sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' "$@"; }

COLS="Block20,GRID_ID,ZIP_CODE,huc12,ThiessenArea,HospEDist,ParksEdist,PowerLineDen,DIST_VHA"
COLS+=",D_EMS,D_PubHealth,D_ChldCare,D_PbSchools,D_Uni,D_Worship,D_PubTrans,D_PowLines"
COLS+=",D_SubStn,D_PowPlnts,D_OilRef,D_OilRefPl,D_Biodsl,D_ER_TRI,D_ER_TSCA,D_SWLndfl"
COLS+=",D_Tornado,D_CnsMinOp,D_AgrMinOp,D_Abrasive,D_MiscInd,D_MineMnrl,D_FeMines"
COLS+=",D_FeMtPPln,D_NonFeMtM,D_NonFeMtP,D_UrnVandD,F_EMS"

psql_db < "$APP/etl/schema_fine_points.sql"

echo "[$ST] extracting from gdb (full scan)..."
t0=$SECONDS
ogr2ogr -f PGDump /vsistdout/ "$GDB" "$LAYER" -where "State20='$ST'" -select "$COLS" \
  -t_srs EPSG:4326 -nln "$STAGE" -nlt POINT -lco SPATIAL_INDEX=NONE -lco FID=objectid \
  -lco GEOMETRY_NAME=geom -lco CREATE_SCHEMA=OFF -lco DROP_TABLE=IF_EXISTS \
  2> >(grep -v "index depth" >&2) | psql_db > /dev/null
echo "[$ST] staged in $((SECONDS - t0)) s"

psql_db <<SQL
DROP TABLE IF EXISTS fine_pt_$ST;
CREATE TABLE fine_pt_$ST PARTITION OF fine_pt FOR VALUES IN ('$ST');
INSERT INTO fine_pt_$ST
SELECT '$ST', objectid, block20, grid_id, grid_id = 'BLOCK2020_ID', zip_code, huc12,
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
FROM $STAGE;
CREATE INDEX ON fine_pt_$ST USING gist (geom);
CREATE INDEX ON fine_pt_$ST (block20);
CLUSTER fine_pt_$ST USING fine_pt_${ST}_geom_idx;
ANALYZE fine_pt_$ST;
SQL
[[ $KEEP == --keep ]] || echo "DROP TABLE $STAGE;" | psql_db
echo "SELECT '$ST' st, count(*) points, count(DISTINCT block20) blocks,
      pg_size_pretty(pg_total_relation_size('fine_pt_$ST')) size FROM fine_pt_$ST;" \
  | docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
echo "[$ST] done in $((SECONDS - t0)) s"
