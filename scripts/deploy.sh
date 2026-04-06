#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Smart deployment script for MonitorAvaliabilityWeb
#
# Detects the Docker/Traefik environment and deploys the correct stack file
# without breaking existing applications already running on the server.
#
# Usage:
#   ./scripts/deploy.sh              # interactive mode
#   ./scripts/deploy.sh --yes        # non-interactive (accept all prompts)
#   ./scripts/deploy.sh --dry-run    # show what would be done, don't deploy
#
# Created by Agencia Redlab
# Developed by Juan Camilo Medina Godoy
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET}  $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "${RED}✗${RESET}  $*"; }
info() { echo -e "${BLUE}ℹ${RESET}  $*"; }
die()  { err "$*"; exit 1; }

# ── Flags ─────────────────────────────────────────────────────────────────────
YES_FLAG=false
DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --yes)     YES_FLAG=true ;;
    --dry-run) DRY_RUN=true  ;;
  esac
done

confirm() {
  local prompt="$1"
  if $YES_FLAG; then echo -e "${YELLOW}⚠${RESET}  $prompt → auto-yes"; return 0; fi
  read -rp "$(echo -e "${YELLOW}?${RESET}  $prompt [y/N] ")" answer
  [[ "${answer,,}" == "y" ]]
}

run() {
  if $DRY_RUN; then
    echo -e "  ${BOLD}[DRY-RUN]${RESET} $*"
  else
    eval "$*"
  fi
}

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  MonitorAvaliabilityWeb — Smart Deploy               ║${RESET}"
echo -e "${BOLD}║  Created by Agencia Redlab                           ║${RESET}"
echo -e "${BOLD}║  Developed by Juan Camilo Medina Godoy               ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Load .env ─────────────────────────────────────────────────────────────────
if [[ -f ".env" ]]; then
  ok "Loading .env file…"
  set -a; source .env; set +a
else
  warn ".env file not found."
  info "Copy the template: cp .env.example .env && nano .env"
  if ! confirm "Continue without .env?"; then
    die "Aborted. Please create .env first."
  fi
fi

# ── Validate critical env vars ────────────────────────────────────────────────
echo ""
info "Validating environment variables…"

if [[ -z "${DATABASE_URL:-}" ]]; then
  die "DATABASE_URL is not set. Edit .env and set DATABASE_URL=postgres://user:pass@host:5432/dbname"
fi
ok "DATABASE_URL is set."

# ── Run network detector ──────────────────────────────────────────────────────
echo ""
info "Running network detection…"
echo ""

# Capture JSON output from detector
DETECT_JSON=$(bash "$SCRIPT_DIR/detect-network.sh" --json 2>/dev/null | \
  tail -n 20 | grep -A 20 '^{' || echo '{}')

# Parse JSON fields with simple grep (no jq dependency)
get_field() { echo "$DETECT_JSON" | grep "\"$1\"" | sed 's/.*: *\([^,}]*\).*/\1/' | tr -d ' "' | head -1; }

DOCKER_AVAILABLE=$(get_field docker_available)
SWARM_ACTIVE=$(get_field swarm_active)
SWARM_ROLE=$(get_field swarm_role)
TRAEFIK_NETWORK=$(get_field traefik_network)
PORT_CONFLICT=$(get_field port_conflict)
RECOMMENDED_CMD=$(get_field recommended_command)

# ── Handle port conflict ──────────────────────────────────────────────────────
if [[ "$PORT_CONFLICT" == "true" ]]; then
  echo ""
  warn "Port ${PORT:-3000} conflict detected."
  info "In Swarm mode with Traefik this usually doesn't matter (Traefik handles routing)."
  if ! confirm "Continue anyway?"; then
    die "Aborted. Fix the port conflict or set a different PORT in .env."
  fi
fi

# ── Choose deployment strategy ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD} Deployment Strategy${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"

DEPLOY_MODE="compose"
STACK_FILE=""

if [[ "$DOCKER_AVAILABLE" != "true" ]]; then
  die "Docker not available. Install Docker first: https://docs.docker.com/engine/install/"
fi

