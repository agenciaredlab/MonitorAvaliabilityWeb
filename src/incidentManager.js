/**
 * incidentManager.js — Automatic incident lifecycle management
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const { pool } = require('./db');

/**
 * Creates a new open incident for the given monitor.
 *
 * @param {number} monitorId
 * @param {boolean} autoCreated
 * @returns {Promise<object>} The created incident row
 */
async function createIncident(monitorId, autoCreated = true) {
  const { rows } = await pool.query(`
    INSERT INTO incidents (monitor_id, status, started_at, auto_created)
    VALUES ($1, 'open', NOW(), $2)
    RETURNING *
  `, [monitorId, autoCreated]);
  console.log(
    `[${new Date().toISOString()}] [INCIDENT] Opened #${rows[0].id} for monitor ${monitorId}`
  );
  return rows[0];
}

/**
 * Resolves the most recent open incident for the given monitor.
 * Calculates and stores duration_seconds.
 *
 * @param {number} monitorId
 * @returns {Promise<object|null>} The resolved incident row, or null if none found
 */
async function resolveIncident(monitorId) {
  const { rows } = await pool.query(`
    UPDATE incidents
    SET
      status           = 'resolved',
      resolved_at      = NOW(),
      duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int
    WHERE id = (
      SELECT id FROM incidents
      WHERE monitor_id = $1 AND status = 'open'
      ORDER BY started_at DESC
      LIMIT 1
    )
    RETURNING *
  `, [monitorId]);

  if (rows.length === 0) return null;

  console.log(
    `[${new Date().toISOString()}] [INCIDENT] Resolved #${rows[0].id} for monitor ${monitorId} ` +
    `(duration: ${rows[0].duration_seconds}s)`
  );
  return rows[0];
}

/**
 * Returns the currently open incident for a monitor, or null.
 *
 * @param {number} monitorId
 * @returns {Promise<object|null>}
 */
async function getOpenIncident(monitorId) {
  const { rows } = await pool.query(`
    SELECT * FROM incidents
    WHERE monitor_id = $1 AND status = 'open'
    ORDER BY started_at DESC
    LIMIT 1
  `, [monitorId]);
  return rows[0] || null;
}

/**
 * Returns the last N incidents for a monitor (resolved + open).
 *
 * @param {number} monitorId
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getIncidents(monitorId, limit = 20) {
  const { rows } = await pool.query(`
    SELECT
      i.*,
      m.name  AS monitor_name,
      m.url   AS monitor_url,
      (
        SELECT json_agg(u ORDER BY u.created_at ASC)
        FROM incident_updates u
        WHERE u.incident_id = i.id
      ) AS updates
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE i.monitor_id = $1
    ORDER BY i.started_at DESC
    LIMIT $2
  `, [monitorId, limit]);
  return rows;
}

/**
 * Returns all open incidents (across all monitors).
 *
 * @returns {Promise<Array>}
 */
async function getAllOpenIncidents() {
  const { rows } = await pool.query(`
    SELECT
      i.*,
      m.name AS monitor_name,
      m.url  AS monitor_url
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE i.status = 'open'
    ORDER BY i.started_at DESC
  `);
  return rows;
}

/**
 * Adds a text update/note to an incident.
 *
 * @param {number} incidentId
 * @param {string} text
 * @returns {Promise<object>}
 */
async function addNote(incidentId, text) {
  const { rows } = await pool.query(`
    INSERT INTO incident_updates (incident_id, text, created_at)
    VALUES ($1, $2, NOW())
    RETURNING *
  `, [incidentId, text]);
  return rows[0];
}

module.exports = { createIncident, resolveIncident, getOpenIncident, getIncidents, getAllOpenIncidents, addNote };
