/**
 * scheduler.js — Main entry point: DB init, API server, cron checks + SSL + retention
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv is optional */ }

const cron = require('node-cron');
const { initDB }             = require('./db');
const { checkAll }           = require('./checker');
const { checkAllSSL }        = require('./sslChecker');
const { processResults, processSSLResults } = require('./alertEngine');
const { runRetention }       = require('./retention');
const { startAPI }           = require('./api');
const { runStartupChecks }   = require('./networkCheck');

function ts() { return new Date().toISOString(); }

// ── Check cycle ───────────────────────────────────────────────────────────────

async function runChecks() {
  console.log(`[${ts()}] [SCHEDULER] ── Check cycle start ──────────────────────────`);
  try {
    const results = await checkAll();

    if (results.length === 0) {
      console.log(`[${ts()}] [SCHEDULER] No monitors due for checking.`);
      return;
    }

    for (const r of results) {
      const icon   = r.status === 'up' ? '✓' : '✗';
      const status = r.status === 'up' ? 'UP  ' : 'DOWN';
      const assert = r.assertionPassed === false ? ' [ASSERT FAIL]' : '';
      console.log(
        `[${ts()}] [SCHEDULER] ${icon} [${status}] ${r.monitor.name.padEnd(28)} ` +
        `| ${String(r.latency).padStart(6)}ms | HTTP ${String(r.statusCode ?? 'ERR').padEnd(3)}${assert}`
      );
    }

    await processResults(results);
    console.log(`[${ts()}] [SCHEDULER] ── Check cycle end (${results.length} monitors) ──────────`);
  } catch (err) {
    console.error(`[${ts()}] [SCHEDULER] Error during check cycle: ${err.message}`);
  }
}

// ── SSL check cycle ───────────────────────────────────────────────────────────

async function runSSLChecks() {
  console.log(`[${ts()}] [SCHEDULER] ── SSL check cycle start ─────────────────────`);
  try {
    const results = await checkAllSSL();
    if (results.length > 0) await processSSLResults(results);
    console.log(`[${ts()}] [SCHEDULER] ── SSL check cycle end (${results.length} monitors) ──────`);
  } catch (err) {
    console.error(`[${ts()}] [SCHEDULER] SSL check error: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${ts()}] [SCHEDULER] ╔══════════════════════════════════════════════╗`);
  console.log(`[${ts()}] [SCHEDULER] ║  MonitorAvaliabilityWeb — Starting Up       ║`);
  console.log(`[${ts()}] [SCHEDULER] ║  Created by Agencia Redlab                  ║`);
  console.log(`[${ts()}] [SCHEDULER] ║  Developed by Juan Camilo Medina Godoy      ║`);
  console.log(`[${ts()}] [SCHEDULER] ╚══════════════════════════════════════════════╝`);

  // Run startup checks (env, port, DB connectivity with retries + clear error messages)
  const { ok, errors } = await runStartupChecks();
  if (!ok) {
    console.error(`[${ts()}] [SCHEDULER] Startup checks failed — fix the errors above and restart.`);
    process.exit(1);
  }

  // Initialize database schema
  try {
    await initDB();
  } catch (err) {
    console.error(`[${ts()}] [SCHEDULER] Fatal: DB schema init failed: ${err.message}`);
    process.exit(1);
  }

  // Start HTTP API server
  startAPI();

  // Immediate first run
  await runChecks();
  await runSSLChecks();

  // ── Cron jobs ──────────────────────────────────────────────────────────────

  // HTTP checks: every minute (per-monitor intervals handled by next_check_at)
  cron.schedule('* * * * *', async () => {
    await runChecks();
  });
  console.log(`[${ts()}] [SCHEDULER] HTTP check cron: every 60 seconds`);

  // SSL checks: every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    await runSSLChecks();
  });
  console.log(`[${ts()}] [SCHEDULER] SSL check cron: every 6 hours`);

  // Data retention: daily at 03:00
  cron.schedule('0 3 * * *', async () => {
    console.log(`[${ts()}] [SCHEDULER] ── Data retention run ──────────────────────`);
    try {
      const summary = await runRetention();
      console.log(
        `[${ts()}] [SCHEDULER] Retention complete: ` +
        `${summary.checks} checks, ${summary.alerts} alerts, ${summary.incidents} incidents removed`
      );
    } catch (err) {
      console.error(`[${ts()}] [SCHEDULER] Retention error: ${err.message}`);
    }
  });
  console.log(`[${ts()}] [SCHEDULER] Retention cron: daily at 03:00`);
}

// ── Global error handlers ─────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] [SCHEDULER] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${ts()}] [SCHEDULER] Unhandled rejection:`, reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log(`[${ts()}] [SCHEDULER] SIGTERM — shutting down gracefully.`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${ts()}] [SCHEDULER] SIGINT — shutting down gracefully.`);
  process.exit(0);
});

main();