if [[ "$SWARM_ACTIVE" == "true" ]]; then
  if [[ "$SWARM_ROLE" == "worker" ]]; then
    die "This node is a Swarm WORKER. Run deploy.sh from a manager node."
  fi

  if [[ "$TRAEFIK_NETWORK" == "true" ]]; then
    # Full Swarm + Traefik deployment
    DEPLOY_MODE="swarm-traefik"
    STACK_FILE="stack.yml"
    ok "Strategy: Docker Swarm + Traefik (full production mode)"

    # Validate DOMAIN
    if [[ -z "${DOMAIN:-}" ]]; then
      warn "DOMAIN is not set in .env — Traefik routing label will use default: monitor.example.com"
      warn "Set DOMAIN=your.actual.domain for HTTPS to work."
    else
      ok "Domain: ${DOMAIN}"
    fi

    # Validate REGISTRY_IMAGE
    if [[ -z "${REGISTRY_IMAGE:-}" ]]; then
      warn "REGISTRY_IMAGE is not set — will build locally with tag uptime-monitor:latest"
      REGISTRY_IMAGE="uptime-monitor:latest"
    else
      ok "Registry image: ${REGISTRY_IMAGE}"
    fi

  else
    # Swarm but no traefik-public network
    DEPLOY_MODE="swarm-standalone"
    warn "Strategy: Docker Swarm — NO Traefik (standalone mode)"
    echo ""
    info "Options:"
    echo "  1) Deploy standalone (no HTTPS, direct port exposure)"
    echo "  2) Create traefik-public network first, then deploy with Traefik"
    echo ""

    if ! $YES_FLAG; then
      read -rp "$(echo -e "${YELLOW}?${RESET}  Choose option [1/2]: ")" choice
    else
      choice="1"
    fi

    if [[ "$choice" == "2" ]]; then
      info "Creating traefik-public overlay network…"
      run "docker network create --driver overlay --attachable traefik-public"
      ok "traefik-public network created."
      DEPLOY_MODE="swarm-traefik"
      STACK_FILE="stack.yml"
    else
      STACK_FILE="stack.standalone.yml"
      if [[ ! -f "$STACK_FILE" ]]; then
        warn "stack.standalone.yml not found — generating from stack.yml without Traefik labels…"
        generate_standalone_stack
      fi
    fi
  fi

else
  # Not Swarm — use docker-compose
  DEPLOY_MODE="compose"
  STACK_FILE="docker-compose.yml"
  ok "Strategy: docker-compose (local/dev mode)"
fi

# ── Build image if needed ─────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD} Build & Deploy${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"

if [[ "$DEPLOY_MODE" == "swarm-traefik" || "$DEPLOY_MODE" == "swarm-standalone" ]]; then
  IMAGE="${REGISTRY_IMAGE:-uptime-monitor:latest}"
  info "Building Docker image: ${IMAGE}…"
  run "docker build -t \"${IMAGE}\" ."
  ok "Image built: ${IMAGE}"

  # Push if registry is remote (contains a dot or slash with registry host)
  if echo "$IMAGE" | grep -qE '^[a-z0-9.-]+\.[a-z]{2,}/|^[a-z0-9.-]+:[0-9]+/'; then
    if confirm "Push image to registry?"; then
      run "docker push \"${IMAGE}\""
      ok "Image pushed."
    fi
  fi
fi

# ── Deploy ────────────────────────────────────────────────────────────────────
echo ""
info "Deploying with: ${STACK_FILE}…"

case "$DEPLOY_MODE" in
  swarm-traefik|swarm-standalone)
    run "docker stack deploy -c \"${STACK_FILE}\" uptime-monitor"
    ;;
  compose)
    run "docker-compose -f \"${STACK_FILE}\" up --build -d"
    ;;
esac

# ── Health check ──────────────────────────────────────────────────────────────
if ! $DRY_RUN; then
  echo ""
  info "Waiting 15 seconds for the app to be ready…"
  sleep 15

  APP_PORT="${PORT:-3000}"
  HEALTH_URL="http://localhost:${APP_PORT}/api/stats"

  info "Health check: ${HEALTH_URL}"
  if curl -sf --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then
    echo ""
    ok "${BOLD}Deployment successful!${RESET}"
    ok "Dashboard:    http://localhost:${APP_PORT}"
    ok "Status page:  http://localhost:${APP_PORT}/status"
    ok "API stats:    ${HEALTH_URL}"
    if [[ -n "${DOMAIN:-}" ]]; then
      ok "Public URL:   https://${DOMAIN}"
    fi
  else
    echo ""
    err "Health check failed — the app may not be running correctly."
    info "Check logs:"

    if [[ "$DEPLOY_MODE" == "compose" ]]; then
      echo ""
      docker-compose logs --tail=30 app 2>/dev/null || true
    else
      echo ""
      docker service logs --tail=30 uptime-monitor_app 2>/dev/null || true
    fi

    info "Common causes:"
    info "  - Database not ready yet (wait a few more seconds and retry)"
    info "  - DATABASE_URL is wrong (check .env)"
    info "  - Port ${APP_PORT} is blocked by firewall"
    exit 1
  fi
fi

echo ""
