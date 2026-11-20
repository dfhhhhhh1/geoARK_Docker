# PostGIS + pgvector + pgRouting. The stock postgis/postgis image has no
# pgvector, and the stock pgvector image has no PostGIS, so combine them.
#
# The base image is Debian bullseye, whose pgdg suite moved off
# apt.postgresql.org to the archive host (the old URL 404s, so this file
# stopped building without anyone touching it). Point apt there first.
#
# pgRouting (H5, docs/GIS_OPS_PLAN.md): network service areas and routes over
# the road graph built by etl/load_osm_network.py.
FROM postgis/postgis:16-3.4
RUN sed -i 's#http://apt.postgresql.org/pub/repos/apt#https://apt-archive.postgresql.org/pub/repos/apt#' \
        /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector postgresql-16-pgrouting \
 && rm -rf /var/lib/apt/lists/*
