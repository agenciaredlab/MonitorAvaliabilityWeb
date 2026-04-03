/**
 * scheduler.js — Main entry point: initializes DB, starts API, runs cron checks
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

// Load env vars from .env file when running locally (no-op if already set)
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const cron = require('node-cron');
const { initDB } = require('./db');
const { checkAll } = require('./checker');
const { processResults } = require('./alertEngine');
const { startAPI } = require('./api');

function ts() {
  return new Date().toISOString();
}

async function runChecks() {
  console.log(`[${ts()}] [SCHEDULER] Starting check cycle...`);
  try {
    const results = await checkAll();

    for (const r of results) {
      const statusLabel = r.status === 'up' ? 'UP  ' : 'DOWN';
      console.log(
        `[${ts()}] [SCHEDULER] [${statusLabel}] ${r.monitor.name.padEnd(30)} ` +
        `| ${String(r.latency).padStart(6)}ms | HTTP ${r.statusCode ?? 'ERR'} | ${r.monitor.url}`
      );
    }

    await processResults(results);
    console.log(`[${ts()}] [SCHEDULER] Check cycle complete. Checked ${results.length} monitor(s).`);
  } catch (err) {
    console.error(`[${ts()}] [SCHEDULER] Error during check cycle: ${err.message}`);
  }
}

async function main() {
  console.log(`[${ts()}] [SCHEDULER] MonitorAvaliabilityWeb starting up...`);
  console.log(`[${ts()}] [SCHEDULER] Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy`);

  try {
    await initDB();
  } catch (err) {
    console.error(`[${ts()}] [SCHEDULER] Fatal: database initialization failed: ${err.message}`);
    process.exit(1);
  }

  startAPI();

  // Run an immediate check on startup
  await runChecks();

  // Schedule checks every 60 seconds
  cron.schedule('* * * * *', async () => {
    await runChecks();
  });

  console.log(`[${ts()}] [SCHEDULER] Cron job scheduled: every 60 seconds.`);
}

// ────────────────────────────────────────────────────────────────────────────
// Global error handlers to prevent silent crashes in production
// ────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] [SCHEDULER] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${ts()}] [SCHEDULER] Unhandled promise rejection:`, reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log(`[${ts()}] [SCHEDULER] SIGTERM received — shutting down gracefully.`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${ts()}] [SCHEDULER] SIGINT received — shutting down gracefully.`);
  process.exit(0);
});

main();
