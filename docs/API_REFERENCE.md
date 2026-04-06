# API Reference

**MonitorAvaliabilityWeb — Uptime Monitoring System**
Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy

---

## Base URL

```
http://localhost:3000
```

In production with Traefik: `https://<DOMAIN>`

---

## Authentication

When `REQUIRE_API_KEY=true` is set, all private endpoints require an API key.

**Header format:**
```
Authorization: Bearer maw_<key>
X-Api-Key: maw_<key>       (alternative)
```

Public endpoints (`/api/public/*`, `/status`) are always accessible without a key.

---

## Monitors

### `GET /api/monitors`

Returns all active monitors with current status, last latency, and SSL info.

**Query parameters:**

| Parameter | Type   | Description                       |
|-----------|--------|-----------------------------------|
| `tag`     | string | Filter by tag (e.g. `?tag=prod`)  |

**Response `200`:**
```json
[
  {
    "id": 1,
    "name": "Google",
    "url": "https://www.google.com",
    "method": "GET",
    "interval_seconds": 60,
    "timeout_ms": 10000,
    "expected_status_codes": "200-399",
    "assertion_type": null,
    "assertion_value": null,
    "sla_latency_ms": null,
    "check_ssl": true,
    "is_public": true,
    "tags": ["search", "example"],
    "created_at": "2026-01-01T00:00:00.000Z",
    "current_status": "up",
    "last_latency": 142,
    "last_checked_at": "2026-01-01T00:01:00.000Z",
    "ssl_status": "valid",
    "ssl_days_remaining": 82,
    "open_incidents": 0
  }
]
```

---

### `GET /api/monitors/:id`

Returns a single monitor with SSL certificate details.

**Response `200`:**
```json
{
  "id": 1,
  "name": "Google",
  "ssl_status": "valid",
  "ssl_days_remaining": 82,
  "ssl_valid_to": "2026-06-01T00:00:00.000Z",
  "ssl_issuer": "CN=R3, O=Let's Encrypt, C=US"
}
```

**Errors:** `400` invalid id · `404` not found

---

### `POST /api/monitors`

Creates a new monitor.

**Request body:**
```json
{
  "name": "My API",
  "url": "https://api.example.com/health",
  "method": "GET",
  "interval_seconds": 60,
  "timeout_ms": 10000,
  "expected_status_codes": "200-399",
  "assertion_type": "json_path",
  "assertion_value": "status==ok",
  "sla_latency_ms": 500,
  "check_ssl": true,
  "is_public": true,
  "tags": ["api", "prod"],
  "request_headers": { "X-API-Key": "secret" },
  "request_body": null
}
```

| Field                   | Required | Default     | Description                                                    |
|-------------------------|----------|-------------|----------------------------------------------------------------|
| `name`                  | ✅       | —           | Display name                                                   |
| `url`                   | ✅       | —           | URL to monitor                                                 |
| `method`                | ❌       | `GET`       | HTTP method: `GET`, `POST`, `HEAD`, `PUT`                      |
| `interval_seconds`      | ❌       | `60`        | Check frequency in seconds                                     |
| `timeout_ms`            | ❌       | `10000`     | Request timeout in milliseconds                                |
| `expected_status_codes` | ❌       | `200-399`   | Accepted codes: range `200-399`, list `200,201`, or mixed      |
| `assertion_type`        | ❌       | `null`      | `contains_text`, `not_contains_text`, `regex`, `json_path`     |
| `assertion_value`       | ❌       | `null`      | Value for assertion (e.g. `healthy`, `^\d+$`, `status==ok`)   |
| `sla_latency_ms`        | ❌       | `null`      | Alert when latency exceeds this threshold (ms)                 |
| `check_ssl`             | ❌       | `false`     | Enable SSL certificate monitoring                              |
| `is_public`             | ❌       | `true`      | Show on the public status page                                 |
| `tags`                  | ❌       | `[]`        | Array of tag strings for filtering                             |
| `request_headers`       | ❌       | `{}`        | Custom headers to send with each request                       |
| `request_body`          | ❌       | `null`      | Request body (for POST/PUT monitors)                           |

**Response `201`:** The created monitor object.

**Errors:** `400` missing name/url · `500` DB error

---

### `PATCH /api/monitors/:id`

Updates one or more fields of an existing monitor.

**Request body:** Any subset of `POST /api/monitors` fields.

**Response `200`:** The updated monitor object.

