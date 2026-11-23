#!/usr/bin/env bash
# Checks for the national fine_pt load (docs/POINTS_INTEGRATION_PLAN.md):
#  1. total points = the gdb layer's feature count (118,158,718)
#  2. blocks per state = summarized_blocks.csv
#  3. every county's EMS mean, rebuilt from the points the way
#     etl/prep_proximity_summaries.py builds it (unweighted mean of block
#     means), = HSIP_PROXIMITY_DIST_EMS in acs_county_values
set -euo pipefail
APP=$(cd "$(dirname "$0")/../.." && pwd)
q() { docker exec -i geoark-db-1 sh -c 'psql -At -F, -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; }
echo "== 1. total points (gdb: 118158718)"
echo "SELECT count(*) FROM fine_pt;" | q
echo "== 2. blocks per state vs summarized_blocks.csv"
echo "SELECT state_fp, count(DISTINCT block20) FROM fine_pt GROUP BY 1 ORDER BY 1;" | q > /tmp/$$.db
python3 - "$APP/summarized_blocks.csv" /tmp/$$.db <<'PY'
import csv, sys, collections
c = collections.Counter()
with open(sys.argv[1]) as f:
    for r in csv.DictReader(f): c[r['Block20'].zfill(15)[:2]] += 1
db = dict(l.strip().split(',') for l in open(sys.argv[2]))
bad = [(s, c.get(s, 0), int(db.get(s, 0))) for s in sorted(set(c) | set(db)) if c.get(s, 0) != int(db.get(s, 0))]
print(f"states in db {len(db)}, in csv {len(c)}; mismatches (state, csv, db): {bad}")
PY
rm -f /tmp/$$.db
echo "== 3. county EMS from points vs loaded county values (miles)"
cat <<'SQL' | q
WITH b AS (SELECT block20, avg(ems_mi) m FROM fine_pt GROUP BY block20),
     c AS (SELECT left(block20, 5) fips, avg(m) v FROM b GROUP BY 1)
SELECT count(*) counties, count(a.value) matched,
       round(max(abs(c.v - a.value))::numeric, 6) max_abs_diff,
       count(*) FILTER (WHERE abs(c.v - a.value) > 1e-3) over_1e3
FROM c LEFT JOIN acs_county_values a
  ON a.fips = c.fips AND a.census_code = 'HSIP_PROXIMITY_DIST_EMS';
SQL
echo "== 4. size"
echo "SELECT pg_size_pretty(sum(pg_total_relation_size(inhrelid))) FROM pg_inherits WHERE inhparent = 'fine_pt'::regclass;" | q
