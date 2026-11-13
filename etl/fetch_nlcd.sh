#!/bin/sh
# Fetch NLCD land cover for a bounding box (EPSG:5070 metres) from the MRLC
# WCS, in 100 km tiles, so a region is clipped at the source instead of
# downloading CONUS (GIS_OPS_PLAN.md H4). The annual series is not on this
# WCS and its S3 bucket is requester-pays; the 2001-2021 release is.
#
#   sh etl/fetch_nlcd.sh <year> <xmin> <ymin> <xmax> <ymax> <out_dir>
#   sh etl/fetch_nlcd.sh 2021 18900 1453080 731280 2194890 deploy/incoming/nlcd/raw2021
set -eu
Y=$1; X0=$2; Y0=$3; X1=$4; Y1=$5; OUT=$6
STEP=100020   # a multiple of the 30 m pixel
mkdir -p "$OUT"
x=$X0
while [ "$x" -lt "$X1" ]; do
  y=$Y0
  while [ "$y" -lt "$Y1" ]; do
    xe=$((x + STEP)); [ "$xe" -gt "$X1" ] && xe=$X1
    ye=$((y + STEP)); [ "$ye" -gt "$Y1" ] && ye=$Y1
    f="$OUT/nlcd${Y}_${x}_${y}.tif"
    if [ ! -s "$f" ]; then
      for try in 1 2 3 4; do
        curl -s -m 600 -o "$f.part" "https://www.mrlc.gov/geoserver/mrlc_download/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=mrlc_download__NLCD_${Y}_Land_Cover_L48&subset=X($x,$xe)&subset=Y($y,$ye)&format=image/geotiff" \
          && head -c 4 "$f.part" | grep -q "MM\|II" && { mv "$f.part" "$f"; break; }
        echo "retry $try $f"; sleep 5
      done
      [ -s "$f" ] || { echo "FAILED $f"; exit 1; }
    fi
    y=$ye
  done
  x=$xe
done
echo "done $Y $(ls "$OUT" | wc -l) tiles"
