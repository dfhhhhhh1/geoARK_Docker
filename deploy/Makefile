# GeoARK deployment helpers. Run from ./deploy on the server.
COMPOSE := docker compose
GPU     := docker compose -f docker-compose.yml -f docker-compose.gpu.yml
DEV     := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: help up up-gpu down dev build logs ps health provenance models automl county-values county-values-dry semmed semmed-dry add-year neighbors boundaries boundaries-dry inspect ingest load-geo load-reference load-reference-dry relink relink-features validate-catalog shell-api shell-embed shell-db reindex psql clean

help:            ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up:              ## Build and start everything
	$(COMPOSE) up -d --build

down:            ## Stop everything (volumes survive — models are NOT re-downloaded)
	$(COMPOSE) down

up-gpu:          ## Build and start with NVIDIA GPU acceleration (then: make reindex)
	$(GPU) up -d --build

provenance:      ## What produced the current vectors, and whether the cache drifted
	@$(COMPOSE) exec -T embedder python -c \
	  "import urllib.request,json;print(json.dumps(json.load(urllib.request.urlopen('http://localhost:8000/provenance')),indent=1))"

validate-catalog: ## Check a new catalog CSV before loading it (CSV=path/to.csv)
	@test -n "$(CSV)" || { echo "usage: make validate-catalog CSV=path/to/new.csv"; exit 2; }
	python3 ../etl/validate_catalog.py --new "$(CSV)"

dev:             ## Start with source bind-mounted and live reload
	$(DEV) up

build:           ## Rebuild images without starting
	$(COMPOSE) build

logs:            ## Tail all logs
	$(COMPOSE) logs -f --tail=100

ps:              ## Show service status
	$(COMPOSE) ps

health:          ## Check every service
	@echo "-- embedder --"; $(COMPOSE) exec -T embedder \
	  python -c "import urllib.request as u;print(u.urlopen('http://localhost:8000/health').read().decode())" \
	  || echo "embedder DOWN"
	@echo "-- api --";      $(COMPOSE) exec -T api \
	  node -e "fetch('http://localhost:4000/api/health').then(r=>r.text()).then(console.log)" \
	  || echo "api DOWN"
	@echo "-- ollama --";   $(COMPOSE) exec -T ollama ollama list || echo "ollama DOWN"
	@echo "-- db --";       $(COMPOSE) exec -T db psql -U $${POSTGRES_USER:-geoark} -d $${POSTGRES_DB:-mygisdb} \
	  -c "select extname from pg_extension order by 1;" || echo "db DOWN"
	@echo "-- web --";      curl -sf -o /dev/null -w "nginx HTTP %{http_code}\n" localhost:$${WEB_PORT:-8080}/ || echo "web DOWN"

models:          ## Warm the model volumes (idempotent; run once after first up)
	$(COMPOSE) --profile setup run --rm model-init

reindex:         ## Force-rebuild the catalog embedding matrix
	$(COMPOSE) exec -T embedder python -c \
	  "import urllib.request as u; print(u.urlopen(u.Request('http://localhost:8000/corpus?force=true', method='POST')).read().decode())"

automl:          ## Start the optional AutoGluon service (heavy image, ~4 GB)
	$(COMPOSE) --profile automl up -d --build automl

psql:            ## Open a psql shell on the database
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-geoark} -d $${POSTGRES_DB:-mygisdb}

shell-db:        ## Shell into the db container
	$(COMPOSE) exec db bash

load-geo:        ## Load HSIP shapefiles/geodatabases into PostGIS (slow; needs GEODATA_DIR)
	$(COMPOSE) --profile etl run --rm etl-geo

relink-features: ## Re-link facility tables only (fast; run after load-geo)
	$(COMPOSE) --profile etl run --rm etl \
	  python /app/etl/load_reference_data.py --acs-csv /data/fips_merged_ACS_data.csv --features-only

county-values-dry: ## Report what load_county_values would load, writing nothing
	MSYS_NO_PATHCONV=1 $(COMPOSE) --profile etl run --rm --entrypoint python3 etl-geo \
	  /app/etl/load_county_values.py --source-dir $(or $(SRC),/data/county_csv)

