# Geospatial ETL runner: shapefiles and file geodatabases -> PostGIS.
#
# Separate from etl.Dockerfile because GDAL is a heavy dependency (~1 GB) that
# only geospatial_etl.py needs; the catalog loader stays small.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.9.2

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip \
 && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --break-system-packages \
        "psycopg2-binary==2.9.10" "pandas==2.2.3" "SQLAlchemy==2.0.36" "GeoAlchemy2==0.15.2"

COPY . /app/etl
CMD ["python3", "/app/etl/geospatial_etl.py"]
