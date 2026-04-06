#!/usr/bin/env bash
# =============================================================================
# install.sh — One-line installer for MonitorAvaliabilityWeb
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/agenciaredlab/MonitorAvaliabilityWeb/main/scripts/install.sh | bash
#
# Or from inside the repo:
#   bash scripts/install.sh
#
# Automatically detects:
#   - Docker Swarm + Traefik  → deploys stack.yml     (TLS via Let's Encrypt)
#   - Docker Swarm standalone → deploys stack.standalone.yml
#   - Docker Compose + Traefik → generates override with Traefik labels
#   - Docker Compose           → deploys docker-compose.yml (direct port)
#
# Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✔${RESET} $*"; }
info() { echo -e "${BLUE}ℹ${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✖${RESET} $*" >&2; }
step() { echo -e "\n${CYAN}${BOLD}▶ $*${RESET}"; }
die()  { err "$*"; exit 1; }

REPO_URL="https://github.com/agenciaredlab/MonitorAvaliabilityWeb.git"
INSTALL_DIR="${MAW_DIR:-/opt/monitoravaliabilityweb}"
STACK_NAME="uptime-monitor"

echo -e "
${CYAN}${BOLD}╔══════════════════════════════════════════════════════╗
║       MonitorAvaliabilityWeb  —  Installer           ║
║   Created by Agencia Redlab                          ║
║   Developed by Juan Camilo Medina Godoy              ║
╚══════════════════════════════════════════════════════╝${RESET}
"

# ── Step 1: Prerequisites ─────────────────────────────────────────────────────
step "Checking prerequisites"

command -v docker &>/dev/null   || die "Docker not installed. See https://docs.docker.com/engine/install/"
docker info &>/dev/null         || die "Docker daemon is not running. Start it first."
ok "Docker: $(docker --version | head -1)"

if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  die "Docker Compose not found. See https://docs.docker.com/compose/install/"
fi
ok "Docker Compose: $($COMPOSE version | head -1)"

# ── Step 2: Clone or update repo ──────────────────────────────────────────────
step "Setting up application files"

if [ -f "$(pwd)/src/scheduler.js" ]; then
  INSTALL_DIR="$(pwd)"
  info "Running from existing repo at $INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation at $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not pull latest. Continuing."
else
  info "Cloning repository to $INSTALL_DIR ..."
  if command -v git &>/dev/null; then
    git clone "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone repository"
  else
    mkdir -p "$INSTALL_DIR"
    curl -sSL "https://github.com/agenciaredlab/MonitorAvaliabilityWeb/archive/refs/heads/main.tar.gz" \
      | tar -xz -C "$INSTALL_DIR" --strip-components=1 || die "Failed to download repository"
  fi
fi
ok "Files ready at $INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Step 3: Network detection ─────────────────────────────────────────────────
step "Detecting Docker environment"

# Run detect-network.sh quietly, capture only the JSON block at the end
DETECT_JSON=$(bash scripts/detect-network.sh --json 2>/dev/null | grep -A 20 '^{' | head -20 || true)

# Parse JSON fields (no jq required)
_jval() { echo "$DETECT_JSON" | grep "\"$1\"" | grep -o 'true\|false\|"[^"]*"' | tail -1 | tr -d '"'; }

SWARM_ACTIVE=$(_jval swarm_active)
SWARM_ROLE=$(_jval swarm_role)
TRAEFIK_NETWORK=$(_jval traefik_network)   # traefik-public overlay exists
TRAEFIK_RUNNING=$(_jval traefik_running)   # traefik container running

# Additional check: detect Traefik in non-Swarm compose environments
TRAEFIK_COMPOSE_NET=""
if [ "$SWARM_ACTIVE" != "true" ]; then
  # Find a running Traefik container (any name containing "traefik")
  TRAEFIK_CID=$(docker ps --filter "name=traefik" --format '{{.ID}}' 2>/dev/null | head -1 || true)
  if [ -n "$TRAEFIK_CID" ]; then
    TRAEFIK_RUNNING="true"
    # Get the non-default network Traefik is attached to
    TRAEFIK_COMPOSE_NET=$(docker inspect "$TRAEFIK_CID" \
      --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
      | tr ' ' '\n' | grep -v '^bridge$' | grep -v '^host$' | grep -v '^none$' | grep -v '^$' | head -1 || true)
  fi
