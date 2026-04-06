/**
 * db.js — Database connection, schema initialization and migrations
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

    // ── Core monitors table ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitors (
        id                    SERIAL PRIMARY KEY,
        name                  VARCHAR(255) NOT NULL,
        url                   TEXT         NOT NULL,
        method                VARCHAR(10)  NOT NULL DEFAULT 'GET',
        interval_seconds      INTEGER      NOT NULL DEFAULT 60,
        timeout_ms            INTEGER      NOT NULL DEFAULT 10000,
        expected_status_codes TEXT         NOT NULL DEFAULT '200-399',
        assertion_type        VARCHAR(30),
        assertion_value       TEXT,
        sla_latency_ms        INTEGER,
        check_ssl             BOOLEAN      NOT NULL DEFAULT FALSE,
        is_public             BOOLEAN      NOT NULL DEFAULT TRUE,
        tags                  TEXT[]       NOT NULL DEFAULT '{}',
        request_headers       JSONB        NOT NULL DEFAULT '{}',
        request_body          TEXT,
        next_check_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        active                BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // ── Migrate existing monitors table (add new columns if missing) ─────────
    const newMonitorCols = [
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS method VARCHAR(10) NOT NULL DEFAULT 'GET'`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS timeout_ms INTEGER NOT NULL DEFAULT 10000`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS expected_status_codes TEXT NOT NULL DEFAULT '200-399'`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS assertion_type VARCHAR(30)`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS assertion_value TEXT`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS sla_latency_ms INTEGER`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS check_ssl BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS request_headers JSONB NOT NULL DEFAULT '{}'`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS request_body TEXT`,
      `ALTER TABLE monitors ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ];
    for (const sql of newMonitorCols) {
      await client.query(sql).catch(() => {});
    }

    // ── Checks table ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS checks (
        id               SERIAL PRIMARY KEY,
        monitor_id       INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        status           VARCHAR(10) NOT NULL CHECK (status IN ('up', 'down')),
        status_code      INTEGER,
        latency_ms       INTEGER,
        assertion_passed BOOLEAN,
        error_message    TEXT,
        checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      ALTER TABLE checks ADD COLUMN IF NOT EXISTS assertion_passed BOOLEAN
    `).catch(() => {});
    await client.query(`
      ALTER TABLE checks ADD COLUMN IF NOT EXISTS error_message TEXT
    `).catch(() => {});

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checks_monitor_id_checked_at
        ON checks (monitor_id, checked_at DESC);
    `);

    // ── Alerts table ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id         SERIAL PRIMARY KEY,
        monitor_id INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        type       VARCHAR(30) NOT NULL,
        sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Incidents table ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id               SERIAL PRIMARY KEY,
        monitor_id       INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        status           VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
        started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at      TIMESTAMPTZ,
        duration_seconds INTEGER,
        auto_created     BOOLEAN     NOT NULL DEFAULT TRUE
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_incidents_monitor_id_status
        ON incidents (monitor_id, status);
    `);

    // ── Incident updates (notes/timeline) ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS incident_updates (
        id          SERIAL PRIMARY KEY,
        incident_id INTEGER     NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        text        TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Maintenance windows ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_windows (
        id         SERIAL PRIMARY KEY,
        monitor_id INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        starts_at  TIMESTAMPTZ NOT NULL,
        ends_at    TIMESTAMPTZ NOT NULL,
        reason     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_monitor_id_window
        ON maintenance_windows (monitor_id, starts_at, ends_at);
    `);

    // ── Webhooks table ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id         SERIAL PRIMARY KEY,
        monitor_id INTEGER      NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        name       VARCHAR(100) NOT NULL DEFAULT 'Webhook',
        url        TEXT         NOT NULL,
        events     TEXT[]       NOT NULL DEFAULT '{down,recovery}',
        secret     VARCHAR(128),
        format     VARCHAR(20)  NOT NULL DEFAULT 'generic' CHECK (format IN ('generic','discord','slack','teams')),
        active     BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // ── SSL certificates cache ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ssl_certificates (
        id              SERIAL PRIMARY KEY,
        monitor_id      INTEGER     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE UNIQUE,
        valid_from      TIMESTAMPTZ,
        valid_to        TIMESTAMPTZ,
        issuer          TEXT,
        subject         TEXT,
        days_remaining  INTEGER,
        status          VARCHAR(20) NOT NULL DEFAULT 'unknown'
          CHECK (status IN ('valid','expiring_soon','critical','expired','error','unknown')),
        last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── API keys ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           SERIAL PRIMARY KEY,
        key_hash     VARCHAR(64)  NOT NULL UNIQUE,
        name         VARCHAR(100) NOT NULL,
        last_used_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        revoked      BOOLEAN      NOT NULL DEFAULT FALSE
      );
    `);

    console.log(`[${new Date().toISOString()}] [DB] Tables created / migrated.`);

    // ── Seed example monitors if empty ────────────────────────────────────────
    const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM monitors;');
    if (parseInt(rows[0].cnt, 10) === 0) {
      console.log(`[${new Date().toISOString()}] [DB] Seeding example monitors...`);
      await client.query(`
        INSERT INTO monitors (name, url, method, interval_seconds, check_ssl, is_public, tags) VALUES
          ($1, $2, 'GET', 60, TRUE,  TRUE, '{example,search}'),
          ($3, $4, 'GET', 60, TRUE,  TRUE, '{example,development}'),
          ($5, $6, 'GET', 60, FALSE, TRUE, '{example,dns}');
      `, [
        'Google',         'https://www.google.com',
        'GitHub',         'https://github.com',
        'Cloudflare DNS', 'https://1.1.1.1',
      ]);
      console.log(`[${new Date().toISOString()}] [DB] Seed completed.`);
    }

    console.log(`[${new Date().toISOString()}] [DB] Initialization complete.`);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
