#!/usr/bin/env bash
# =============================================================================
# detect-network.sh — Docker network & Traefik environment detector
# MonitorAvaliabilityWeb — Uptime Monitoring System
#
# Detects the current Docker network topology so the deploy script can choose
# the right stack file without breaking applications already running on the
# server (e.g. other containers managed by Traefik).
#
# Usage:
#   ./scripts/detect-network.sh          # human-readable output
#   ./scripts/detect-network.sh --json   # add JSON summary at the end
#
# Exit codes:
#   0 — detection complete (use JSON/output to determine next steps)
#   1 — Docker is not available
#
# Created by Agencia Redlab
# Developed by Juan Camilo Medina Godoy
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET}  $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "${RED}✗${RESET}  $*"; }
info() { echo -e "${BLUE}ℹ${RESET}  $*"; }
sep()  { echo -e "${BOLD}────────────────────────────────────────────────────${RESET}"; }

JSON_FLAG=false
[[ "${1:-}" == "--json" ]] && JSON_FLAG=true

# ── Result vars (used for JSON output) ───────────────────────────────────────
DOCKER_AVAILABLE=false
SWARM_ACTIVE=false
SWARM_ROLE="none"
TRAEFIK_NETWORK=false
TRAEFIK_RUNNING=false
MONITOR_INTERNAL=false
PORT_CONFLICT=false
RECOMMENDED_CMD=""

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  MonitorAvaliabilityWeb — Network Detector           ║${RESET}"
echo -e "${BOLD}║  Created by Agencia Redlab                           ║${RESET}"
echo -e "${BOLD}║  Developed by Juan Camilo Medina Godoy               ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── 1. Docker availability ────────────────────────────────────────────────────
sep
echo -e "${BOLD}[1/6] Docker availability${RESET}"
sep

if ! command -v docker &>/dev/null; then
  err "Docker is not installed or not in PATH."
  info "Install Docker: https://docs.docker.com/engine/install/"
  echo ""
  if $JSON_FLAG; then
    echo '{"docker_available":false,"error":"Docker not found"}'
  fi
  exit 1
fi

DOCKER_VERSION=$(docker --version 2>/dev/null || echo "unknown")
ok "Docker found: ${DOCKER_VERSION}"
DOCKER_AVAILABLE=true

# Check if Docker daemon is running
if ! docker info &>/dev/null; then
  err "Docker daemon is not running."
  info "Start it with: sudo systemctl start docker"
  exit 1
fi
ok "Docker daemon is running."

# ── 2. Swarm mode ─────────────────────────────────────────────────────────────
sep
echo -e "${BOLD}[2/6] Docker Swarm mode${RESET}"
sep

SWARM_STATE=$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo "inactive")

if [[ "$SWARM_STATE" == "active" ]]; then
  SWARM_ACTIVE=true
  SWARM_ROLE=$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)
  if [[ "$SWARM_ROLE" == "true" ]]; then
    SWARM_ROLE="manager"
    ok "Docker Swarm: ACTIVE — this node is a MANAGER."
  else
    SWARM_ROLE="worker"
    ok "Docker Swarm: ACTIVE — this node is a WORKER."
    warn "Stack deployments must be run from a manager node."
  fi
else
  info "Docker Swarm: not initialized (standalone mode)."
  info "To init Swarm: docker swarm init"
fi

# ── 3. Existing networks ───────────────────────────────────────────────────────
sep
echo -e "${BOLD}[3/6] Existing Docker networks${RESET}"
sep

echo ""
printf "  %-30s %-10s %-10s\n" "NAME" "DRIVER" "SCOPE"
printf "  %-30s %-10s %-10s\n" "────────────────────────────" "────────" "────────"
docker network ls --format '{{.Name}}\t{{.Driver}}\t{{.Scope}}' 2>/dev/null | \
  while IFS=$'\t' read -r name driver scope; do
    printf "  %-30s %-10s %-10s\n" "$name" "$driver" "$scope"
  done
echo ""

# ── 4. Traefik network check ───────────────────────────────────────────────────
sep
echo -e "${BOLD}[4/6] Traefik integration check${RESET}"
sep

if docker network ls --format '{{.Name}}' 2>/dev/null | grep -q '^traefik-public$'; then
  TRAEFIK_NETWORK=true
  ok "traefik-public network EXISTS — Traefik integration available."
