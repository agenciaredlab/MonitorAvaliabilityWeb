# Development Guide

**MonitorAvaliabilityWeb — Uptime Monitoring System**
Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy

---

## Architecture Overview

```
MonitorAvaliabilityWeb/
├── src/
│   ├── scheduler.js       # Entry point — init, crons, graceful shutdown
│   ├── db.js              # pg Pool, schema init, migrations, seed
│   ├── checker.js         # HTTP health checker (assertions, custom methods)
│   ├── alertEngine.js     # Notification dispatcher (email, Slack, webhooks)
│   ├── sslChecker.js      # SSL/TLS certificate monitor
│   ├── incidentManager.js # Incident lifecycle (create, resolve, notes)
│   ├── auth.js            # API key generation and validation middleware
│   ├── retention.js       # Data cleanup (checks, alerts, incidents)
│   ├── networkCheck.js    # Startup env/port/DB validator
│   └── api.js             # Express REST API (30+ endpoints)
├── public/
│   ├── index.html         # Dashboard (vanilla JS + Chart.js)
│   └── status.html        # Public status page
├── scripts/
│   ├── detect-network.sh  # Docker network topology detector
│   └── deploy.sh          # Smart deployment script
├── tests/
│   ├── __mocks__/db.js    # pg Pool mock
│   ├── checker.test.js
│   ├── alertEngine.test.js
│   ├── incidentManager.test.js
│   ├── auth.test.js
│   ├── retention.test.js
│   ├── sslChecker.test.js
│   └── api.test.js        # Integration tests (supertest)
└── docs/
    ├── API_REFERENCE.md
    ├── DEPLOYMENT.md
    └── DEVELOPMENT.md     # This file
```

---

## Data Flow

```
scheduler.js
  │
  ├── [startup]  networkCheck.js  → validates env, DB, port
  ├── [startup]  db.js initDB()   → creates/migrates tables, seeds data
  ├── [startup]  api.js startAPI() → Express on PORT
  │
  ├── [every 60s] checker.checkAll()
  │     └── For each due monitor:
  │           checker.checkUrl(monitor)
  │             ├── axios GET/POST/HEAD/PUT
  │             ├── evaluateAssertion() → contains_text / regex / json_path
  │             └── INSERT INTO checks
  │
  │   alertEngine.processResults(results)
  │     ├── For each result: compare last 2 checks (up→down / down→up)
  │     ├── isInMaintenance() → skip if in window
  │     ├── incidentManager.createIncident() or resolveIncident()
  │     ├── sendEmail() + sendSlack() + dispatchWebhooks()
  │     └── INSERT INTO alerts
  │
  ├── [every 6h] sslChecker.checkAllSSL()
  │     └── For each monitor with check_ssl=true:
  │           tls.connect() → extract cert expiry
  │           UPSERT ssl_certificates
  │           alertEngine.processSSLResults() → email/slack if expiring
  │
  └── [daily 3am] retention.runRetention()
        ├── DELETE old checks
        ├── DELETE old alerts
        └── DELETE old resolved incidents
```

---

## Database Schema

```sql
monitors              -- monitored services (core config)
checks                -- one row per HTTP check execution
alerts                -- notification log (down/recovery/ssl/sla_breach)
incidents             -- outage events (auto-created on down transition)
incident_updates      -- text notes added to incidents
maintenance_windows   -- scheduled suppression periods
webhooks              -- per-monitor webhook endpoints
ssl_certificates      -- latest SSL cert info per monitor (upserted)
api_keys              -- hashed API keys for authentication
```

### Key design decisions

- **Soft deletes:** Monitors use `active = false` — history is never deleted by user action
- **Per-monitor intervals:** `next_check_at` field on monitors; scheduler runs every minute but only checks monitors where `next_check_at <= NOW()`
- **Safe migrations:** `ADD COLUMN IF NOT EXISTS` — upgrading never destroys data
- **Retention:** Checks are kept for 90 days by default (configurable) — this prevents unbounded table growth

