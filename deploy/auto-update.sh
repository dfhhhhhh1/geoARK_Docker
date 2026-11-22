#!/usr/bin/env bash
# Pull new commits for the deployed branch and rebuild/restart only the
# docker services whose files changed. Meant to run hourly from cron:
#
#   0 * * * * /scratch/GeoARKOct2025/app/deploy/auto-update.sh
#
# Flags:  --dry-run   show what would be rebuilt, change nothing
#         --force     rebuild + restart everything even if nothing changed
set -uo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
export GIT_TERMINAL_PROMPT=0

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
LOG_FILE="${AUTO_UPDATE_LOG:-$REPO_DIR/../auto-update.log}"
LOCK_FILE="/tmp/geoark-auto-update.lock"

DRY_RUN=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

# Log to file (and to the terminal when run by hand)
if [ -t 1 ]; then exec > >(tee -a "$LOG_FILE") 2>&1; else exec >>"$LOG_FILE" 2>&1; fi
log() { echo "[$(date '+%F %T')] $*"; }

# One run at a time — a slow build must not overlap the next cron tick
exec 9>"$LOCK_FILE"
if ! flock -n 9; then log "another update is running, skipping"; exit 0; fi

cd "$REPO_DIR" || { log "repo dir missing: $REPO_DIR"; exit 1; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if ! timeout 120 git fetch --quiet origin "$BRANCH"; then
  log "git fetch failed"; exit 1
fi

OLD="$(git rev-parse HEAD)"
BEHIND="$(git rev-list --count HEAD..@{u})"

if [ "$BEHIND" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  exit 0   # nothing new; stay quiet so the log only records real updates
fi

log "=== $BEHIND new commit(s) on origin/$BRANCH ==="
git --no-pager log --oneline HEAD..@{u}

if [ "$DRY_RUN" -eq 1 ]; then
  CHANGED="$(git diff --name-only HEAD @{u})"
else
  # --rebase keeps any local, unpushed commits on top of the new upstream ones
  if ! git pull --rebase --autostash --quiet origin "$BRANCH"; then
    log "ERROR: pull failed (conflict?). Aborting rebase; deployment left as-is."
    git rebase --abort 2>/dev/null
    exit 1
  fi
  CHANGED="$(git diff --name-only "$OLD" HEAD)"
fi

# ---- decide which services need rebuilding --------------------------------
declare -A BUILD=()
RECREATE_ALL=0
CSV_CHANGED=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ "$f" = "backend/geoark_attributes.csv" ] && CSV_CHANGED=1
  case "$f" in
    frontend/*|deploy/web.Dockerfile)            BUILD[web]=1 ;;
    backend/*|deploy/api.Dockerfile)             BUILD[api]=1 ;;
    deploy/automl.Dockerfile)                    BUILD[automl]=1 ;;
    deploy/embedder/*)                           BUILD[embedder]=1 ;;
    deploy/db/*)                                 BUILD[db]=1 ;;
    etl/*|deploy/etl.Dockerfile|deploy/etl-gdal.Dockerfile) BUILD[etl]=1; BUILD[etl-geo]=1 ;;
    deploy/docker-compose*.yml)                  RECREATE_ALL=1 ;;
  esac
done <<< "$CHANGED"
# automl shares backend/ as its build context
[ -n "${BUILD[api]:-}" ] && BUILD[automl]=1

if [ "$FORCE" -eq 1 ]; then BUILD=([web]=1 [api]=1 [embedder]=1 [db]=1); RECREATE_ALL=1; fi

SERVICES="${!BUILD[*]}"
log "rebuild: ${SERVICES:-none}   compose changed: $RECREATE_ALL"

if [ "$DRY_RUN" -eq 1 ]; then log "dry run, stopping here"; exit 0; fi
if [ -z "$SERVICES" ] && [ "$RECREATE_ALL" -eq 0 ]; then
  log "no docker-relevant changes (docs/eval only)"; exit 0
fi

# ---- build + restart -------------------------------------------------------
cd "$DEPLOY_DIR"   # picks up .env (COMPOSE_FILE with GPU overlay, ports, models)
DC=(docker compose --profile etl --profile automl)

if [ -n "$SERVICES" ]; then
  if ! "${DC[@]}" build $SERVICES; then
    log "ERROR: build failed; running containers were NOT touched"; exit 1
  fi
fi

# Plain `up -d` (default profile only) recreates any container whose image or
# compose config changed and leaves the rest running. etl/automl images are
# rebuilt above but only start when you run them on purpose.
if ! docker compose up -d --remove-orphans; then
  log "WARNING: docker compose up failed (a service was probably unhealthy); trying to recover"
fi

# The catalog CSV is bind-mounted as a single file. git replaces it with a new
# file on pull, and the running embedder/api keep reading the OLD one until
# their containers restart (embedder 7,098 rows vs api 7,450 -> the api exits
# "corpus/CSV row mismatch" and crash-loops). Restart both so they re-read it.
# `restart` keeps the container config, so the GPU overlay is not lost.
if [ "$CSV_CHANGED" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
  log "catalog CSV changed: restarting embedder and api so they re-read it"
  WANT="$(python3 -c "import csv,sys;print(sum(1 for _ in csv.DictReader(open('$REPO_DIR/backend/geoark_attributes.csv', newline='', encoding='utf-8'))))" 2>/dev/null)"
  docker compose restart embedder
  for _ in $(seq 1 60); do
    HAVE="$(docker compose exec -T embedder python -c "import urllib.request,json;print(json.load(urllib.request.urlopen('http://localhost:8000/health')).get('corpus_rows',''))" 2>/dev/null)"
    [ -n "$WANT" ] && [ "$HAVE" = "$WANT" ] && break
    sleep 5
  done
  [ "$HAVE" = "$WANT" ] || log "WARNING: embedder has ${HAVE:-none} rows, catalog has ${WANT:-?}"
  docker compose restart api
fi

# web waits for a healthy api, so a bad first start leaves it Created and never
# started. Wait for the api, then bring up whatever is missing (no recreate of
# healthy services, so ollama keeps its GPU).
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' geoark-api-1 2>/dev/null)" = "healthy" ] && break
  sleep 5
done
docker compose up -d --remove-orphans || log "ERROR: docker compose up failed after recovery"

sleep 20
docker compose ps --format '  {{.Service}}: {{.State}} {{.Status}}'
# Compare against the default-profile services only (one-off etl/setup
# containers are expected to be exited)
NOT_RUNNING="$(comm -23 <(docker compose config --services | sort) \
                        <(docker compose ps --status running --services | sort) | xargs)"
if [ -n "$NOT_RUNNING" ]; then
  log "WARNING: not running after update: $NOT_RUNNING"; exit 1
fi

docker image prune -f >/dev/null   # drop the dangling images left by rebuilds
log "update complete -> $(git -C "$REPO_DIR" rev-parse --short HEAD)"