fi

# Determine deployment strategy
if   [ "$SWARM_ACTIVE" = "true" ] && [ "$TRAEFIK_NETWORK" = "true" ]; then
  STRATEGY="swarm-traefik"
elif [ "$SWARM_ACTIVE" = "true" ]; then
  STRATEGY="swarm-standalone"
elif [ "$TRAEFIK_RUNNING" = "true" ]; then
  STRATEGY="compose-traefik"
else
  STRATEGY="compose"
fi

# Report what was found
echo ""
case "$STRATEGY" in
  swarm-traefik)
    ok "Docker Swarm ACTIVE (role: $SWARM_ROLE)"
    ok "Traefik network 'traefik-public' found"
    echo -e "  ${GREEN}${BOLD}→ Strategy: Swarm + Traefik (TLS auto via Let's Encrypt)${RESET}"
    ;;
  swarm-standalone)
    ok "Docker Swarm ACTIVE (role: $SWARM_ROLE)"
    warn "Traefik network 'traefik-public' NOT found"
    echo -e "  ${YELLOW}${BOLD}→ Strategy: Swarm standalone (direct port mapping)${RESET}"
    ;;
  compose-traefik)
    ok "Docker Compose mode"
    ok "Traefik container detected${TRAEFIK_COMPOSE_NET:+ on network '$TRAEFIK_COMPOSE_NET'}"
    echo -e "  ${GREEN}${BOLD}→ Strategy: Docker Compose + Traefik (reverse proxy)${RESET}"
    ;;
  compose)
    ok "Docker Compose mode"
    info "No Traefik detected"
    echo -e "  ${BLUE}${BOLD}→ Strategy: Docker Compose (direct port mapping)${RESET}"
    ;;
esac
echo ""

# Warn if Swarm worker (can't deploy stacks from worker)
if [ "$SWARM_ACTIVE" = "true" ] && [ "$SWARM_ROLE" = "worker" ]; then
  die "This node is a Swarm WORKER. Stack deployments must be run from a manager node."
fi

# ── Step 4: Configuration wizard ──────────────────────────────────────────────
step "Configuration"

if [ -f ".env" ]; then
  read -rp "Existing .env found — keep it? [Y/n]: " KEEP_ENV
  KEEP_ENV="${KEEP_ENV:-Y}"
  [[ "$KEEP_ENV" =~ ^[Yy]$ ]] && SKIP_CONFIG=true || SKIP_CONFIG=false
else
  SKIP_CONFIG=false
fi

# Variables we'll need later
APP_PORT="3000"
DOMAIN=""

