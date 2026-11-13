#!/usr/bin/env python3
"""
Build subdivided parts for polygon feature layers (docs/GIS_OPS_PLAN.md H3).

New loads get them in ingest.finalize_table; this backfills layers loaded
before that existed. One layer, or every polygon table attribute_source links:

    python3 /app/etl/build_parts.py                # every catalog polygon layer
    python3 /app/etl/build_parts.py --table nwi_wetlands

Then `make reload-corpus` so the API reads the registry again.
"""

from __future__ import annotations

import argparse
import sys

import psycopg2

import ingest


def polygon_tables(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT a.table_name FROM attribute_source a
            JOIN geometry_columns g ON g.f_table_name = a.table_name
            WHERE a.source_kind = 'feature_table' AND g.type ILIKE '%POLYGON%'
            ORDER BY 1""")
        return [r[0] for r in cur.fetchall()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--table", help="one table; default every catalog polygon layer")
    args = ap.parse_args()
    conn = psycopg2.connect(ingest.pg_dsn())
    conn.autocommit = True
    tables = [args.table] if args.table else polygon_tables(conn)
    for t in tables:
        if not ingest.SAFE_IDENT.match(t):
            print(f"  {t}: not a usable table name, skipped")
            continue
        print(f"{t}")
        ingest.build_parts(conn, t)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