else
  warn "traefik-public network NOT found."

  # Check if Traefik container is running
  TRAEFIK_CONTAINERS=$(docker ps --filter "name=traefik" --format '{{.Names}}' 2>/dev/null)
  if [[ -n "$TRAEFIK_CONTAINERS" ]]; then
    TRAEFIK_RUNNING=true
    warn "Traefik IS running (containers: $TRAEFIK_CONTAINERS) but traefik-public network is missing."
    info "Create the network with:"
    info "  docker network create --driver overlay --attachable traefik-public"
    info "Then redeploy Traefik so it joins this network before deploying this stack."
  else
    info "No Traefik container detected on this node."
    info "You can deploy in standalone mode (no Traefik) or set up Traefik first."
    info "Standalone: use stack.standalone.yml or docker-compose.yml"
  fi
fi

# Check monitor-internal overlay network
if docker network ls --format '{{.Name}}' 2>/dev/null | grep -q '^monitor-internal$'; then
  MONITOR_INTERNAL=true
  ok "monitor-internal overlay network already exists (will be reused)."
else
  info "monitor-internal network not found — will be created on stack deploy."
fi

# ── 5. Port conflict check ────────────────────────────────────────────────────
sep
echo -e "${BOLD}[5/6] Port conflict check${RESET}"
sep

APP_PORT="${PORT:-3000}"

# Check if any running container exposes the app port on the host
if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${APP_PORT}->"; then
  PORT_CONFLICT=true
  CONFLICT_CONTAINER=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | \
    grep ":${APP_PORT}->" | awk '{print $1}' | head -1)
  warn "Port ${APP_PORT} is already mapped by container: ${CONFLICT_CONTAINER}"
  info "Options:"
  info "  1. Set PORT=<other> in .env (e.g. PORT=3001)"
  info "  2. Stop the conflicting container: docker stop ${CONFLICT_CONTAINER}"
  info "  3. In Swarm mode the port conflict is on the ingress — check Traefik routing instead."
else
  ok "Port ${APP_PORT} is free (no container conflict)."
fi

# ── 6. Deployment recommendation ─────────────────────────────────────────────
sep
echo -e "${BOLD}[6/6] Deployment recommendation${RESET}"
sep
echo ""

if $SWARM_ACTIVE && $TRAEFIK_NETWORK; then
  RECOMMENDED_CMD="docker stack deploy -c stack.yml uptime-monitor"
  ok "RECOMMENDED: Full Swarm + Traefik deployment"
  echo ""
  echo -e "  ${BOLD}${GREEN}${RECOMMENDED_CMD}${RESET}"
  echo ""
  info "Make sure DOMAIN and REGISTRY_IMAGE are set in your environment or .env."

elif $SWARM_ACTIVE && ! $TRAEFIK_NETWORK; then
  RECOMMENDED_CMD="docker stack deploy -c stack.standalone.yml uptime-monitor"
  warn "RECOMMENDED: Swarm deployment WITHOUT Traefik (standalone)"
  echo ""
  echo -e "  ${BOLD}${YELLOW}${RECOMMENDED_CMD}${RESET}"
  echo ""
  info "Or create traefik-public network first for full Traefik integration:"
  info "  docker network create --driver overlay --attachable traefik-public"
  info "  docker stack deploy -c stack.yml uptime-monitor"

else
  RECOMMENDED_CMD="docker-compose up --build -d"
  info "RECOMMENDED: Local docker-compose deployment"
  echo ""
  echo -e "  ${BOLD}${BLUE}${RECOMMENDED_CMD}${RESET}"
  echo ""
  info "For production with Swarm: docker swarm init"
fi

echo ""
sep
echo ""

# ── JSON summary ──────────────────────────────────────────────────────────────
if $JSON_FLAG; then
  cat <<EOF
{
  "docker_available":    $DOCKER_AVAILABLE,
  "swarm_active":        $SWARM_ACTIVE,
  "swarm_role":          "$SWARM_ROLE",
  "traefik_network":     $TRAEFIK_NETWORK,
  "traefik_running":     $TRAEFIK_RUNNING,
  "monitor_internal":    $MONITOR_INTERNAL,
  "port_conflict":       $PORT_CONFLICT,
  "app_port":            $APP_PORT,
  "recommended_command": "$RECOMMENDED_CMD"
}
EOF
fi
