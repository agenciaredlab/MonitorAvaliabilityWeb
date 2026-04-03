/**
 * db.js — Database connection and schema initialization
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] [DB] Unexpected pool error:`, err.message);
});

async function initDB() {
  const client = await pool.connect();
  try {
    console.log(`[${new Date().toISOString()}] [DB] Initializing database schema...`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitors (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(255) NOT NULL,
        url              TEXT        NOT NULL,
        interval_seconds INTEGER     NOT NULL DEFAULT 60,
        active           BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS checks (
        id          SERIAL PRIMARY KEY,
        monitor_id  INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        status      VARCHAR(10) NOT NULL CHECK (status IN ('up', 'down')),
        status_code INTEGER,
        latency_ms  INTEGER,
        checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checks_monitor_id_checked_at
        ON checks (monitor_id, checked_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id         SERIAL PRIMARY KEY,
        monitor_id INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        type       VARCHAR(20) NOT NULL CHECK (type IN ('down', 'recovery')),
        sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log(`[${new Date().toISOString()}] [DB] Tables created / verified.`);

    // Seed example monitors if table is empty
    const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM monitors;');
    if (parseInt(rows[0].cnt, 10) === 0) {
      console.log(`[${new Date().toISOString()}] [DB] Seeding example monitors...`);
      await client.query(`
        INSERT INTO monitors (name, url, interval_seconds) VALUES
          ($1, $2, $3),
          ($4, $5, $6),
          ($7, $8, $9);
      `, [
        'Google',         'https://www.google.com',         60,
        'GitHub',         'https://github.com',             60,
        'Cloudflare DNS', 'https://1.1.1.1',                60,
      ]);
      console.log(`[${new Date().toISOString()}] [DB] Seed completed.`);
    }

    console.log(`[${new Date().toISOString()}] [DB] Initialization complete.`);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
