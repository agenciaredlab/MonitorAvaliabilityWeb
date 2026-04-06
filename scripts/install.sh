#!/usr/bin/env bash
# =============================================================================
# install.sh — One-line installer for MonitorAvaliabilityWeb
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/agenciaredlab/MonitorAvaliabilityWeb/main/scripts/install.sh | bash
#
# Or if you already cloned the repo:
#   bash scripts/install.sh
#
# Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy
# =============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
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
COMPOSE_FILE="docker-compose.yml"

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "
${CYAN}${BOLD}╔══════════════════════════════════════════════════════╗
║       MonitorAvaliabilityWeb  —  Installer           ║
║   Created by Agencia Redlab                          ║
║   Developed by Juan Camilo Medina Godoy              ║
╚══════════════════════════════════════════════════════╝${RESET}
"

# ── Step 1: Prerequisites ─────────────────────────────────────────────────────
step "Checking prerequisites"

command -v docker &>/dev/null || die "Docker is not installed. Install it from https://docs.docker.com/engine/install/"
ok "Docker found: $(docker --version | head -1)"

# Docker Compose v2 (plugin) or v1 (standalone)
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  die "Docker Compose not found. Install it: https://docs.docker.com/compose/install/"
fi
ok "Docker Compose found: $($COMPOSE version | head -1)"

# Check Docker daemon is running
docker info &>/dev/null || die "Docker daemon is not running. Start it first."
ok "Docker daemon is running"

# ── Step 2: Clone or update repo ──────────────────────────────────────────────
step "Setting up application files"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Found existing installation at $INSTALL_DIR — pulling latest changes..."
  git -C "$INSTALL_DIR" pull --ff-only || warn "Could not pull latest changes. Continuing with existing version."
elif [ -f "$(pwd)/src/scheduler.js" ]; then
  # Running from inside the repo directory
  INSTALL_DIR="$(pwd)"
  info "Running from existing repo at $INSTALL_DIR"
else
  info "Cloning repository to $INSTALL_DIR ..."
  if command -v git &>/dev/null; then
    git clone "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone repository"
  else
    # Fallback: download tarball without git
    info "git not found, downloading tarball..."
    mkdir -p "$INSTALL_DIR"
    curl -sSL "https://github.com/agenciaredlab/MonitorAvaliabilityWeb/archive/refs/heads/main.tar.gz" \
      | tar -xz -C "$INSTALL_DIR" --strip-components=1 \
      || die "Failed to download repository"
  fi
fi
ok "Files ready at $INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Step 3: Interactive configuration ─────────────────────────────────────────
step "Configuration"

# If .env already exists, ask before overwriting
if [ -f ".env" ]; then
  echo -e "${YELLOW}An existing .env file was found.${RESET}"
  read -rp "Do you want to keep it and skip configuration? [Y/n]: " KEEP_ENV
  KEEP_ENV="${KEEP_ENV:-Y}"
  if [[ "$KEEP_ENV" =~ ^[Yy]$ ]]; then
    info "Keeping existing .env file."
    SKIP_CONFIG=true
  else
    SKIP_CONFIG=false
  fi
else
  SKIP_CONFIG=false
fi

