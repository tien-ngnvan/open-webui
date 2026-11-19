#!/usr/bin/env bash
#
# build-deploy.sh — End-to-end build & deploy of the branded Open WebUI image
#
# Re-run any time you change code. Docker layer caching keeps unchanged stages
# fast; the branding hook inside the Dockerfile re-applies branding on every
# build and fails fast if upstream drift breaks a patch.
#
# Usage:
#   ./scripts/build-deploy.sh                    # build + deploy
#   ./scripts/build-deploy.sh --slim             # slim image (no ffmpeg/git, much smaller)
#   ./scripts/build-deploy.sh --cuda             # CUDA image
#   ./scripts/build-deploy.sh --no-deploy        # build only
#   ./scripts/build-deploy.sh --no-cache         # full rebuild, ignore cache
#   ./scripts/build-deploy.sh --backup           # snapshot data volume before redeploy
#   ./scripts/build-deploy.sh --push             # push tags to $REGISTRY after build
#   ./scripts/build-deploy.sh -- --build-arg UID=1000   # extra args passed to docker build
#
# Config (env):
#   IMAGE_NAME        image base name                     (default: open-webui-branded)
#   REGISTRY          push target, e.g. ghcr.io/tien-ngnvan (default: unset)
#   COMPOSE_FILE      deploy compose file                 (default: <root>/compose.prod.yaml,
#                                                         auto-generated on first deploy)
#   WEBUI_PORT        host port                           (default: 3000)
#   WEBUI_CONTAINER   container name                      (default: hang-tho)
#   DATA_VOLUME       named volume for /app/backend/data  (default: open-webui)
#
# Data safety: user data lives in the $DATA_VOLUME volume mounted at
# /app/backend/data. Building images and recreating containers never touches
# it. Only `docker volume rm` or `docker compose down -v` delete it.
#
# Requirements: docker (build + compose plugin), node (version lookup).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[build-deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[build-deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[build-deploy]${NC} $*" >&2; }
die()  { echo -e "${RED}[build-deploy]${NC} $*" >&2; exit 1; }
trap 'die "failed at line $LINENO"' ERR

# ── Defaults ─────────────────────────────────────────────────────────────────
IMAGE_NAME="${IMAGE_NAME:-open-webui-branded}"
REGISTRY="${REGISTRY:-}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/compose.prod.yaml}"
WEBUI_PORT="${WEBUI_PORT:-3000}"
WEBUI_CONTAINER="${WEBUI_CONTAINER:-hang-tho}"
DATA_VOLUME="${DATA_VOLUME:-open-webui}"
ENV_FILE="$ROOT_DIR/.env"

USE_SLIM=false
USE_CUDA=false
DO_DEPLOY=true
DO_PUSH=false
DO_BACKUP=false
NO_CACHE=""
EXTRA_BUILD_ARGS=()

# ── Arg parsing ──────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
	case "$1" in
	--slim) USE_SLIM=true ;;
	--cuda) USE_CUDA=true ;;
	--no-deploy) DO_DEPLOY=false ;;
	--push) DO_PUSH=true ;;
	--backup) DO_BACKUP=true ;;
	--no-cache) NO_CACHE="--no-cache" ;;
	-h | --help)
		awk '/^set -euo pipefail/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
		exit 0
		;;
	--)
		shift
		EXTRA_BUILD_ARGS=("$@")
		break
		;;
	*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done

if $USE_SLIM && $USE_CUDA; then
	die "--slim and --cuda are mutually exclusive (the Dockerfile rejects this too)"
fi

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found in PATH"
docker info >/dev/null 2>&1 || die "docker daemon not running"
command -v node >/dev/null 2>&1 || die "node not found in PATH (needed to read package.json version)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
BUILD_CHANNEL="${BUILD_CHANNEL:-release}"

TAGS=("$IMAGE_NAME:$VERSION" "$IMAGE_NAME:latest")
if [ -n "$REGISTRY" ]; then
	TAGS+=("$REGISTRY/$IMAGE_NAME:$VERSION" "$REGISTRY/$IMAGE_NAME:latest")
fi

log "version: $VERSION   image: ${TAGS[0]}"
$USE_SLIM && log "variant: slim"
$USE_CUDA && log "variant: cuda"

# ── Build ────────────────────────────────────────────────────────────────────
BUILD_ARGS=(
	--build-arg "BUILD_HASH=$VERSION"
	--build-arg "BUILD_CHANNEL=$BUILD_CHANNEL"
	--build-arg "USE_SLIM=$USE_SLIM"
	--build-arg "USE_CUDA=$USE_CUDA"
)
for tag in "${TAGS[@]}"; do
	BUILD_ARGS+=(-t "$tag")
done

log "building image (layer cache reuses unchanged stages)…"
docker build $NO_CACHE "${BUILD_ARGS[@]}" "${EXTRA_BUILD_ARGS[@]}" .
ok "built: ${TAGS[*]}"

