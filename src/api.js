/**
 * api.js — Express REST API
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const express = require('express');
const path = require('path');
const { pool } = require('./db');

/**
 * Creates the Express application, registers all routes, and starts listening.
 * Returns the http.Server instance.
 */
function startAPI() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json());

  // Serve the dashboard
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/monitors
  // Returns all active monitors with their current status and last latency.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/monitors', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          m.id,
          m.name,
          m.url,
          m.interval_seconds,
          m.created_at,
          (
            SELECT c.status
            FROM checks c
            WHERE c.monitor_id = m.id
            ORDER BY c.checked_at DESC
            LIMIT 1
          ) AS current_status,
          (
            SELECT c.latency_ms
            FROM checks c
            WHERE c.monitor_id = m.id
            ORDER BY c.checked_at DESC
            LIMIT 1
          ) AS last_latency
        FROM monitors m
        WHERE m.active = TRUE
        ORDER BY m.id ASC
      `);
      res.json(rows);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] GET /api/monitors error: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch monitors' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/monitors/:id/history
  // Returns the last 24h of checks for a monitor, ordered ASC.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/monitors/:id/history', async (req, res) => {
    try {
      const monitorId = parseInt(req.params.id, 10);
      if (isNaN(monitorId)) {
        return res.status(400).json({ error: 'Invalid monitor id' });
      }

      const { rows } = await pool.query(`
        SELECT id, monitor_id, status, status_code, latency_ms, checked_at
        FROM checks
        WHERE monitor_id = $1
          AND checked_at >= NOW() - INTERVAL '24 hours'
        ORDER BY checked_at ASC
      `, [monitorId]);

      res.json(rows);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] GET /api/monitors/:id/history error: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/stats
  // Returns aggregate stats across all active monitors.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        WITH latest AS (
          SELECT DISTINCT ON (monitor_id)
            monitor_id,
            status,
            latency_ms
          FROM checks
          ORDER BY monitor_id, checked_at DESC
        )
        SELECT
          COUNT(m.id)                                      AS total,
          COUNT(CASE WHEN l.status = 'up'   THEN 1 END)   AS up,
          COUNT(CASE WHEN l.status = 'down' THEN 1 END)   AS down,
          ROUND(AVG(l.latency_ms))::int                   AS avg_latency
        FROM monitors m
        LEFT JOIN latest l ON l.monitor_id = m.id
        WHERE m.active = TRUE
      `);
      res.json(rows[0]);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] GET /api/stats error: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/monitors
  // Inserts a new monitor and returns it.
  // Body: { name: string, url: string }
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/monitors', async (req, res) => {
    try {
      const { name, url } = req.body;
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: '"name" is required' });
      }
      if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ error: '"url" is required' });
      }

      const { rows } = await pool.query(`
        INSERT INTO monitors (name, url, interval_seconds, active, created_at)
        VALUES ($1, $2, 60, TRUE, NOW())
        RETURNING id, name, url, interval_seconds, active, created_at
      `, [name.trim(), url.trim()]);

      console.log(`[${new Date().toISOString()}] [API] New monitor created: "${name}" → ${url}`);
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] POST /api/monitors error: ${err.message}`);
      res.status(500).json({ error: 'Failed to create monitor' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/monitors/:id
  // Soft-deletes a monitor by setting active = false.
  // ──────────────────────────────────────────────────────────────────────────
  app.delete('/api/monitors/:id', async (req, res) => {
    try {
      const monitorId = parseInt(req.params.id, 10);
      if (isNaN(monitorId)) {
        return res.status(400).json({ error: 'Invalid monitor id' });
      }

      const { rowCount } = await pool.query(
        `UPDATE monitors SET active = FALSE WHERE id = $1 AND active = TRUE`,
        [monitorId]
      );

      if (rowCount === 0) {
        return res.status(404).json({ error: 'Monitor not found or already inactive' });
      }

      console.log(`[${new Date().toISOString()}] [API] Monitor ${monitorId} deactivated.`);
      res.json({ success: true, id: monitorId });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [API] DELETE /api/monitors/:id error: ${err.message}`);
      res.status(500).json({ error: 'Failed to delete monitor' });
    }
  });

  // Fallback: serve index.html for any unknown path (SPA-style)
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  const server = app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] [API] Server listening on port ${PORT}`);
  });

  return server;
}

module.exports = { startAPI };
