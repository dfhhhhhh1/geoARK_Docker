#!/usr/bin/env bash
# Run named_probe.js inside the API container against the working tree's
# planner and HEAD's named_data.js, without rebuilding the shared API.
#   bash eval/gis_ops/checks/run_named_probe.sh <label>
# Writes eval/gis_ops/checks/<label>-named_probe.{json,log}.
set -eu
export MSYS_NO_PATHCONV=1
L=${1:-probe}
cd "$(dirname "$0")/../../.."
T=/tmp/nprobe
git show HEAD:backend/planner/named_data.js > eval/gis_ops/checks/.named_data_head.js
docker exec geoark-api-1 rm -rf $T
docker exec geoark-api-1 mkdir -p $T
tar -C backend -cf - planner states.js $(cd backend && ls *.js | grep -v unified_search_server.js) | docker exec -i geoark-api-1 tar -C $T -xf -
docker cp eval/gis_ops/checks/.named_data_head.js geoark-api-1:$T/planner/named_data_head.js
docker cp eval/gis_ops/checks/named_probe.js geoark-api-1:$T/named_probe.js
docker exec geoark-api-1 ln -s /app/node_modules $T/node_modules
docker exec geoark-api-1 node $T/named_probe.js $T $T/out.json | tee eval/gis_ops/checks/$L-named_probe.log
docker cp geoark-api-1:$T/out.json eval/gis_ops/checks/$L-named_probe.json
docker exec geoark-api-1 rm -rf $T
rm -f eval/gis_ops/checks/.named_data_head.js