# ── Push (optional) ──────────────────────────────────────────────────────────
if $DO_PUSH; then
	[ -n "$REGISTRY" ] || die "--push needs REGISTRY env (e.g. REGISTRY=ghcr.io/tien-ngnvan)"
	docker login "$REGISTRY" >/dev/null 2>&1 || warn "not logged in to $REGISTRY — push may fail"
	for tag in "${TAGS[@]}"; do
		case "$tag" in "$REGISTRY"/*) docker push "$tag" ;; esac
	done
	ok "pushed to $REGISTRY"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
ensure_secret_key() {
	# WEBUI_SECRET_KEY must be stable across restarts, or every redeploy logs
	# out all users and invalidates API tokens. Kept in $ENV_FILE, created once.
	if grep -q '^WEBUI_SECRET_KEY=..' "$ENV_FILE" 2>/dev/null; then
		return 0
	fi
	local key
	key="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	if [ -f "$ENV_FILE" ]; then
		echo "WEBUI_SECRET_KEY=$key" >>"$ENV_FILE"
		warn "appended missing WEBUI_SECRET_KEY to $ENV_FILE"
	else
		cat >"$ENV_FILE" <<EOF
# Used by compose.prod.yaml — keep WEBUI_SECRET_KEY stable across redeploys.
WEBUI_SECRET_KEY=$key
# OPENAI_API_BASE_URL=https://api.example.com/v1
# OPENAI_API_KEY=sk-...
EOF
		chmod 600 "$ENV_FILE"
		ok "created $ENV_FILE with a fresh WEBUI_SECRET_KEY"
	fi
}

backup_volume() {
	if ! docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
		warn "volume '$DATA_VOLUME' not found — nothing to back up (first deploy?)"
		return 0
	fi
	mkdir -p "$ROOT_DIR/backups"
	local out="backups/webui-data-$(date +%F-%H%M%S).tar.gz"
	docker run --rm -v "$DATA_VOLUME:/data:ro" -v "$ROOT_DIR/backups:/backup" \
		alpine tar czf "/backup/$out" -C /data .
	ok "backed up volume to $out"
}

deploy_compose() {
	# Generate a minimal prod compose on first run; never overwrite user edits.
	if [ ! -f "$COMPOSE_FILE" ]; then
		cat >"$COMPOSE_FILE" <<'EOF'
# Generated by scripts/build-deploy.sh — edit freely; the script never overwrites it.
# WEBUI_IMAGE, WEBUI_PORT and WEBUI_SECRET_KEY are injected per deploy.
services:
  open-webui:
    image: ${WEBUI_IMAGE}
    container_name: ${WEBUI_CONTAINER:-hang-tho}
    ports:
      - "${WEBUI_PORT:-3000}:8080"
    volumes:
      - data:/app/backend/data
    env_file:
      - .env
    extra_hosts:
      - host.docker.internal:host-gateway
    restart: unless-stopped

volumes:
  data:
    name: open-webui
EOF
		ok "generated $COMPOSE_FILE (edit env/services to taste)"
	fi
	ensure_secret_key
	log "deploying via compose: $(basename "$COMPOSE_FILE")"
	WEBUI_IMAGE="${TAGS[0]}" WEBUI_PORT="$WEBUI_PORT" WEBUI_CONTAINER="$WEBUI_CONTAINER" \
		docker compose -f "$COMPOSE_FILE" up -d
}

deploy_run() {
	# Fallback when no compose file: plain docker run on the same named volume.
	ensure_secret_key
	local secret
	secret="$(grep '^WEBUI_SECRET_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
	docker rm -f "$WEBUI_CONTAINER" >/dev/null 2>&1 || true
	log "deploying via docker run: $WEBUI_CONTAINER"
	docker run -d --name "$WEBUI_CONTAINER" \
		-p "$WEBUI_PORT:8080" \
		-v "$DATA_VOLUME:/app/backend/data" \
		-e "WEBUI_SECRET_KEY=$secret" \
		--add-host=host.docker.internal:host-gateway \
		--restart unless-stopped \
		"${TAGS[0]}"
}

wait_healthy() {
	local url="http://localhost:$WEBUI_PORT/health"
	log "waiting for $url (first start may run DB migrations)…"
	for _ in $(seq 1 60); do
		if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
			ok "healthy at http://localhost:$WEBUI_PORT"
			return 0
		fi
		sleep 2
	done
	warn "not healthy after 120s — check: docker logs $WEBUI_CONTAINER"
	return 1
}

if $DO_DEPLOY; then
	$DO_BACKUP && backup_volume
	if [ -f "$COMPOSE_FILE" ]; then
		deploy_compose
	else
		warn "no $COMPOSE_FILE yet — falling back to docker run"
		deploy_run
	fi
	wait_healthy || true
	# Branding spot-check: /api/config name should be the branded name.
	local_name="$(curl -fsS --max-time 5 "http://localhost:$WEBUI_PORT/api/config" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).name??'')}catch{console.log('')}})" || true)"
	if [ -n "$local_name" ]; then
		log "branding check — /api/config name: $local_name"
	fi
	ok "done. Image: ${TAGS[0]}  Data volume: $DATA_VOLUME (untouched)"
else
	ok "build only — skipping deploy"
fi
