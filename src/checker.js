/**
 * checker.js — URL health checker
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const axios = require('axios');
const { pool } = require('./db');

/**
 * Performs an HTTP GET on the given monitor URL, records latency,
 * persists the result to the checks table and returns a result object.
 *
 * @param {object} monitor  Row from the monitors table
 * @returns {Promise<{monitor: object, status: string, statusCode: number|null, latency: number}>}
 */
async function checkUrl(monitor) {
  let status = 'down';
  let statusCode = null;
  let latency = 0;

  const start = Date.now();

  try {
    const response = await axios.get(monitor.url, {
      timeout: 10000,
      validateStatus: () => true, // handle all HTTP codes manually
      maxRedirects: 5,
      headers: {
        'User-Agent': 'MonitorAvaliabilityWeb/1.0 (Uptime Monitor by Agencia Redlab)',
      },
    });

    latency = Date.now() - start;
    statusCode = response.status;
    status = response.status < 400 ? 'up' : 'down';
  } catch (err) {
    latency = Date.now() - start;
    status = 'down';
    statusCode = null;
    console.error(
      `[${new Date().toISOString()}] [CHECKER] Error checking "${monitor.name}" (${monitor.url}): ${err.message}`
    );
  }

  try {
    await pool.query(
      `INSERT INTO checks (monitor_id, status, status_code, latency_ms, checked_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [monitor.id, status, statusCode, latency]
    );
  } catch (dbErr) {
    console.error(
      `[${new Date().toISOString()}] [CHECKER] Failed to save check for monitor ${monitor.id}: ${dbErr.message}`
    );
  }

  return { monitor, status, statusCode, latency };
}

/**
 * Fetches all active monitors and runs checkUrl for each one in parallel.
 *
 * @returns {Promise<Array>}
 */
async function checkAll() {
  let monitors = [];

  try {
    const { rows } = await pool.query(
      `SELECT id, name, url, interval_seconds FROM monitors WHERE active = TRUE ORDER BY id`
    );
    monitors = rows;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [CHECKER] Failed to fetch monitors: ${err.message}`);
    return [];
  }

  if (monitors.length === 0) {
    console.log(`[${new Date().toISOString()}] [CHECKER] No active monitors found.`);
    return [];
  }

  const results = await Promise.all(monitors.map((m) => checkUrl(m)));
  return results;
}

module.exports = { checkUrl, checkAll };
