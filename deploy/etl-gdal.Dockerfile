# Geospatial ETL runner: shapefiles and file geodatabases -> PostGIS.
#
# Separate from etl.Dockerfile because GDAL is a heavy dependency (~1 GB) that
# only geospatial_etl.py needs; the catalog loader stays small.
#
# PyYAML reads dataset sidecars (*.meta.yaml) and writes etl/data_manifest.yaml.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.9.2

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
WORKDIR /app

# postgresql-client-16 matches the server major version (Ubuntu 24.04 ships
# 16): pg_dump refuses to dump a NEWER server than itself, so a mismatched
# client would make `make dump-dataset` fail only when it is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --break-system-packages \
        "psycopg2-binary==2.9.10" "pandas==2.2.3" "SQLAlchemy==2.0.36" "GeoAlchemy2==0.15.2" \
        "PyYAML==6.0.2" "openpyxl==3.1.5"

COPY . /app/etl
CMD ["python3", "/app/etl/geospatial_etl.py"]