if [ "$SKIP_CONFIG" = false ]; then
  echo -e "${BOLD}Press Enter to accept defaults [shown in brackets].${RESET}\n"

  # Domain (only for Traefik strategies)
  if [[ "$STRATEGY" == *traefik* ]]; then
    while true; do
      read -rp "Domain for this app (e.g. monitor.yourdomain.com): " DOMAIN
      [ -n "$DOMAIN" ] && break
      warn "Domain is required for Traefik deployment."
    done
  fi

  # Port (only for non-Traefik)
  if [[ "$STRATEGY" != *traefik* ]]; then
    read -rp "HTTP port [3000]: " APP_PORT
    APP_PORT="${APP_PORT:-3000}"
  fi

  # DB password
  DEFAULT_PASS=$(openssl rand -hex 8 2>/dev/null || echo "securepass123")
  read -rp "PostgreSQL password [$DEFAULT_PASS]: " DB_PASS
  DB_PASS="${DB_PASS:-$DEFAULT_PASS}"

  # Email alerts
  echo ""
  echo -e "${CYAN}Email alerts — leave blank to skip:${RESET}"
  read -rp "  SMTP host [smtp.gmail.com]: " SMTP_HOST; SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
  read -rp "  SMTP port [587]: " SMTP_PORT; SMTP_PORT="${SMTP_PORT:-587}"
  read -rp "  SMTP user (email): " SMTP_USER; SMTP_USER="${SMTP_USER:-}"
  if [ -n "$SMTP_USER" ]; then
    read -rsp "  SMTP password: " SMTP_PASS; echo ""; SMTP_PASS="${SMTP_PASS:-}"
    read -rp "  Alert destination email: " ALERT_EMAIL; ALERT_EMAIL="${ALERT_EMAIL:-}"
  else
    SMTP_PASS=""; ALERT_EMAIL=""; warn "Email alerts disabled."
  fi

  # Slack
  echo ""
  read -rp "Slack webhook URL (leave blank to skip): " SLACK_WEBHOOK; SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"

  # API key auth
  read -rp "Require API key? [y/N]: " REQ_KEY
  REQUIRE_API_KEY="false"; [[ "${REQ_KEY:-}" =~ ^[Yy]$ ]] && REQUIRE_API_KEY="true"

  # Write .env
  cat > .env <<EOF
# Generated by install.sh — $(date)
# MonitorAvaliabilityWeb | Created by Agencia Redlab | Dev: Juan Camilo Medina Godoy

DATABASE_URL=postgres://monitor_user:${DB_PASS}@db:5432/monitor_db
PORT=${APP_PORT}
DOMAIN=${DOMAIN}

SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
ALERT_EMAIL=${ALERT_EMAIL}
SLACK_WEBHOOK=${SLACK_WEBHOOK}

REQUIRE_API_KEY=${REQUIRE_API_KEY}
RETENTION_CHECKS_DAYS=90
RETENTION_ALERTS_DAYS=180
RETENTION_INCIDENTS_DAYS=365

POSTGRES_DB=monitor_db
POSTGRES_USER=monitor_user
POSTGRES_PASSWORD=${DB_PASS}
REGISTRY_IMAGE=uptime-monitor:local
EOF
  ok ".env created"
fi

# Read values from .env for later use
APP_PORT=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3000")
DOMAIN=$(grep '^DOMAIN=' .env 2>/dev/null | cut -d= -f2 || echo "")

# ── Step 5: Build image locally ───────────────────────────────────────────────
step "Building Docker image"

# For Swarm strategies we need a named image (can't use build: in stack deploy)
if [[ "$STRATEGY" == swarm* ]]; then
  info "Building local image 'uptime-monitor:local' for Swarm deployment..."
  docker build -t uptime-monitor:local . || die "Docker build failed"
  ok "Image built: uptime-monitor:local"
else
  info "Image will be built by Docker Compose..."
  # Pre-build for faster compose up
  $COMPOSE build --no-cache app || die "Docker build failed"
  ok "Image built"
fi

# ── Step 6: Deploy ────────────────────────────────────────────────────────────
step "Deploying"

case "$STRATEGY" in

  swarm-traefik)
    info "Ensuring traefik-public network exists..."
    docker network create --driver overlay --attachable traefik-public 2>/dev/null || true
    ok "Network traefik-public ready"

    info "Deploying stack '$STACK_NAME' with Traefik..."
    set -a; source .env; set +a
    docker stack deploy -c stack.yml "$STACK_NAME" || die "Stack deploy failed"
    ok "Stack deployed: $STACK_NAME"
    ACCESS_URL="https://${DOMAIN}"
    ;;

  swarm-standalone)
    info "Deploying stack '$STACK_NAME' (standalone)..."
    set -a; source .env; set +a
    docker stack deploy -c stack.standalone.yml "$STACK_NAME" || die "Stack deploy failed"
    ok "Stack deployed: $STACK_NAME"
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")
    ACCESS_URL="http://${SERVER_IP}:${APP_PORT}"
    ;;

  compose-traefik)
    # Generate docker-compose.override.yml with Traefik labels
    info "Generating Traefik override for Docker Compose..."
    TRAEFIK_NET="${TRAEFIK_COMPOSE_NET:-traefik-public}"
    cat > docker-compose.override.yml <<EOF
