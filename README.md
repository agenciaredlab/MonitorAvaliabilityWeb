# MonitorAvaliabilityWeb

**Production-ready uptime monitoring system** built with Node.js 20, Express, PostgreSQL, and Docker.

> Created by **Agencia Redlab** | Developed by **Juan Camilo Medina Godoy**

---

## Features

- **Real-time HTTP monitoring** — checks every 60 seconds with configurable intervals
- **Latency tracking** — measures and stores response time for every check
- **Email alerts** — notifies on DOWN and RECOVERY events via SMTP
- **Slack alerts** — posts DOWN/RECOVERY messages to a Slack webhook
- **Live dashboard** — responsive single-page UI with Chart.js latency graphs
- **24h history charts** — line chart with red zones highlighting downtime periods
- **REST API** — manage monitors programmatically
- **Soft delete** — deactivate monitors without losing historical data
- **Docker-first** — works with `docker-compose` locally and Docker Swarm / Portainer in production
- **Traefik v2 ready** — `stack.yml` includes full Traefik labels with Let's Encrypt TLS

---

## File Structure

```
MonitorAvaliabilityWeb/
├── src/
│   ├── db.js            # PostgreSQL pool + schema init + seed
│   ├── checker.js       # HTTP health checker
│   ├── alertEngine.js   # Email + Slack alert engine
│   ├── api.js           # Express REST API
│   └── scheduler.js     # Entry point + cron scheduler
├── public/
│   └── index.html       # Dashboard (vanilla JS + Chart.js)
├── .env.example         # Environment variables template
├── .gitignore
├── Dockerfile
├── docker-compose.yml   # Local development
├── stack.yml            # Docker Swarm / Portainer production
├── package.json
└── README.md
```

---

## Local Development

### Prerequisites
- Docker & Docker Compose

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/agenciaredlab/MonitorAvaliabilityWeb.git
cd MonitorAvaliabilityWeb

# 2. Create your environment file
cp .env.example .env
# Edit .env with your SMTP / Slack settings (optional)

# 3. Start all services
docker-compose up --build

# 4. Open the dashboard
open http://localhost:3000
```

The app will:
1. Wait for PostgreSQL to be healthy
2. Create tables and seed 3 example monitors
3. Run the first check cycle immediately
4. Schedule subsequent checks every 60 seconds

---

## Production Deployment (Docker Swarm / Portainer)

### 1. Build and push the image

```bash
# Set your registry image name in .env
export REGISTRY_IMAGE=your-dockerhub-user/uptime-monitor:latest

docker build -t $REGISTRY_IMAGE .
docker push $REGISTRY_IMAGE
```

### 2. Create the external Traefik network (once per Swarm)

```bash
docker network create --driver overlay traefik-public
```

### 3. Set environment variables on your Swarm manager

Either export them in your shell or set them in Portainer's environment section before deploying `stack.yml`.

### 4. Deploy the stack

```bash
# Via CLI
docker stack deploy -c stack.yml uptime-monitor

# Via Portainer
# Upload stack.yml → set environment variables → Deploy
```

### 5. Access the dashboard

Navigate to `https://<DOMAIN>` (configured via the `DOMAIN` env var).

---

## Environment Variables

| Variable          | Description                                      | Required |
|-------------------|--------------------------------------------------|----------|
| `DATABASE_URL`    | PostgreSQL connection string                     | Yes      |
| `PORT`            | HTTP server port (default: `3000`)               | No       |
| `SMTP_HOST`       | SMTP server hostname                             | No       |
| `SMTP_PORT`       | SMTP server port (default: `587`)                | No       |
| `SMTP_USER`       | SMTP username / email address                    | No       |
| `SMTP_PASS`       | SMTP password / app password                     | No       |
| `ALERT_EMAIL`     | Destination email for alerts                     | No       |
| `SLACK_WEBHOOK`   | Slack incoming webhook URL                       | No       |
| `DOMAIN`          | Public domain for Traefik routing                | No       |
| `REGISTRY_IMAGE`  | Docker image name for Swarm deployment           | No       |
| `POSTGRES_DB`     | PostgreSQL database name (Swarm `db` service)    | No       |
| `POSTGRES_USER`   | PostgreSQL username (Swarm `db` service)         | No       |
| `POSTGRES_PASSWORD` | PostgreSQL password (Swarm `db` service)       | No       |

> SMTP and Slack variables are optional — alerts are simply skipped if not set.

---

## API Endpoints

| Method   | Endpoint                        | Description                                       |
|----------|---------------------------------|---------------------------------------------------|
| `GET`    | `/api/monitors`                 | List all active monitors with current status      |
| `GET`    | `/api/monitors/:id/history`     | Last 24h checks for a monitor (ordered ASC)       |
| `GET`    | `/api/stats`                    | Aggregate stats: total, up, down, avg latency     |
| `POST`   | `/api/monitors`                 | Add a new monitor `{ name, url }`                 |
| `DELETE` | `/api/monitors/:id`             | Soft-delete (deactivate) a monitor                |

### Example requests

```bash
# List monitors
curl http://localhost:3000/api/monitors

# Add a monitor
curl -X POST http://localhost:3000/api/monitors \
  -H "Content-Type: application/json" \
  -d '{"name":"My API","url":"https://api.example.com/health"}'

# Get 24h history
curl http://localhost:3000/api/monitors/1/history

# Global stats
curl http://localhost:3000/api/stats

# Delete a monitor
curl -X DELETE http://localhost:3000/api/monitors/1
```

---

## Screenshots

> _Dashboard screenshot placeholder_
>
> ![Dashboard](https://via.placeholder.com/860x480/1a1d27/6366f1?text=MonitorAvaliabilityWeb+Dashboard)

---

## License

MIT © Agencia Redlab — Juan Camilo Medina Godoy
