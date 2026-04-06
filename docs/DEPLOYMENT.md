# Deployment Guide

**MonitorAvaliabilityWeb — Uptime Monitoring System**
Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy

---

## Overview

The application ships with three deployment modes:

| Mode | File | Use case |
|------|------|----------|
| Local development | `docker-compose.yml` | Single machine, no TLS |
| Swarm + Traefik | `stack.yml` | Production with auto-HTTPS |
| Swarm standalone | `stack.standalone.yml` | Production, TLS handled externally |

> **Important — Coexistence with existing services:**
> Before deploying, always run `./scripts/detect-network.sh` to understand your current Docker network topology. The smart deploy script will never modify or restart existing containers.

---

## 1. Prerequisites

- Docker 24+ (with Docker Compose v2 plugin or `docker-compose` v1.29+)
- For Swarm deployments: at least one Swarm manager node
- For Traefik deployments: Traefik v2 already running and connected to `traefik-public` network

---

## 2. Local Development

```bash
# Clone the repository
git clone https://github.com/agenciaredlab/MonitorAvaliabilityWeb.git
cd MonitorAvaliabilityWeb

# Create environment file
cp .env.example .env
# Edit .env with your settings (DATABASE_URL is pre-configured for docker-compose)

# Start all services (app + PostgreSQL)
docker-compose up --build

# In a different terminal, open the dashboard
open http://localhost:3000
# Status page:
open http://localhost:3000/status
```

The app will:
1. Start PostgreSQL and wait for it to be healthy
2. Run startup checks (port, DB connectivity, env validation)
3. Create all database tables and seed 3 example monitors
4. Start the HTTP server on port 3000
5. Run the first check cycle immediately
6. Schedule checks every 60 seconds, SSL checks every 6 hours, cleanup daily at 3 AM

---

## 3. Detect Your Network Environment

Always run this before any production deployment:

```bash
./scripts/detect-network.sh
```

This will tell you:
- Whether Docker Swarm is active and your node's role (manager/worker)
- Whether `traefik-public` network exists (required for Traefik integration)
- Whether any container is already using port 3000
- The recommended deployment command for your setup

### Output examples

**Server with Swarm + Traefik (recommended for production):**
```
✓  traefik-public network EXISTS — Traefik integration available
✓  Port 3000 is free
RECOMMENDED: docker stack deploy -c stack.yml uptime-monitor
```

**Server with Swarm but no Traefik:**
```
⚠  traefik-public network NOT found
ℹ  No Traefik detected — use stack.standalone.yml
RECOMMENDED: docker stack deploy -c stack.standalone.yml uptime-monitor
```

**Server without Swarm:**
```
ℹ  Docker Swarm: not initialized (standalone mode)
RECOMMENDED: docker-compose up --build -d
```

---

## 4. Smart Deploy Script

For automated deployments use the deploy script which handles everything:

```bash
# Interactive mode
./scripts/deploy.sh

# Non-interactive (CI/CD)
./scripts/deploy.sh --yes

# Preview without executing
./scripts/deploy.sh --dry-run
```

The script:
1. Loads `.env` automatically
2. Validates `DATABASE_URL`
3. Runs network detection
4. Selects the correct stack file
5. Builds and optionally pushes the Docker image
6. Deploys the stack
7. Waits 15 seconds then runs a health check on `/api/stats`
8. Shows container logs if the health check fails

---

## 5. Production — Swarm + Traefik

### Requirements
- Docker Swarm initialized (`docker swarm init`)
- Traefik v2 running and attached to `traefik-public` overlay network
- Docker registry accessible from all Swarm nodes

### Step 1 — Verify Traefik network

```bash
docker network ls | grep traefik-public
```

If it doesn't exist, create it and redeploy Traefik:
```bash
docker network create --driver overlay --attachable traefik-public
```

### Step 2 — Configure environment

```bash
cp .env.example .env
nano .env
```

Required for Swarm + Traefik:
```env
DATABASE_URL=postgres://monitor_user:strong_password@db:5432/monitor_db
DOMAIN=monitor.yourdomain.com
REGISTRY_IMAGE=your-registry/uptime-monitor:latest
POSTGRES_DB=monitor_db
POSTGRES_USER=monitor_user
POSTGRES_PASSWORD=strong_password
```

### Step 3 — Build and push image

```bash
export REGISTRY_IMAGE=your-registry/uptime-monitor:latest
docker build -t $REGISTRY_IMAGE .
docker push $REGISTRY_IMAGE
```

### Step 4 — Deploy the stack

```bash
docker stack deploy -c stack.yml uptime-monitor
```

### Step 5 — Verify deployment

```bash
# Check services
docker stack services uptime-monitor

# Check app logs
docker service logs -f uptime-monitor_app

# Test health endpoint
curl https://monitor.yourdomain.com/api/stats
```

---

## 6. Production — Swarm without Traefik