# Auto-generated by install.sh — Traefik integration
# MonitorAvaliabilityWeb | Created by Agencia Redlab

version: '3.8'
services:
  app:
    networks:
      - monitor-net
      - ${TRAEFIK_NET}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.uptime-monitor.rule=Host(\`${DOMAIN}\`)"
      - "traefik.http.routers.uptime-monitor.entrypoints=websecure"
      - "traefik.http.routers.uptime-monitor.tls.certresolver=letsencrypt"
      - "traefik.http.services.uptime-monitor.loadbalancer.server.port=3000"
    ports: []

networks:
  ${TRAEFIK_NET}:
    external: true
EOF
    ok "docker-compose.override.yml created (Traefik labels + network: $TRAEFIK_NET)"

    $COMPOSE down --remove-orphans 2>/dev/null || true
    $COMPOSE up -d || die "docker compose up failed"
    ok "Services started"
    ACCESS_URL="https://${DOMAIN}"
    ;;

  compose)
    $COMPOSE down --remove-orphans 2>/dev/null || true
    $COMPOSE up -d || die "docker compose up failed"
    ok "Services started"
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")
    ACCESS_URL="http://${SERVER_IP}:${APP_PORT}"
    ;;
esac

# ── Step 7: Health check ──────────────────────────────────────────────────────
step "Waiting for application to be ready"

# For Swarm, check on local port if mapped; otherwise check via domain
HEALTH_URL="http://localhost:${APP_PORT}/api/stats"
[[ "$STRATEGY" == *traefik* ]] && HEALTH_URL="http://localhost:3000/api/stats"

MAX_WAIT=90; WAITED=0; HEALTHY=false
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -sf "$HEALTH_URL" &>/dev/null; then
    HEALTHY=true; break
  fi
  printf "."; sleep 3; WAITED=$((WAITED + 3))
done
echo ""

if [ "$HEALTHY" = false ]; then
  warn "App did not respond within ${MAX_WAIT}s — it may still be starting."
  case "$STRATEGY" in
    swarm*) info "Check: docker service logs ${STACK_NAME}_app" ;;
    *)      info "Check: $COMPOSE logs -f app" ;;
  esac
else
  ok "Application is healthy!"
fi

# ── Step 8: Summary ───────────────────────────────────────────────────────────
LOGS_CMD="$COMPOSE logs -f app"
STOP_CMD="$COMPOSE down"
UPDATE_CMD="bash ${INSTALL_DIR}/scripts/install.sh"
[[ "$STRATEGY" == swarm* ]] && LOGS_CMD="docker service logs -f ${STACK_NAME}_app"
[[ "$STRATEGY" == swarm* ]] && STOP_CMD="docker stack rm $STACK_NAME"

echo -e "
${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗
║           Installation complete! 🎉                  ║
╚══════════════════════════════════════════════════════╝${RESET}

${BOLD}Strategy:${RESET}     ${CYAN}${STRATEGY}${RESET}
${BOLD}Dashboard:${RESET}    ${CYAN}${ACCESS_URL}${RESET}
${BOLD}Status Page:${RESET}  ${CYAN}${ACCESS_URL}/status${RESET}
${BOLD}API:${RESET}          ${CYAN}${ACCESS_URL}/api/stats${RESET}

${BOLD}Useful commands:${RESET}
  Logs:    ${YELLOW}${LOGS_CMD}${RESET}
  Stop:    ${YELLOW}${STOP_CMD}${RESET}
  Update:  ${YELLOW}${UPDATE_CMD}${RESET}

${BOLD}Generate API key:${RESET}
  ${YELLOW}curl -X POST http://localhost:3000/api/keys \\
    -H 'Content-Type: application/json' \\
    -d '{\"name\":\"my-key\"}'${RESET}

${BLUE}Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy${RESET}
"
