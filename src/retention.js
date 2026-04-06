/**
 * retention.js — Data retention and cleanup
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const { pool } = require('./db');

const DEFAULT_CHECKS_DAYS   = parseInt(process.env.RETENTION_CHECKS_DAYS   || '90',  10);
const DEFAULT_ALERTS_DAYS   = parseInt(process.env.RETENTION_ALERTS_DAYS   || '180', 10);
const DEFAULT_INCIDENTS_DAYS = parseInt(process.env.RETENTION_INCIDENTS_DAYS || '365', 10);

/**
 * Deletes checks older than the given number of days.
 * Returns the count of deleted rows.
 *
 * @param {number} days
 * @returns {Promise<number>}
 */
async function cleanupChecks(days = DEFAULT_CHECKS_DAYS) {
  const { rowCount } = await pool.query(`
    DELETE FROM checks
    WHERE checked_at < NOW() - ($1 || ' days')::INTERVAL
  `, [days]);
  return rowCount;
}

/**
 * Deletes alert records older than the given number of days.
 *
 * @param {number} days
 * @returns {Promise<number>}
 */
async function cleanupAlerts(days = DEFAULT_ALERTS_DAYS) {
  const { rowCount } = await pool.query(`
    DELETE FROM alerts
    WHERE sent_at < NOW() - ($1 || ' days')::INTERVAL
  `, [days]);
  return rowCount;
}

/**
 * Deletes resolved incidents (and their updates) older than the given number of days.
 *
 * @param {number} days
 * @returns {Promise<number>}
 */
async function cleanupIncidents(days = DEFAULT_INCIDENTS_DAYS) {
  const { rowCount } = await pool.query(`
    DELETE FROM incidents
    WHERE status = 'resolved'
      AND resolved_at < NOW() - ($1 || ' days')::INTERVAL
  `, [days]);
  return rowCount;
}

/**
 * Runs all cleanup tasks and logs a summary.
 *
 * @returns {Promise<{checks: number, alerts: number, incidents: number}>}
 */
async function runRetention() {
  const ts = () => new Date().toISOString();
  let checks = 0, alerts = 0, incidents = 0;

  try {
    checks = await cleanupChecks();
    console.log(`[${ts()}] [RETENTION] Deleted ${checks} check records older than ${DEFAULT_CHECKS_DAYS}d`);
  } catch (err) {
    console.error(`[${ts()}] [RETENTION] cleanupChecks error: ${err.message}`);
  }

  try {
    alerts = await cleanupAlerts();
    console.log(`[${ts()}] [RETENTION] Deleted ${alerts} alert records older than ${DEFAULT_ALERTS_DAYS}d`);
  } catch (err) {
    console.error(`[${ts()}] [RETENTION] cleanupAlerts error: ${err.message}`);
  }

  try {
    incidents = await cleanupIncidents();
    console.log(`[${ts()}] [RETENTION] Deleted ${incidents} incident records older than ${DEFAULT_INCIDENTS_DAYS}d`);
  } catch (err) {
    console.error(`[${ts()}] [RETENTION] cleanupIncidents error: ${err.message}`);
  }

  return { checks, alerts, incidents };
}

module.exports = { cleanupChecks, cleanupAlerts, cleanupIncidents, runRetention };