Use when your server runs Swarm but TLS is handled by nginx, Caddy, or a load balancer.

```bash
# Set port in .env
echo "PORT=3000" >> .env

# Deploy standalone stack (exposes port directly)
docker stack deploy -c stack.standalone.yml uptime-monitor
```

The app will be accessible on `http://<swarm-node-ip>:3000`.

Configure your reverse proxy to forward traffic:

**nginx example:**
```nginx
server {
    listen 443 ssl;
    server_name monitor.yourdomain.com;
    
    ssl_certificate     /etc/letsencrypt/live/monitor.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/monitor.yourdomain.com/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 7. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | Full PostgreSQL connection string |
| `PORT` | ❌ | `3000` | HTTP server port |
| `SMTP_HOST` | ❌ | — | SMTP server hostname |
| `SMTP_PORT` | ❌ | `587` | SMTP port (587=STARTTLS, 465=SSL) |
| `SMTP_USER` | ❌ | — | SMTP username / email address |
| `SMTP_PASS` | ❌ | — | SMTP password or app password |
| `ALERT_EMAIL` | ❌ | — | Destination address for alert emails |
| `SLACK_WEBHOOK` | ❌ | — | Slack incoming webhook URL |
| `REQUIRE_API_KEY` | ❌ | `false` | Set to `true` to enable API key auth |
| `DOMAIN` | ❌ | `monitor.example.com` | Public domain (Traefik routing) |
| `REGISTRY_IMAGE` | ❌ | `uptime-monitor:latest` | Docker image for Swarm deployment |
| `POSTGRES_DB` | ❌ | `monitor_db` | DB name for Swarm `db` service |
| `POSTGRES_USER` | ❌ | `monitor_user` | DB user for Swarm `db` service |
| `POSTGRES_PASSWORD` | ❌ | `monitor_pass` | DB password for Swarm `db` service |
| `RETENTION_CHECKS_DAYS` | ❌ | `90` | Delete check records older than N days |
| `RETENTION_ALERTS_DAYS` | ❌ | `180` | Delete alert records older than N days |
| `RETENTION_INCIDENTS_DAYS` | ❌ | `365` | Delete resolved incidents older than N days |

---

## 8. Portainer Deployment

1. Open your Portainer instance → **Stacks** → **Add stack**
2. Upload `stack.yml` (or paste its content)
3. Add the required environment variables in the **Environment variables** section
4. Click **Deploy the stack**

The database service is pinned to the manager node via placement constraints — it will not migrate between nodes.

---

## 9. Updating the Application

```bash
# Pull latest code
git pull origin main

# Rebuild and push image
docker build -t $REGISTRY_IMAGE .
docker push $REGISTRY_IMAGE

# Update the running service (zero-downtime rolling update)
docker service update --image $REGISTRY_IMAGE uptime-monitor_app
```

The database schema uses `ADD COLUMN IF NOT EXISTS` migrations — updates are safe without manual SQL changes.

---

## 10. Backup & Restore

### Backup PostgreSQL

```bash
# In docker-compose
docker-compose exec db pg_dump -U monitor_user monitor_db > backup.sql

# In Swarm
docker exec $(docker ps -q -f name=uptime-monitor_db) \
  pg_dump -U monitor_user monitor_db > backup.sql
```

### Restore

```bash
docker exec -i $(docker ps -q -f name=uptime-monitor_db) \
  psql -U monitor_user monitor_db < backup.sql
```

---

## 11. Troubleshooting

### App won't start

Check the startup log — `networkCheck.js` prints a clear diagnostic before exiting:
```
✗  Database connection failed: host refused the connection.
  → Check that PostgreSQL is running and that DATABASE_URL points to the correct host/port.
  → Local dev: run `docker-compose up db` first.
```

### "Port already in use" warning

Either set `PORT=3001` in `.env`, or — in Swarm with Traefik — ignore it (Traefik routes by hostname, not host port).

### Monitors showing UP but assertions fail

The monitor will appear DOWN even if the HTTP status is 200. Check `error_message` in the `checks` table or the history panel in the dashboard for the assertion failure reason.

### Traefik not routing to the app

1. Verify `traefik-public` network exists: `docker network ls | grep traefik-public`
2. Verify `DOMAIN` matches your Traefik `Host` rule
3. Check Traefik logs: `docker service logs traefik`
4. Verify the app service is on the `traefik-public` network: `docker service inspect uptime-monitor_app`

### High memory usage

Each check stores a row in `checks`. Default retention is 90 days. For 100 monitors checked every 60s, that is ~130k rows/day. Adjust `RETENTION_CHECKS_DAYS` if needed.

### Slow dashboard

The `/api/monitors` query uses subqueries per monitor. For 50+ monitors, add a composite index if not already present:
```sql
CREATE INDEX IF NOT EXISTS idx_checks_monitor_id_checked_at ON checks (monitor_id, checked_at DESC);
```
(This is already created by `initDB` — only needed if manually dropped.)
