# PostGIS + pgvector. The stock postgis/postgis image has no pgvector, and the
# stock pgvector image has no PostGIS, so combine them.
FROM postgis/postgis:16-3.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
