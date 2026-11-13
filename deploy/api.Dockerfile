# Node API — no Python, no torch. ~200 MB instead of ~3 GB.
#
# The current GeoARK/backend/Dockerfile installs python3 + sentence_transformers
# into the Node image, which (a) makes it enormous and (b) invalidates that
# layer on every backend code change. Embeddings now live in the `embedder`
# service instead.

FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:20-slim AS dev
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin     && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY . .
EXPOSE 4000

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ogr2ogr, for per-session layer uploads (backend/user_layers.js): a zipped
# shapefile, GeoPackage or KML is converted to WGS84 GeoJSON in a temp dir.
# GeoJSON uploads need none of it. ~150 MB; the only reason it is here.
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin     && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4000
USER node
# NOTE: point this at the entrypoint you actually want. The current
# package.json "start" runs `ts-node server.js`, which serves the no-LLM
# server through an unnecessary TypeScript loader. See docs/ROADMAP.md Phase 1.
CMD ["node", "unified_search_server.js"]
