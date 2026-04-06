/**
 * api.js — Express REST API with all endpoints
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const express = require('express');
const path    = require('path');
const { pool }             = require('./db');
const { authMiddleware, generateApiKey } = require('./auth');
const { getIncidents, getAllOpenIncidents, addNote } = require('./incidentManager');

// ── SLA / stats helpers ───────────────────────────────────────────────────────

/**
 * Calculates uptime %, MTTR, MTTF and P95 latency for a monitor over a period.
 */
async function computeStats(monitorId, days = 30) {
  const { rows: checks } = await pool.query(`
    SELECT status, latency_ms, checked_at
    FROM checks
    WHERE monitor_id = $1
      AND checked_at >= NOW() - ($2 || ' days')::INTERVAL
    ORDER BY checked_at ASC
  `, [monitorId, days]);

  if (checks.length === 0) {
    return { total: 0, up: 0, down: 0, uptime_pct: null, avg_latency: null,
             p95_latency: null, mttr_seconds: null, mttf_seconds: null, checks_count: 0 };
  }

  const total     = checks.length;
  const upChecks  = checks.filter(c => c.status === 'up');
  const downCount = total - upChecks.length;
  const uptimePct = Math.round((upChecks.length / total) * 10000) / 100;

  // P95 latency
  const latencies = upChecks.map(c => c.latency_ms).filter(l => l != null).sort((a, b) => a - b);
  const p95Idx    = Math.floor(latencies.length * 0.95);
  const p95       = latencies[p95Idx] ?? null;
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length)
    : null;

  // MTTR / MTTF — calculate from incident data
  const { rows: incidents } = await pool.query(`
    SELECT started_at, resolved_at, duration_seconds
    FROM incidents
    WHERE monitor_id = $1
      AND started_at >= NOW() - ($2 || ' days')::INTERVAL
      AND status = 'resolved'
  `, [monitorId, days]);

  let mttrSeconds = null;
  let mttfSeconds = null;

  if (incidents.length > 0) {
    const durations = incidents.map(i => i.duration_seconds).filter(d => d != null);
    if (durations.length > 0) {
      mttrSeconds = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
    }
  }

  // MTTF: average time between incident starts
  if (incidents.length >= 2) {
    const sorted = incidents.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    const gaps   = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((new Date(sorted[i].started_at) - new Date(sorted[i-1].started_at)) / 1000);
    }
    mttfSeconds = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
  }

  return {
    total,
    up:           upChecks.length,
    down:         downCount,
    uptime_pct:   uptimePct,
    avg_latency:  avgLatency,
    p95_latency:  p95,
    mttr_seconds: mttrSeconds,
    mttf_seconds: mttfSeconds,
    checks_count: total,
    incident_count: incidents.length,
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function generateCSV(rows) {
  const header = 'id,status,status_code,latency_ms,assertion_passed,error_message,checked_at\n';
  const lines  = rows.map(r =>
    [r.id, r.status, r.status_code ?? '', r.latency_ms ?? '',
     r.assertion_passed ?? '', (r.error_message || '').replace(/,/g, ';'), r.checked_at]
    .join(',')
  );
  return header + lines.join('\n');
}

// ── SVG badge ─────────────────────────────────────────────────────────────────

function generateBadge(name, status) {
  const isUp    = status === 'up';
  const color   = isUp ? '#2ECC71' : '#D8262F';
  const label   = isUp ? 'UP' : 'DOWN';
  const nameW   = Math.min(name.length * 7 + 10, 200);
  const labelW  = 44;
  const totalW  = nameW + labelW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0"  stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1"  stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${nameW}" height="20" fill="#555"/>
    <rect x="${nameW}" width="${labelW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif"
     font-size="11" text-rendering="geometricPrecision">
    <text x="${nameW/2}" y="15" fill="#010101" fill-opacity=".3">${name}</text>
    <text x="${nameW/2}" y="14">${name}</text>
    <text x="${nameW + labelW/2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${nameW + labelW/2}" y="14">${label}</text>
  </g>
</svg>`;
}

// ── Express app ───────────────────────────────────────────────────────────────

function startAPI() {
  const app  = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json());
  app.use(authMiddleware);

  // Static files (dashboard + status page)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── /status page ────────────────────────────────────────────────────────────
  app.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'status.html'));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MONITORS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/monitors
  app.get('/api/monitors', async (req, res) => {
    try {
      const tag = req.query.tag;
      const { rows } = await pool.query(`
        SELECT
          m.id, m.name, m.url, m.method, m.interval_seconds, m.timeout_ms,
          m.expected_status_codes, m.assertion_type, m.assertion_value,
          m.sla_latency_ms, m.check_ssl, m.is_public, m.tags, m.created_at,
          (SELECT c.status     FROM checks c WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS current_status,
          (SELECT c.latency_ms FROM checks c WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS last_latency,
          (SELECT c.checked_at FROM checks c WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS last_checked_at,
          s.status         AS ssl_status,
          s.days_remaining AS ssl_days_remaining,
          (SELECT COUNT(*) FROM incidents i WHERE i.monitor_id = m.id AND i.status = 'open') AS open_incidents,
          (SELECT ROUND(100.0 * SUM(CASE WHEN c.status = 'up' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 1)
           FROM checks c WHERE c.monitor_id = m.id AND c.checked_at >= NOW() - INTERVAL '7 days') AS uptime_7d
        FROM monitors m
        LEFT JOIN ssl_certificates s ON s.monitor_id = m.id
        WHERE m.active = TRUE
          ${tag ? `AND $1 = ANY(m.tags)` : ''}
        ORDER BY m.id ASC
      `, tag ? [tag] : []);
      res.json(rows);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] GET /api/monitors: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch monitors' });
    }
  });

  // GET /api/monitors/:id
  app.get('/api/monitors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid monitor id' });
      const { rows } = await pool.query(`
        SELECT m.*, s.status AS ssl_status, s.days_remaining AS ssl_days_remaining,
               s.valid_to AS ssl_valid_to, s.issuer AS ssl_issuer
        FROM monitors m
        LEFT JOIN ssl_certificates s ON s.monitor_id = m.id
        WHERE m.id = $1 AND m.active = TRUE
      `, [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Monitor not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch monitor' });
    }
  });

  // GET /api/monitors/:id/history
  app.get('/api/monitors/:id/history', async (req, res) => {
    try {
      const id   = parseInt(req.params.id, 10);
      const days = Math.min(parseInt(req.query.days || '1', 10), 90);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid monitor id' });
      const { rows } = await pool.query(`
        SELECT id, monitor_id, status, status_code, latency_ms, assertion_passed, error_message, checked_at
        FROM checks
        WHERE monitor_id = $1
          AND checked_at >= NOW() - ($2 || ' days')::INTERVAL
        ORDER BY checked_at ASC
      `, [id, days]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  // GET /api/monitors/:id/history/export — CSV download
  app.get('/api/monitors/:id/history/export', async (req, res) => {
    try {
      const id   = parseInt(req.params.id, 10);
      const days = Math.min(parseInt(req.query.days || '30', 10), 365);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid monitor id' });
      const { rows } = await pool.query(`
        SELECT id, status, status_code, latency_ms, assertion_passed, error_message, checked_at
        FROM checks
        WHERE monitor_id = $1
          AND checked_at >= NOW() - ($2 || ' days')::INTERVAL
        ORDER BY checked_at ASC
      `, [id, days]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="monitor-${id}-history.csv"`);
      res.send(generateCSV(rows));
    } catch (err) {
      res.status(500).json({ error: 'Failed to export history' });
    }
  });

  // GET /api/monitors/:id/stats
  app.get('/api/monitors/:id/stats', async (req, res) => {
    try {
      const id   = parseInt(req.params.id, 10);
      const days = parseInt(req.query.days || '30', 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid monitor id' });
      const stats = await computeStats(id, days);
      res.json({ monitor_id: id, period_days: days, ...stats });
    } catch (err) {
      res.status(500).json({ error: 'Failed to compute stats' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        WITH latest AS (
          SELECT DISTINCT ON (monitor_id) monitor_id, status, latency_ms
          FROM checks ORDER BY monitor_id, checked_at DESC
        )
        SELECT
          COUNT(m.id)::int                                AS total,
          COUNT(CASE WHEN l.status = 'up'   THEN 1 END)::int AS up,
          COUNT(CASE WHEN l.status = 'down' THEN 1 END)::int AS down,
          ROUND(AVG(l.latency_ms))::int                   AS avg_latency
        FROM monitors m
        LEFT JOIN latest l ON l.monitor_id = m.id
        WHERE m.active = TRUE
      `);
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // POST /api/monitors
  app.post('/api/monitors', async (req, res) => {
    try {
      const {
        name, url, method = 'GET', interval_seconds = 60, timeout_ms = 10000,
        expected_status_codes = '200-399', assertion_type, assertion_value,
        sla_latency_ms, check_ssl = false, is_public = true, tags = [],
        request_headers = {}, request_body,
      } = req.body;

      if (!name || !String(name).trim()) return res.status(400).json({ error: '"name" is required' });
      if (!url  || !String(url).trim())  return res.status(400).json({ error: '"url" is required' });

      const { rows } = await pool.query(`
        INSERT INTO monitors
          (name, url, method, interval_seconds, timeout_ms, expected_status_codes,
           assertion_type, assertion_value, sla_latency_ms, check_ssl, is_public, tags,
           request_headers, request_body, active, next_check_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,NOW(),NOW())
        RETURNING *
      `, [
        String(name).trim(), String(url).trim(),
        String(method).toUpperCase(), interval_seconds, timeout_ms, expected_status_codes,
        assertion_type || null, assertion_value || null,
        sla_latency_ms || null, check_ssl, is_public,
        Array.isArray(tags) ? tags : [],
        JSON.stringify(request_headers), request_body || null,
      ]);
      console.log(`[${new Date().toISOString()}] [API] New monitor: "${name}" → ${url}`);
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] POST /api/monitors: ${err.message}`);
      res.status(500).json({ error: 'Failed to create monitor' });
    }
  });

  // PATCH /api/monitors/:id  (update fields)
  app.patch('/api/monitors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const allowed = ['name','url','method','interval_seconds','timeout_ms',
                       'expected_status_codes','assertion_type','assertion_value',
                       'sla_latency_ms','check_ssl','is_public','tags',
                       'request_headers','request_body'];
      const updates = [];
      const values  = [];
      let   idx     = 1;

      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${idx++}`);
          values.push(field === 'request_headers' ? JSON.stringify(req.body[field]) : req.body[field]);
        }
      }

      if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

      values.push(id);
      const { rows } = await pool.query(
        `UPDATE monitors SET ${updates.join(', ')} WHERE id = $${idx} AND active = TRUE RETURNING *`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Monitor not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update monitor' });
    }
  });

  // DELETE /api/monitors/:id
  app.delete('/api/monitors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rowCount } = await pool.query(
        `UPDATE monitors SET active = FALSE WHERE id = $1 AND active = TRUE`, [id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Monitor not found' });
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete monitor' });
    }
  });

  // GET /api/monitors/:id/badge.svg
  app.get('/api/monitors/:id/badge.svg', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).send('Invalid id');
      const { rows } = await pool.query(`
        SELECT m.name,
          (SELECT c.status FROM checks c WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS status
        FROM monitors m WHERE m.id = $1 AND m.active = TRUE AND m.is_public = TRUE
      `, [id]);
      if (rows.length === 0) return res.status(404).send('Not found');
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'max-age=60');
      res.send(generateBadge(rows[0].name, rows[0].status || 'unknown'));
    } catch (err) {
      res.status(500).send('Error');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MAINTENANCE WINDOWS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/monitors/:id/maintenance', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rows } = await pool.query(`
        SELECT * FROM maintenance_windows WHERE monitor_id = $1 ORDER BY starts_at DESC
      `, [id]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch maintenance windows' });
    }
  });

  app.post('/api/monitors/:id/maintenance', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { starts_at, ends_at, reason } = req.body;
      if (!starts_at || !ends_at) return res.status(400).json({ error: 'starts_at and ends_at are required' });
      if (new Date(ends_at) <= new Date(starts_at)) {
        return res.status(400).json({ error: 'ends_at must be after starts_at' });
      }
      const { rows } = await pool.query(`
        INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason, created_at)
        VALUES ($1, $2, $3, $4, NOW()) RETURNING *
      `, [id, starts_at, ends_at, reason || null]);
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create maintenance window' });
    }
  });

  app.delete('/api/maintenance/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rowCount } = await pool.query(`DELETE FROM maintenance_windows WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Maintenance window not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete maintenance window' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // INCIDENTS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/incidents', async (req, res) => {
    try {
      const rows = await getAllOpenIncidents();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch incidents' });
    }
  });

  app.get('/api/monitors/:id/incidents', async (req, res) => {
    try {
      const id    = parseInt(req.params.id, 10);
      const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const rows = await getIncidents(id, limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch incidents' });
    }
  });

  app.post('/api/incidents/:id/notes', async (req, res) => {
    try {
      const id   = parseInt(req.params.id, 10);
      const text = req.body.text;
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      if (!text || !String(text).trim()) return res.status(400).json({ error: '"text" is required' });
      const note = await addNote(id, String(text).trim());
      res.status(201).json(note);
    } catch (err) {
      res.status(500).json({ error: 'Failed to add note' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // WEBHOOKS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/monitors/:id/webhooks', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rows } = await pool.query(
        `SELECT id, name, url, events, format, active, created_at FROM webhooks WHERE monitor_id = $1 ORDER BY id`,
        [id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch webhooks' });
    }
  });

  app.post('/api/monitors/:id/webhooks', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { name = 'Webhook', url, events = ['down','recovery'], format = 'generic', secret } = req.body;
      if (!url) return res.status(400).json({ error: '"url" is required' });
      const { rows } = await pool.query(`
        INSERT INTO webhooks (monitor_id, name, url, events, format, secret, active, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW()) RETURNING id, name, url, events, format, active, created_at
      `, [id, name, url, events, format, secret || null]);
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create webhook' });
    }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rowCount } = await pool.query(`DELETE FROM webhooks WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Webhook not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete webhook' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // API KEYS
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/keys', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: '"name" is required' });
      const result = await generateApiKey(String(name).trim());
      res.status(201).json({
        ...result,
        note: 'Store this key securely — it will not be shown again.',
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate API key' });
    }
  });

  app.get('/api/keys', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, last_used_at, created_at, revoked FROM api_keys ORDER BY created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch keys' });
    }
  });

  app.delete('/api/keys/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rowCount } = await pool.query(`UPDATE api_keys SET revoked = TRUE WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Key not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to revoke key' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC STATUS PAGE API (no auth required)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/public/status', async (req, res) => {
    try {
      // Public monitors with last 90-day uptime %
      const { rows: monitors } = await pool.query(`
        SELECT
          m.id, m.name, m.url, m.tags,
          (SELECT c.status     FROM checks c WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS current_status,
          (SELECT c.latency_ms FROM checks c WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS last_latency,
          (
            SELECT ROUND(
              100.0 * SUM(CASE WHEN c2.status = 'up' THEN 1 ELSE 0 END) /
              NULLIF(COUNT(c2.id), 0), 2)
            FROM checks c2
            WHERE c2.monitor_id = m.id
              AND c2.checked_at >= NOW() - INTERVAL '90 days'
          ) AS uptime_90d
        FROM monitors m
        WHERE m.active = TRUE AND m.is_public = TRUE
        ORDER BY m.id ASC
      `);

      // Open incidents
      const { rows: incidents } = await pool.query(`
        SELECT i.id, i.monitor_id, i.started_at, i.status, m.name AS monitor_name
        FROM incidents i
        JOIN monitors m ON m.id = i.monitor_id
        WHERE i.status = 'open' AND m.is_public = TRUE
        ORDER BY i.started_at DESC
      `);

      // Recent resolved incidents (last 7 days)
      const { rows: recentIncidents } = await pool.query(`
        SELECT i.id, i.monitor_id, i.started_at, i.resolved_at, i.duration_seconds, m.name AS monitor_name
        FROM incidents i
        JOIN monitors m ON m.id = i.monitor_id
        WHERE i.status = 'resolved'
          AND i.resolved_at >= NOW() - INTERVAL '7 days'
          AND m.is_public = TRUE
        ORDER BY i.resolved_at DESC
        LIMIT 10
      `);

      const allUp = monitors.every(m => m.current_status === 'up' || m.current_status === null);

      res.json({
        overall_status: incidents.length === 0 && allUp ? 'operational' : 'degraded',
        monitors,
        open_incidents:   incidents,
        recent_incidents: recentIncidents,
        generated_at:     new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch public status' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC DAILY UPTIME BARS (no auth required)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/public/monitors/:id/uptime', async (req, res) => {
    try {
      const id   = parseInt(req.params.id, 10);
      const days = Math.min(parseInt(req.query.days || '90', 10), 90);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const { rows } = await pool.query(`
        SELECT
          DATE_TRUNC('day', checked_at AT TIME ZONE 'UTC') AS day,
          ROUND(
            100.0 * SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) /
            NULLIF(COUNT(*), 0), 2
          ) AS uptime_pct,
          COUNT(*) AS checks_count
        FROM checks
        WHERE monitor_id = $1
          AND checked_at >= NOW() - ($2 || ' days')::INTERVAL
        GROUP BY 1
        ORDER BY 1 ASC
      `, [id, days]);

      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch uptime bars' });
    }
  });

  // Fallback → serve index.html
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  const server = app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] [API] Server listening on port ${PORT}`);
  });

  return server;
}

module.exports = { startAPI };
