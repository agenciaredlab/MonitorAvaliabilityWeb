# MonitorAvaliabilityWeb

**Production-ready uptime monitoring system** built with Node.js 20, Express, PostgreSQL, and Docker.

> Created by **Agencia Redlab** | Developed by **Juan Camilo Medina Godoy**

---

## Features

### Core monitoring
- **HTTP/HTTPS checks** every 60 seconds (configurable per monitor)
- **Custom HTTP methods** — GET, POST, HEAD, PUT
- **Response body assertions** — `contains_text`, `not_contains_text`, `regex`, `json_path`
- **Custom expected status codes** — ranges (`200-399`), exact (`200,201,204`), or mixed
- **Per-monitor timeouts** and **custom request headers/body**
- **SSL/TLS certificate monitoring** — alerts when cert expires in < 30 days (warning) or < 7 days (critical)
- **SLA latency thresholds** — alert when response time exceeds your defined limit

### Alerting
- **Email alerts** via SMTP (DOWN, RECOVERY, SLA breach, SSL expiry)
- **Slack notifications** via incoming webhooks
- **Custom webhooks** with Discord, Slack, Teams, and generic JSON formats
- **HMAC-SHA256 webhook signing** for secure payload verification
- **Maintenance windows** — suppress alerts during planned downtime

### Incident management
- **Automatic incident creation** on DOWN transition
- **Automatic incident resolution** on RECOVERY
- **Incident notes/timeline** — add updates during an outage
- **MTTR / MTTF metrics** — calculated from incident history

### Dashboard & UI
- **Responsive dark-theme dashboard** with real-time monitor cards
- **SLA stats panel** — uptime %, avg latency, P95 latency, MTTR per monitor
- **24h latency chart** (Chart.js) with red zones for downtime periods
- **Public status page** at `/status` — 90-day uptime bars (Statuspage.io style)
- **SVG status badges** — embed in your README or website
- **CSV export** — download check history for any monitor

### Security & operations
- **API key authentication** — optional, SHA-256 hashed keys
- **Data retention** — automatic cleanup of old checks/alerts/incidents (configurable)
- **Smart network detection** — detects Traefik and existing Docker networks before deploying
- **Safe deployment** — never breaks existing containers running on the same server

### Deployment
- **Docker Compose** for local development
- **Docker Swarm + Traefik v2** for production with automatic HTTPS
- **Standalone Swarm** mode for servers without Traefik
- **Portainer compatible** — deploy via stack UI

---

## Quick Start

### One-line installer (recommended for production)

```bash
curl -sSL https://raw.githubusercontent.com/agenciaredlab/MonitorAvaliabilityWeb/main/scripts/install.sh | bash
```

Automatically detects your Docker environment and deploys using the right strategy:

| Environment detected | Strategy |
|---|---|
| Docker Swarm + `traefik-public` network | `stack.yml` — TLS via Let's Encrypt |
| Docker Swarm without Traefik | `stack.standalone.yml` — direct port |
| Docker Compose + Traefik running | Generates `docker-compose.override.yml` with labels |
| Docker Compose only | `docker-compose.yml` — direct port |

### Local development

```bash
git clone https://github.com/agenciaredlab/MonitorAvaliabilityWeb.git
cd MonitorAvaliabilityWeb
cp .env.example .env
docker compose up --build
# Dashboard → http://localhost:3000
# Status page → http://localhost:3000/status
```

---

## CI/CD — GitHub Actions

Every push to `main` automatically builds and pushes the Docker image to Docker Hub.

**Setup (one time):** Go to your GitHub repo → Settings → Secrets → Actions:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token (not your password) |

The workflow (`.github/workflows/docker-publish.yml`):
1. Runs 125 tests — build is blocked if any fail
2. Builds multi-arch image (`amd64` + `arm64`)
3. Publishes `docker.io/<username>/uptime-monitor:latest`

In Portainer, set `REGISTRY_IMAGE=yourusername/uptime-monitor:latest` and the stack always uses the latest published image.

---

## Project Structure

