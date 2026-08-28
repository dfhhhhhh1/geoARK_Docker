# AutoGluon AutoML service (ml_service.py). Heavy image (~4 GB) — this is why
# it sits behind the `automl` compose profile rather than starting by default.
FROM python:3.11-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --extra-index-url https://download.pytorch.org/whl/cpu \
        "fastapi==0.115.6" "uvicorn[standard]==0.34.0" \
        "autogluon.tabular[all]==1.2" "pandas==2.2.3" "python-multipart==0.0.20"

COPY ml_service.py .

EXPOSE 8000
CMD ["uvicorn", "ml_service:app", "--host", "0.0.0.0", "--port", "8000"]
