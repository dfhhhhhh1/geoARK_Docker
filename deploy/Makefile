# GeoARK deployment helpers. Run from ./deploy on the server.
COMPOSE := docker compose
DEV     := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: help up down dev build logs ps health models automl load-reference load-reference-dry shell-api shell-embed shell-db reindex psql clean

help:            ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up:              ## Build and start everything
	$(COMPOSE) up -d --build

down:            ## Stop everything (volumes survive — models are NOT re-downloaded)
	$(COMPOSE) down

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