**Errors:** `400` no valid fields · `404` not found

---

### `DELETE /api/monitors/:id`

Soft-deletes a monitor (sets `active = false`). Historical data is preserved.

**Response `200`:**
```json
{ "success": true, "id": 1 }
```

**Errors:** `404` not found

---

### `GET /api/monitors/:id/history`

Returns check history ordered chronologically.

**Query parameters:**

| Parameter | Type   | Default | Max | Description             |
|-----------|--------|---------|-----|-------------------------|
| `days`    | number | `1`     | `90`| How many days of history|

**Response `200`:**
```json
[
  {
    "id": 1001,
    "monitor_id": 1,
    "status": "up",
    "status_code": 200,
    "latency_ms": 142,
    "assertion_passed": true,
    "error_message": null,
    "checked_at": "2026-01-01T00:01:00.000Z"
  }
]
```

---

### `GET /api/monitors/:id/history/export`

Downloads check history as a CSV file.

**Query parameters:**

| Parameter | Type   | Default | Max  |
|-----------|--------|---------|------|
| `days`    | number | `30`    | `365`|

**Response:** `text/csv` attachment download.

---

### `GET /api/monitors/:id/stats`

Returns SLA metrics for a monitor over a time period.

**Query parameters:**

| Parameter | Type   | Default | Description         |
|-----------|--------|---------|---------------------|
| `days`    | number | `30`    | Period: `7`, `30`, `90` |

**Response `200`:**
```json
{
  "monitor_id": 1,
  "period_days": 30,
  "total": 43200,
  "up": 43150,
  "down": 50,
  "uptime_pct": 99.88,
  "avg_latency": 145,
  "p95_latency": 320,
  "mttr_seconds": 180,
  "mttf_seconds": 259200,
  "checks_count": 43200,
  "incident_count": 2
}
```

| Field           | Description                                      |
|-----------------|--------------------------------------------------|
| `uptime_pct`    | Percentage of UP checks over the period          |
| `avg_latency`   | Average response time (ms) for UP checks         |
| `p95_latency`   | 95th-percentile response time (ms)               |
| `mttr_seconds`  | Mean Time To Recovery (avg incident duration)    |
| `mttf_seconds`  | Mean Time To Failure (avg time between incidents)|

---

### `GET /api/monitors/:id/badge.svg`

Returns an SVG status badge for embedding in websites or README files.

**Requirements:** Monitor must be `active = true` and `is_public = true`.

**Response:** `image/svg+xml` — green `UP` or red `DOWN` badge.

**Example embed:**
```html
<img src="https://monitor.yourdomain.com/api/monitors/1/badge.svg" alt="Service Status" />
```

---

## Global Stats

### `GET /api/stats`

Returns aggregate statistics across all active monitors.

**Response `200`:**
```json
{
  "total": 5,
  "up": 4,
  "down": 1,
  "avg_latency": 183
}
```

---

## Incidents

### `GET /api/incidents`

Returns all currently open incidents across all monitors.

**Response `200`:**
```json
[
  {
    "id": 7,
    "monitor_id": 2,
    "status": "open",
    "started_at": "2026-01-01T03:15:00.000Z",
    "resolved_at": null,
    "duration_seconds": null,
    "auto_created": true,
    "monitor_name": "My API",
    "monitor_url": "https://api.example.com"
  }
]
```

---

### `GET /api/monitors/:id/incidents`

Returns incident history for a monitor.

**Query parameters:**

| Parameter | Type   | Default | Max   |
|-----------|--------|---------|-------|
| `limit`   | number | `20`    | `100` |

**Response `200`:** Array of incident objects, each including `updates` (notes array).

---

### `POST /api/incidents/:id/notes`

Adds a text note/update to an incident.

**Request body:**
```json
{ "text": "Root cause identified: DB connection pool exhausted" }
```

**Response `201`:**
```json
{
  "id": 42,
  "incident_id": 7,
  "text": "Root cause identified: DB connection pool exhausted",
  "created_at": "2026-01-01T03:30:00.000Z"
}
```

---

## Maintenance Windows

### `GET /api/monitors/:id/maintenance`

Returns all maintenance windows for a monitor.

**Response `200`:** Array of maintenance window objects.

---

### `POST /api/monitors/:id/maintenance`

Creates a maintenance window. Alerts are suppressed while a window is active.