```
src/
  scheduler.js       Entry point — init DB, start API, run crons
  db.js              PostgreSQL schema (9 tables) + migrations
  checker.js         HTTP health checks with body assertions
  alertEngine.js     Email / Slack / webhook notifications
  sslChecker.js      SSL certificate monitoring
  incidentManager.js Incident lifecycle management
  auth.js            API key authentication middleware
  retention.js       Automatic data cleanup
  networkCheck.js    Startup validator (env, port, DB connectivity)
  api.js             Express REST API (30+ endpoints)
public/
  index.html         Dashboard UI (vanilla JS + Chart.js)
  status.html        Public status page
scripts/
  detect-network.sh  Docker network topology detector
  deploy.sh          Smart deployment script
tests/               Jest test suite (96 tests, 7 files)
docs/
  API_REFERENCE.md   Complete API documentation
  DEPLOYMENT.md      Production deployment guide
  DEVELOPMENT.md     Architecture and development guide
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/API_REFERENCE.md) | All endpoints, request/response formats, assertion types |
| [Deployment Guide](docs/DEPLOYMENT.md) | Local dev, Swarm+Traefik, standalone, Portainer, backup |
| [Development Guide](docs/DEVELOPMENT.md) | Architecture, data flow, DB schema, adding features |

---

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/monitors` | List monitors with status + SSL info |
| `POST` | `/api/monitors` | Create monitor (with assertions, SSL, SLA) |
| `PATCH` | `/api/monitors/:id` | Update monitor fields |
| `DELETE` | `/api/monitors/:id` | Soft-delete monitor |
| `GET` | `/api/monitors/:id/history` | Check history (up to 90 days) |
| `GET` | `/api/monitors/:id/history/export` | Download history as CSV |
| `GET` | `/api/monitors/:id/stats` | SLA metrics (uptime %, P95, MTTR) |
| `GET` | `/api/monitors/:id/badge.svg` | SVG status badge |
| `GET` | `/api/monitors/:id/incidents` | Incident history |
| `GET` | `/api/monitors/:id/maintenance` | Maintenance windows |
| `POST` | `/api/monitors/:id/maintenance` | Create maintenance window |
| `GET` | `/api/monitors/:id/webhooks` | List webhooks |
| `POST` | `/api/monitors/:id/webhooks` | Add webhook (Discord/Slack/Teams) |
| `GET` | `/api/stats` | Global stats (total/up/down/avg latency) |
| `GET` | `/api/incidents` | All open incidents |
| `POST` | `/api/incidents/:id/notes` | Add note to incident |
| `POST` | `/api/keys` | Generate API key |
| `GET` | `/api/public/status` | Public status (no auth) |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `PORT` | ❌ | HTTP port (default `3000`) |
| `SMTP_HOST/PORT/USER/PASS` | ❌ | SMTP for email alerts |
| `ALERT_EMAIL` | ❌ | Destination for alert emails |
| `SLACK_WEBHOOK` | ❌ | Slack incoming webhook URL |
| `REQUIRE_API_KEY` | ❌ | `true` to enforce API key auth |
| `RETENTION_CHECKS_DAYS` | ❌ | Keep checks N days (default `90`) |
| `DOMAIN` | ❌ | Domain for Traefik TLS routing |
| `REGISTRY_IMAGE` | ❌ | Docker image for Swarm deploy |

Full table: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#7-environment-variables-reference)

---

## Production Deployment

### Detect your network topology first
```bash
./scripts/detect-network.sh
```

### Smart auto-deploy
```bash
./scripts/deploy.sh          # interactive
./scripts/deploy.sh --yes    # CI/CD mode
./scripts/deploy.sh --dry-run  # preview
```

### Manual Swarm + Traefik
```bash
docker stack deploy -c stack.yml uptime-monitor
```

### Manual Swarm without Traefik
```bash
docker stack deploy -c stack.standalone.yml uptime-monitor
```

Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## Tests

```bash
npm test                # 96 tests across 7 files
npm run test:coverage   # with coverage report
```

---

## License

MIT © Agencia Redlab — Juan Camilo Medina Godoy