---

## Running Locally (without Docker)

You need a running PostgreSQL instance. The easiest way:

```bash
# Start only the DB with docker-compose
docker-compose up -d db

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit DATABASE_URL to point to localhost:5432

# Start the application
npm run dev
```

`npm run dev` uses `node --watch` for automatic restarts on file changes.

---

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Watch mode (re-runs on file changes)
npm run test:watch

# Run a single test file
npx jest tests/checker.test.js

# Run tests matching a pattern
npx jest --testNamePattern="checkUrl"
```

### Test coverage targets

| Module | Focus |
|--------|-------|
| `checker.js` | `statusCodeMatches`, `evaluateAssertion`, `checkUrl`, `checkAll` |
| `alertEngine.js` | Transitions, maintenance suppression, SLA breach, SSL alerts |
| `incidentManager.js` | CRUD operations with mocked DB |
| `auth.js` | Key generation, validation, middleware behavior |
| `retention.js` | SQL correctness, partial failure tolerance |
| `sslChecker.js` | `certStatus` thresholds, non-HTTPS short-circuit |
| `api.js` | All endpoints via supertest (201/200/400/404/500) |

### Mocking strategy

All tests mock the `../src/db` module via `jest.mock('../src/db')`. This means:
- No database connection is needed to run tests
- Each test configures `pool.query.mockResolvedValueOnce()` with the exact rows it expects
- `jest.clearAllMocks()` in `beforeEach` ensures isolation between tests

---

## Adding a New Feature

### 1. Add a new DB table

In `src/db.js`, add inside `initDB()`:
```javascript
await client.query(`
  CREATE TABLE IF NOT EXISTS my_table (
    id         SERIAL PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    value      TEXT    NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
```

### 2. Add a new API endpoint

In `src/api.js`, add a route inside `startAPI()`:
```javascript
app.get('/api/my-resource/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rows } = await pool.query(
      'SELECT * FROM my_table WHERE monitor_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [API] Error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});
```

### 3. Add a test

In `tests/api.test.js`:
```javascript
describe('GET /api/my-resource/:id', () => {
  test('returns 200 with data', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, value: 'test' }] });

    const res = await request(server).get('/api/my-resource/1');

    expect(res.status).toBe(200);
    expect(res.body[0].value).toBe('test');
  });
});
```

---

## Code Conventions

- **No `string` concatenation in SQL** — always use `$1, $2` parameterized queries
- **Every async function** wrapped in `try/catch` with a `console.error` log
- **Timestamps in logs** — always `[${new Date().toISOString()}]` prefix
- **Secrets never logged** — `DATABASE_URL` is sanitized before printing (`safeDbUrl()`)
- **No hardcoded values** — all config from `process.env`
- **Graceful degradation** — missing SMTP/Slack/Webhook config silently disables that channel, app continues

---

## Environment Variables for Development

Minimum required for local dev:
```env
DATABASE_URL=postgres://monitor_user:monitor_pass@localhost:5432/monitor_db
PORT=3000
```

Optional for testing notifications:
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=dev@yourdomain.com
SMTP_PASS=app_password
ALERT_EMAIL=you@yourdomain.com
SLACK_WEBHOOK=https://hooks.slack.com/services/...
```

---

## Cron Schedule Reference

| Job | Schedule | Description |
|-----|----------|-------------|
| HTTP checks | `* * * * *` (every minute) | Checks monitors where `next_check_at <= NOW()` |
| SSL checks | `0 */6 * * *` (every 6h) | Checks all monitors with `check_ssl = true` |
| Data retention | `0 3 * * *` (daily at 3 AM) | Deletes old checks, alerts, resolved incidents |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make changes and add tests
4. Ensure all tests pass: `npm test`
5. Commit with a descriptive message
6. Open a pull request

---

## License

MIT © Agencia Redlab — Juan Camilo Medina Godoy