**Request body:**
```json
{
  "starts_at": "2026-06-01T02:00:00.000Z",
  "ends_at":   "2026-06-01T04:00:00.000Z",
  "reason":    "Scheduled database upgrade"
}
```

**Response `201`:** The created maintenance window.

**Errors:** `400` missing dates · `400` ends_at before starts_at

---

### `DELETE /api/maintenance/:id`

Deletes a maintenance window.

**Response `200`:** `{ "success": true }`

---

## Webhooks

### `GET /api/monitors/:id/webhooks`

Returns all webhooks configured for a monitor.

---

### `POST /api/monitors/:id/webhooks`

Creates a webhook for a monitor. Supports Discord, Slack, Teams, and generic JSON formats.

**Request body:**
```json
{
  "name":   "Discord Alerts",
  "url":    "https://discord.com/api/webhooks/123/abc",
  "format": "discord",
  "events": ["down", "recovery"],
  "secret": "optional-hmac-secret"
}
```

| Field    | Required | Options                                   |
|----------|----------|-------------------------------------------|
| `url`    | ✅       | Webhook endpoint URL                      |
| `name`   | ❌       | Display name (default: `"Webhook"`)       |
| `format` | ❌       | `generic`, `discord`, `slack`, `teams`    |
| `events` | ❌       | Array: `down`, `recovery`, `ssl_expiring`, `sla_breach` |
| `secret` | ❌       | HMAC-SHA256 signing secret. Payload signed with `X-Signature-256: sha256=<hmac>` header |

**Response `201`:** Created webhook (secret is not returned).

---

### `DELETE /api/webhooks/:id`

Deletes a webhook.

---

## API Keys

### `POST /api/keys`

Generates a new API key. The `plainKey` is returned **once** — store it securely.

**Request body:**
```json
{ "name": "CI/CD Pipeline" }
```

**Response `201`:**
```json
{
  "id": 1,
  "plainKey": "maw_a1b2c3...",
  "name": "CI/CD Pipeline",
  "created_at": "2026-01-01T00:00:00.000Z",
  "note": "Store this key securely — it will not be shown again."
}
```

---

### `GET /api/keys`

Lists all API keys (hashes not shown, only metadata).

---

### `DELETE /api/keys/:id`

Revokes an API key immediately.

---

## Public Status API

These endpoints require no authentication and power the public status page.

### `GET /api/public/status`

Returns the overall system status for public display.

**Response `200`:**
```json
{
  "overall_status": "operational",
  "monitors": [
    {
      "id": 1,
      "name": "Google",
      "url": "https://www.google.com",
      "current_status": "up",
      "last_latency": 142,
      "uptime_90d": "99.90"
    }
  ],
  "open_incidents": [],
  "recent_incidents": [],
  "generated_at": "2026-01-01T00:05:00.000Z"
}
```

`overall_status` is `"operational"` when all public monitors are UP and no incidents are open, otherwise `"degraded"`.

---

### `GET /api/public/monitors/:id/uptime`

Returns daily uptime percentages for the last N days (used for uptime bar charts).

**Query parameters:**

| Parameter | Default | Max |
|-----------|---------|-----|
| `days`    | `90`    | `90`|

**Response `200`:**
```json
[
  { "day": "2026-01-01T00:00:00.000Z", "uptime_pct": "100.00", "checks_count": "1440" },
  { "day": "2026-01-02T00:00:00.000Z", "uptime_pct": "98.61", "checks_count": "1440" }
]
```

---

## Assertion Types

| Type                | `assertion_value` format       | Example                          |
|---------------------|--------------------------------|----------------------------------|
| `contains_text`     | Plain text to search           | `"healthy"`                      |
| `not_contains_text` | Plain text that must be absent | `"error"`                        |
| `regex`             | JavaScript regex pattern       | `"\"status\":\\s*\"ok\""`        |
| `json_path`         | `path==value` with operators   | `"status==ok"`, `"count>0"`, `"data.ready==true"` |

**json_path operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`

**json_path example:** To check that `{"data": {"count": 5}}` has count > 0:
```json
{ "assertion_type": "json_path", "assertion_value": "data.count>0" }
```

---

## Error Responses

All errors follow this format:
```json
{ "error": "Human-readable error message" }
```

| Code | Meaning                        |
|------|--------------------------------|
| `400`| Invalid input or missing field |
| `401`| Authentication required        |
| `403`| Invalid or revoked API key     |
| `404`| Resource not found             |
| `500`| Internal server error (check logs) |
