/**
 * sslChecker.js — SSL/TLS certificate monitoring
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const tls  = require('tls');
const https = require('https');
const { pool } = require('./db');

const SSL_WARN_DAYS     = 30;
const SSL_CRITICAL_DAYS = 7;

/**
 * Retrieves SSL certificate details for the given hostname.
 *
 * @param {string} hostname
 * @param {number} port
 * @returns {Promise<{validFrom, validTo, issuer, subject, daysRemaining}>}
 */
function fetchCertificate(hostname, port = 443) {
  return new Promise((resolve, reject) => {
    const options = {
      host:               hostname,
      port,
      servername:         hostname,
      rejectUnauthorized: false, // we check manually below
      timeout:            10000,
    };

    const socket = tls.connect(options, () => {
      try {
        const cert = socket.getPeerCertificate(true);
        socket.destroy();

        if (!cert || !cert.valid_to) {
          return reject(new Error('No certificate returned'));
        }

        const validTo   = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const now       = new Date();
        const msPerDay  = 1000 * 60 * 60 * 24;
        const daysRemaining = Math.floor((validTo - now) / msPerDay);

        const issuer  = cert.issuer
          ? Object.entries(cert.issuer).map(([k, v]) => `${k}=${v}`).join(', ')
          : 'Unknown';
        const subject = cert.subject
          ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(', ')
          : hostname;

        resolve({ validFrom, validTo, issuer, subject, daysRemaining });
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('SSL connection timeout'));
    });

    socket.on('error', (err) => reject(err));
  });
}

/**
 * Determines the SSL status label from days remaining.
 *
 * @param {number} daysRemaining
 * @returns {string} 'valid' | 'expiring_soon' | 'critical' | 'expired'
 */
function certStatus(daysRemaining) {
  if (daysRemaining < 0)                        return 'expired';
  if (daysRemaining <= SSL_CRITICAL_DAYS)       return 'critical';
  if (daysRemaining <= SSL_WARN_DAYS)           return 'expiring_soon';
  return 'valid';
}

/**
 * Checks the SSL certificate for a monitor, persists the result,
 * and returns an object with cert details + status.
 *
 * @param {object} monitor  Must have { id, url, name }
 * @returns {Promise<{monitor, certStatus, daysRemaining, validTo, issuer, error}>}
 */
async function checkCertificate(monitor) {
  let hostname;
  try {
    hostname = new URL(monitor.url).hostname;
  } catch (_) {
    return { monitor, certStatus: 'error', daysRemaining: null, validTo: null, issuer: null,
             error: 'Invalid URL' };
  }

  // Only check HTTPS URLs
  if (!monitor.url.startsWith('https://')) {
    return { monitor, certStatus: 'unknown', daysRemaining: null, validTo: null, issuer: null,
             error: 'Not an HTTPS URL' };
  }

  let certData;
  let status = 'error';
  let errorMsg = null;

  try {
    certData = await fetchCertificate(hostname);
    status   = certStatus(certData.daysRemaining);
  } catch (err) {
    errorMsg = err.message;
    certData = { validFrom: null, validTo: null, issuer: 'Unknown', subject: hostname,
                 daysRemaining: null };
    console.error(
      `[${new Date().toISOString()}] [SSL] Error checking cert for "${monitor.name}": ${err.message}`
    );
  }

  // Upsert certificate record
  try {
    await pool.query(`
      INSERT INTO ssl_certificates
        (monitor_id, valid_from, valid_to, issuer, subject, days_remaining, status, last_checked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (monitor_id) DO UPDATE SET
        valid_from      = EXCLUDED.valid_from,
        valid_to        = EXCLUDED.valid_to,
        issuer          = EXCLUDED.issuer,
        subject         = EXCLUDED.subject,
        days_remaining  = EXCLUDED.days_remaining,
        status          = EXCLUDED.status,
        last_checked_at = NOW()
    `, [
      monitor.id,
      certData.validFrom,
      certData.validTo,
      certData.issuer,
      certData.subject,
      certData.daysRemaining,
      status,
    ]);
  } catch (dbErr) {
    console.error(
      `[${new Date().toISOString()}] [SSL] Failed to save cert for monitor ${monitor.id}: ${dbErr.message}`
    );
  }

  return {
    monitor,
    certStatus: status,
    daysRemaining: certData.daysRemaining,
    validTo:       certData.validTo,
    issuer:        certData.issuer,
    error:         errorMsg,
  };
}

/**
 * Runs SSL checks for all active monitors with check_ssl = TRUE.
 *
 * @returns {Promise<Array>}
 */
async function checkAllSSL() {
  let monitors = [];
  try {
    const { rows } = await pool.query(`
      SELECT id, name, url FROM monitors
      WHERE active = TRUE AND check_ssl = TRUE
      ORDER BY id
    `);
    monitors = rows;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [SSL] Failed to fetch monitors: ${err.message}`);
    return [];
  }

  if (monitors.length === 0) return [];

  const results = await Promise.all(monitors.map(m => checkCertificate(m)));

  // Log summary
  for (const r of results) {
    if (r.certStatus === 'error' || r.certStatus === 'unknown') continue;
    const icon = r.certStatus === 'valid' ? '✓' :
                 r.certStatus === 'expiring_soon' ? '⚠' : '✗';
    console.log(
      `[${new Date().toISOString()}] [SSL] ${icon} ${r.monitor.name.padEnd(30)} ` +
      `| ${r.certStatus.padEnd(14)} | ${r.daysRemaining != null ? r.daysRemaining + 'd remaining' : 'N/A'}`
    );
  }

  return results;
}

module.exports = { checkCertificate, checkAllSSL, certStatus, fetchCertificate, SSL_WARN_DAYS, SSL_CRITICAL_DAYS };
