FROM python:3.11-slim

# CPU-only torch: ~800 MB instead of ~2.5 GB with the CUDA wheels. Drop the
# --index-url line if the server has an NVIDIA GPU you want the embedder to use.
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/hf

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

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
