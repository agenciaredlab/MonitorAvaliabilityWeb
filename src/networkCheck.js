/**
 * networkCheck.js — Startup environment validation and network diagnostics
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Detects port conflicts, validates env vars, tests DB connectivity with
 * retries, and reports every issue with a human-readable explanation so the
 * user knows exactly why the app is not starting — even on servers that
 * already run Traefik or other Docker-managed services.
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const net    = require('net');
const { Pool } = require('pg');

function ts() { return new Date().toISOString(); }

function log(level, msg) {
  const icons = { info: 'ℹ', ok: '✓', warn: '⚠', error: '✗' };
  console.log(`[${ts()}] [NETWORK] ${icons[level] || '-'} ${msg}`);
}

// ── Port check ────────────────────────────────────────────────────────────────

/**
 * Checks whether a TCP port on localhost is already in use.
 * Returns true if port is free, false if occupied.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(true); // unknown error — assume free
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

// ── DB connectivity with retry ────────────────────────────────────────────────

/**
 * Attempts to connect to PostgreSQL up to maxAttempts times.
 * Returns { ok, error } — never throws.
 */
async function testDatabaseConnection(connectionString, maxAttempts = 5, delayMs = 2000) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      await pool.end();
      return { ok: true, error: null };
    } catch (err) {
      lastError = err;
      await pool.end().catch(() => {});

      if (attempt < maxAttempts) {
        log('warn', `DB connection attempt ${attempt}/${maxAttempts} failed — retrying in ${delayMs / 1000}s…`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Translates a pg error into a human-readable message with a fix suggestion.
 */
function explainDbError(err) {
  const code = err.code || '';
  const msg  = err.message || '';

  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return {
      message: 'Database host refused the connection.',
      suggestion: 'Check that PostgreSQL is running and that DATABASE_URL points to the correct host/port.\n' +
                  '  → Local dev: run `docker-compose up db` first.\n' +
                  '  → Swarm: ensure the db service is on the same overlay network as the app.',
    };
  }
  if (code === '28P01' || msg.includes('password authentication failed')) {
    return {
      message: 'PostgreSQL rejected the credentials.',
      suggestion: 'Verify POSTGRES_USER and POSTGRES_PASSWORD in .env match the DATABASE_URL.',
    };
  }
  if (code === '3D000' || msg.includes('does not exist')) {
    return {
      message: `Database "${msg.match(/"([^"]+)"/)?.[1] || '?'}" does not exist.`,
      suggestion: 'Create the database first:\n' +
                  '  docker exec -it <db_container> createdb -U <user> <dbname>',
    };
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
    return {
      message: 'Connection to the database timed out.',
      suggestion: 'The host is reachable but not responding. Check firewall rules and that\n' +
                  'the db service is on the same Docker network as the app service.',
    };
  }
  if (msg.includes('getaddrinfo') || msg.includes('ENOTFOUND')) {
    return {
      message: `Cannot resolve database hostname.`,
      suggestion: 'Check the host part of DATABASE_URL.\n' +
                  '  → In docker-compose: use the service name (e.g. "db").\n' +
                  '  → In Swarm: use the service name within the same overlay network.',
    };
  }
  return {
    message: `Unexpected error: ${msg}`,
    suggestion: 'Check DATABASE_URL format: postgres://user:password@host:port/dbname',
  };
}

// ── Safe DATABASE_URL parser (no password in logs) ────────────────────────────

function safeDbUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch (_) {
    return '(invalid URL)';
  }
}

// ── Main startup check ────────────────────────────────────────────────────────

/**
 * Runs all startup checks and returns a summary.
 * Logs each finding to stdout with clear icons and suggestions.
 *
 * @returns {Promise<{ ok: boolean, warnings: string[], errors: string[] }>}
 */
async function runStartupChecks() {
  const warnings = [];
  const errors   = [];

  log('info', '═══════════════════════════════════════════════════');
  log('info', ' MonitorAvaliabilityWeb — Startup Checks');
  log('info', ' Created by Agencia Redlab | Juan Camilo Medina Godoy');
  log('info', '═══════════════════════════════════════════════════');

  // ── Node.js version ────────────────────────────────────────────────────────
  log('info', `Node.js ${process.version}  |  Platform: ${process.platform}`);

  // ── Required: DATABASE_URL ─────────────────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    const msg = 'DATABASE_URL is not set — the app cannot start without a database.';
    log('error', msg);
    log('error', '  → Set DATABASE_URL=postgres://user:password@host:5432/dbname in your .env file.');
    errors.push(msg);
  } else {
    log('info', `DATABASE_URL: ${safeDbUrl(dbUrl)}`);

    // Test DB connectivity
    log('info', 'Testing database connectivity (up to 5 attempts)…');
    const { ok, error } = await testDatabaseConnection(dbUrl);
    if (ok) {
      log('ok', 'Database connected successfully.');
    } else {
      const { message, suggestion } = explainDbError(error);
      log('error', `Database connection failed: ${message}`);
      log('error', `  → ${suggestion.replace(/\n/g, '\n  → ')}`);
      errors.push(`Database unreachable: ${message}`);
    }
  }

  // ── PORT availability ──────────────────────────────────────────────────────
  const port = parseInt(process.env.PORT || '3000', 10);
  const free = await isPortFree(port);
  if (!free) {
    const msg = `Port ${port} is already in use by another process.`;
    log('warn', msg);
    log('warn', `  → Set PORT=<other> in .env (e.g. PORT=3001) or stop the conflicting service.`);
    log('warn', '  → In Docker: map a different host port with -p <hostPort>:3000.');
    warnings.push(msg);
  } else {
    log('ok', `Port ${port} is available.`);
  }

  // ── SMTP configuration ─────────────────────────────────────────────────────
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const alertEmail = process.env.ALERT_EMAIL;

  if (smtpHost && (!smtpUser || !smtpPass)) {
    const msg = 'SMTP_HOST is set but SMTP_USER or SMTP_PASS is missing — email alerts are disabled.';
    log('warn', msg);
    log('warn', '  → Set SMTP_USER and SMTP_PASS to enable email notifications.');
    warnings.push(msg);
  } else if (smtpHost && smtpUser && smtpPass && !alertEmail) {
    const msg = 'SMTP configured but ALERT_EMAIL is not set — no emails will be sent.';
    log('warn', msg);
    warnings.push(msg);
  } else if (smtpHost) {
    log('ok', `SMTP configured: ${smtpHost} → ${alertEmail}`);
  } else {
    log('info', 'SMTP not configured — email alerts disabled.');
  }

  // ── Slack webhook ──────────────────────────────────────────────────────────
  if (process.env.SLACK_WEBHOOK) {
    log('ok', 'Slack webhook configured.');
  } else {
    log('info', 'Slack webhook not configured — Slack alerts disabled.');
  }

  // ── API key auth ───────────────────────────────────────────────────────────
  if (process.env.REQUIRE_API_KEY === 'true') {
    log('ok', 'API key authentication: ENABLED.');
  } else {
    log('info', 'API key authentication: disabled (set REQUIRE_API_KEY=true to enable).');
  }

  // ── Retention settings ─────────────────────────────────────────────────────
  const retChecks    = process.env.RETENTION_CHECKS_DAYS    || '90';
  const retAlerts    = process.env.RETENTION_ALERTS_DAYS    || '180';
  const retIncidents = process.env.RETENTION_INCIDENTS_DAYS || '365';
  log('info', `Data retention — checks: ${retChecks}d | alerts: ${retAlerts}d | incidents: ${retIncidents}d`);

  // ── Summary ────────────────────────────────────────────────────────────────
  log('info', '───────────────────────────────────────────────────');
  if (errors.length === 0 && warnings.length === 0) {
    log('ok', 'All startup checks passed. Application is ready.');
  } else {
    if (warnings.length > 0) log('warn', `${warnings.length} warning(s) — check output above.`);
    if (errors.length > 0)   log('error', `${errors.length} error(s) — application cannot start safely.`);
  }
  log('info', '═══════════════════════════════════════════════════');

  return { ok: errors.length === 0, warnings, errors };
}

module.exports = { runStartupChecks, testDatabaseConnection, isPortFree };
