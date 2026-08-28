# One-shot ETL runner. Behind the `etl` compose profile — it is not a service,
# it is a job you invoke (`make load-reference`).
FROM python:3.11-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install "psycopg2-binary==2.9.10"

COPY . /app/etl
CMD ["python", "/app/etl/load_reference_data.py", "--help"]
