FROM python:3.11-slim

# Torch build is selectable so the same Dockerfile serves CPU, CUDA and ARM
# hosts. Defaults to the CPU-only wheels (~800 MB instead of ~2.5 GB); the GPU
# overlay (docker-compose.gpu.yml) passes a CUDA index instead.
#
# Note: changing this changes the VECTOR SPACE. The embedder fingerprints a
# canary embedding and will report drift against a cache built with a different
# build -- see /provenance.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/hf

WORKDIR /app

COPY requirements.txt .
ARG TORCH_INDEX_URL
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --extra-index-url "${TORCH_INDEX_URL}" -r requirements.txt

# WordNet at BUILD time: preprocessing needs it, and downloading corpora on
# first request would defeat the point of an offline-capable image.
ENV NLTK_DATA=/usr/share/nltk_data
RUN python -m nltk.downloader -d /usr/share/nltk_data wordnet omw-1.4

COPY app.py .

# Optional: bake the weights into the image instead of using the hf_cache
# volume (docs/DEPLOYMENT.md option B). Adds ~500 MB; makes the image hermetic.
# ARG EMBED_MODEL=BAAI/bge-base-en-v1.5
# RUN python -c "from sentence_transformers import SentenceTransformer as S; S('${EMBED_MODEL}')"

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