county-values:   ## Load USDA ERS / CDC PLACES / County Health Rankings county CSVs
	MSYS_NO_PATHCONV=1 $(COMPOSE) --profile etl run --rm --entrypoint python3 etl-geo \
	  /app/etl/load_county_values.py --source-dir $(or $(SRC),/data/county_csv) --commit
	@echo "  now register them for SEARCH (the catalog is mounted read-only in"
	@echo "  the containers, so this half runs on the host):"
	@echo "    python3 etl/load_county_values.py --source-dir geospatial_database_data/county_csv \\"
	@echo "        --catalog-only --catalog backend/geoark_attributes.csv"
	@echo "    make reindex && make up-gpu"

# SEMMED_FILE is relative to SEMMED_DIR (mounted at /semmed). UMLS_KB is
# optional; without it only SemMedDB's preferred names link, see docs/EXPANSION.md.
SEMMED_FILE ?= semmedVER43_2024_R_PREDICATION.csv.gz
semmed-dry:      ## Report what the literature-expansion index would hold, writing nothing
	MSYS_NO_PATHCONV=1 $(COMPOSE) --profile etl run --rm etl 	  python /app/etl/build_semmed_index.py --semmed /semmed/$(SEMMED_FILE)

semmed:          ## Build the SemMedDB literature-expansion index (minutes, once)
	MSYS_NO_PATHCONV=1 $(COMPOSE) --profile etl run --rm etl 	  python /app/etl/build_semmed_index.py --semmed /semmed/$(SEMMED_FILE) 	    $(if $(UMLS_KB),--umls-kb /semmed/$(UMLS_KB)) --commit

add-year:        ## One-time migration: add the year dimension to county values
	$(COMPOSE) exec -T db psql -v ON_ERROR_STOP=1 -U $${POSTGRES_USER:-geoark} \
	  -d $${POSTGRES_DB:-mygisdb} < ../etl/add_year_dimension.sql

# Piped over stdin rather than -f: the db container mounts pgdata and its init
# directory, not the repo, so the file does not exist inside it.
neighbors:       ## Build county adjacency (needed by the hotspot op)
	$(COMPOSE) exec -T db psql -v ON_ERROR_STOP=1 -U $${POSTGRES_USER:-geoark} \
	  -d $${POSTGRES_DB:-mygisdb} < ../etl/county_neighbors.sql

boundaries:      ## Load TIGER named boundaries (places, ZIPs, metros) into place_geom
	$(COMPOSE) --profile etl run --rm --entrypoint python3 etl-geo \
	  /app/etl/load_boundaries.py --source-dir /incoming --commit

boundaries-dry:  ## Report what load_boundaries would load, writing nothing
	$(COMPOSE) --profile etl run --rm --entrypoint python3 etl-geo \
	  /app/etl/load_boundaries.py --source-dir /incoming

inspect:         ## Inspect a dataset without loading it. FILE=... NAME="..."
	$(COMPOSE) --profile etl run --rm etl-geo \
	  python3 /app/etl/ingest.py --file "$(FILE)" --name "$(NAME)" $(ARGS)

ingest:          ## Load a dataset end to end. FILE=... NAME="..." [ENTITY=COUNTY]
	$(COMPOSE) --profile etl run --rm etl-geo \
	  python3 /app/etl/ingest.py --file "$(FILE)" --name "$(NAME)" \
	    --entity-type "$(or $(ENTITY),COUNTY)" --commit $(ARGS)
	$(MAKE) relink
	$(MAKE) reindex
	@echo "  Restart the API to pick up the new corpus:  make up"

relink:          ## Rebuild attribute_source only (no re-import of the 10.8M ACS rows)
	$(COMPOSE) --profile etl run --rm etl \
	  python /app/etl/load_reference_data.py --acs-csv /data/fips_merged_ACS_data.csv --relink-only

load-reference:  ## Load county geometry, ACS values, and the catalog->column map
	$(COMPOSE) --profile etl run --rm etl \
	  python /app/etl/load_reference_data.py --acs-csv /data/fips_merged_ACS_data.csv

load-reference-dry: ## Report the catalog join rate without writing
	$(COMPOSE) --profile etl run --rm etl \
	  python /app/etl/load_reference_data.py --acs-csv /data/fips_merged_ACS_data.csv --dry-run

shell-api:       ## Shell into the API container
	$(COMPOSE) exec api sh

shell-embed:     ## Shell into the embedder container
	$(COMPOSE) exec embedder bash

clean:           ## DESTRUCTIVE: remove containers AND volumes (re-downloads all models)
	@printf 'This deletes model weights, embeddings, and the database. Type YES: ' && \
	  read ans && [ "$$ans" = YES ] && $(COMPOSE) down -v || echo "aborted"