if [ "$SKIP_CONFIG" = false ]; then
  echo ""
  echo -e "${BOLD}Press Enter to accept defaults (shown in brackets).${RESET}"
  echo ""

  # Database
  read -rp "PostgreSQL password [$(openssl rand -hex 8 2>/dev/null || echo 'securepass123')]: " DB_PASS
  DB_PASS="${DB_PASS:-$(openssl rand -hex 8 2>/dev/null || echo 'securepass123')}"

  # Port
  read -rp "HTTP port [3000]: " APP_PORT
  APP_PORT="${APP_PORT:-3000}"

  # Email alerts
  echo ""
  echo -e "${CYAN}Email alerts (leave blank to disable):${RESET}"
  read -rp "  SMTP host [smtp.gmail.com]: " SMTP_HOST
  SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
  read -rp "  SMTP port [587]: " SMTP_PORT
  SMTP_PORT="${SMTP_PORT:-587}"
  read -rp "  SMTP user (email): " SMTP_USER
  SMTP_USER="${SMTP_USER:-}"
  if [ -n "$SMTP_USER" ]; then
    read -rsp "  SMTP password: " SMTP_PASS; echo ""
    SMTP_PASS="${SMTP_PASS:-}"
    read -rp "  Alert destination email: " ALERT_EMAIL
    ALERT_EMAIL="${ALERT_EMAIL:-}"
  else
    SMTP_PASS=""
    ALERT_EMAIL=""
    warn "Email alerts disabled (no SMTP user provided)"
  fi

  # Slack
  echo ""
  read -rp "Slack webhook URL (leave blank to skip): " SLACK_WEBHOOK
  SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"

  # API key auth
  echo ""
  read -rp "Require API key for all API calls? [y/N]: " REQ_API_KEY
  REQUIRE_API_KEY="false"
  [[ "$REQ_API_KEY" =~ ^[Yy]$ ]] && REQUIRE_API_KEY="true"

  # Write .env
  cat > .env <<EOF
# Generated by install.sh — $(date)
# MonitorAvaliabilityWeb | Created by Agencia Redlab | Dev: Juan Camilo Medina Godoy

DATABASE_URL=postgres://monitor_user:${DB_PASS}@db:5432/monitor_db
PORT=${APP_PORT}

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
EOF

  # Sync docker-compose db credentials with .env
  ok ".env file created"
fi

# Load PORT for later use
APP_PORT=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3000")

# ── Step 4: Build Docker image ────────────────────────────────────────────────
step "Building Docker image (this may take a minute...)"

$COMPOSE build --no-cache app || die "Docker build failed"
ok "Image built successfully"

# ── Step 5: Start services ────────────────────────────────────────────────────
step "Starting services"

# Stop any previous instance gracefully
$COMPOSE down --remove-orphans 2>/dev/null || true

$COMPOSE up -d || die "Failed to start services"
ok "Services started"

# ── Step 6: Health check ──────────────────────────────────────────────────────
step "Waiting for application to be ready"

MAX_WAIT=60
WAITED=0
HEALTHY=false

while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -sf "http://localhost:${APP_PORT}/api/stats" &>/dev/null; then
    HEALTHY=true
    break
  fi
  printf "."
  sleep 2
  WAITED=$((WAITED + 2))
done
echo ""

if [ "$HEALTHY" = false ]; then
  warn "App did not respond within ${MAX_WAIT}s. Check logs with:"
  echo "  $COMPOSE logs -f app"
  echo ""
  warn "It may still be starting. Try: curl http://localhost:${APP_PORT}/api/stats"
  exit 1
fi

ok "Application is healthy!"

# ── Step 7: Show result ───────────────────────────────────────────────────────
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")

echo -e "
${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗
║           Installation complete! 🎉                  ║
╚══════════════════════════════════════════════════════╝${RESET}

${BOLD}Dashboard:${RESET}     ${CYAN}http://${SERVER_IP}:${APP_PORT}${RESET}
${BOLD}Status Page:${RESET}   ${CYAN}http://${SERVER_IP}:${APP_PORT}/status${RESET}
${BOLD}API:${RESET}           ${CYAN}http://${SERVER_IP}:${APP_PORT}/api/stats${RESET}

${BOLD}Useful commands:${RESET}
  View logs:      ${YELLOW}$COMPOSE -f ${INSTALL_DIR}/${COMPOSE_FILE} logs -f${RESET}
  Stop:           ${YELLOW}$COMPOSE -f ${INSTALL_DIR}/${COMPOSE_FILE} down${RESET}
  Restart:        ${YELLOW}$COMPOSE -f ${INSTALL_DIR}/${COMPOSE_FILE} restart${RESET}
  Update:         ${YELLOW}bash ${INSTALL_DIR}/scripts/install.sh${RESET}

${BOLD}Generate an API key:${RESET}
  ${YELLOW}curl -X POST http://localhost:${APP_PORT}/api/keys -H 'Content-Type: application/json' -d '{\"name\":\"my-key\"}'${RESET}

${BLUE}Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy${RESET}
"
