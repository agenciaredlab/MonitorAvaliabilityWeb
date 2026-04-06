/**
 * alertEngine.js — Alert processing: email, Slack, webhooks + incident management
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const axios      = require('axios');
const { pool }   = require('./db');
const { createIncident, resolveIncident } = require('./incidentManager');

// ── SMTP transporter ─────────────────────────────────────────────────────────

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendEmail(subject, text, html) {
  if (!process.env.ALERT_EMAIL) return;
  const transporter = createTransporter();
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from:    `"MonitorAvaliabilityWeb" <${process.env.SMTP_USER}>`,
      to:      process.env.ALERT_EMAIL,
      subject, text, html,
    });
    console.log(`[${new Date().toISOString()}] [ALERT] Email sent: ${subject}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [ALERT] Email failed: ${err.message}`);
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function sendSlack(text) {
  if (!process.env.SLACK_WEBHOOK) return;
  try {
    await axios.post(process.env.SLACK_WEBHOOK, { text }, { timeout: 8000 });
    console.log(`[${new Date().toISOString()}] [ALERT] Slack sent.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [ALERT] Slack failed: ${err.message}`);
  }
}

// ── Generic / Discord / Teams webhooks ───────────────────────────────────────

/**
 * Builds the payload for a webhook based on its format.
 */
function buildWebhookPayload(format, eventType, monitor, result, incident) {
  const isDown = eventType === 'down';
  const emoji  = isDown ? '🔴' : '🟢';
  const label  = isDown ? 'DOWN' : 'RECOVERY';
  const color  = isDown ? 14177041 : 3066993; // decimal for #D8262F / #2ECC71
  const colorHex = isDown ? '#D8262F' : '#2ECC71';
  const ts     = new Date().toISOString();

  switch (format) {
    case 'discord':
      return {
        embeds: [{
          title:       `${emoji} [${label}] ${monitor.name}`,
          description: monitor.url,
          color,
          fields: [
            { name: 'Status',      value: result.status.toUpperCase(), inline: true },
            { name: 'HTTP Code',   value: String(result.statusCode ?? 'N/A'), inline: true },
            { name: 'Latency',     value: `${result.latency}ms`, inline: true },
            ...(incident ? [{ name: 'Incident #', value: String(incident.id), inline: true }] : []),
          ],
          timestamp: ts,
          footer:    { text: 'MonitorAvaliabilityWeb by Agencia Redlab' },
        }],
      };

    case 'slack':
      return {
        attachments: [{
          color:    colorHex,
          title:    `${emoji} [${label}] ${monitor.name}`,
          title_link: monitor.url,
          fields: [
            { title: 'URL',        value: monitor.url,                          short: false },
            { title: 'HTTP Code',  value: String(result.statusCode ?? 'N/A'),   short: true },
            { title: 'Latency',    value: `${result.latency}ms`,                short: true },
          ],
          footer: 'MonitorAvaliabilityWeb | Agencia Redlab',
          ts:     Math.floor(Date.now() / 1000),
        }],
      };

    case 'teams':
      return {
        '@type':      'MessageCard',
        '@context':   'https://schema.org/extensions',
        themeColor:   colorHex.slice(1),
        summary:      `[${label}] ${monitor.name}`,
        sections: [{
          activityTitle:    `${emoji} [${label}] ${monitor.name}`,
          activitySubtitle: monitor.url,
          facts: [
            { name: 'Status',    value: result.status.toUpperCase() },
            { name: 'HTTP Code', value: String(result.statusCode ?? 'N/A') },
            { name: 'Latency',   value: `${result.latency}ms` },
            { name: 'Time',      value: ts },
          ],
        }],
      };

    case 'generic':
    default:
      return {
        event:      eventType,
        monitor:    { id: monitor.id, name: monitor.name, url: monitor.url },
        status:     result.status,
        statusCode: result.statusCode,
        latency:    result.latency,
        incident:   incident ? { id: incident.id } : null,
        timestamp:  ts,
        source:     'MonitorAvaliabilityWeb by Agencia Redlab / Juan Camilo Medina Godoy',
      };
  }
}

/**
 * Dispatches all configured webhooks for a monitor and event type.
 */
async function dispatchWebhooks(monitorId, eventType, monitor, result, incident) {
  let webhooks = [];
  try {
    const { rows } = await pool.query(`
      SELECT id, url, format, secret, events
      FROM webhooks
      WHERE monitor_id = $1 AND active = TRUE
    `, [monitorId]);
    webhooks = rows;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [WEBHOOK] Failed to fetch webhooks: ${err.message}`);
    return;
  }

  for (const wh of webhooks) {
    if (!wh.events.includes(eventType)) continue;
    try {
      const payload     = buildWebhookPayload(wh.format, eventType, monitor, result, incident);
      const bodyStr     = JSON.stringify(payload);
      const headers     = { 'Content-Type': 'application/json' };

      // Sign the payload if a secret is configured
      if (wh.secret) {
        const sig = crypto.createHmac('sha256', wh.secret).update(bodyStr).digest('hex');
        headers['X-Signature-256'] = `sha256=${sig}`;
      }

      await axios.post(wh.url, payload, { headers, timeout: 10000 });
      console.log(
        `[${new Date().toISOString()}] [WEBHOOK] Sent ${eventType} to ${wh.format} webhook #${wh.id}`
      );
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [WEBHOOK] Failed webhook #${wh.id}: ${err.message}`
      );
    }
  }
}

// ── Maintenance window check ──────────────────────────────────────────────────

/**
 * Returns true if the monitor is currently in a maintenance window.
 */
async function isInMaintenance(monitorId) {
  const { rows } = await pool.query(`
    SELECT id FROM maintenance_windows
    WHERE monitor_id = $1
      AND starts_at <= NOW()
      AND ends_at   >= NOW()
    LIMIT 1
  `, [monitorId]);
  return rows.length > 0;
}

// ── Alert persistence ─────────────────────────────────────────────────────────

async function saveAlert(monitorId, type) {
  try {
    await pool.query(
      `INSERT INTO alerts (monitor_id, type, sent_at) VALUES ($1, $2, NOW())`,
      [monitorId, type]
    );
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] [ALERT] Failed to save alert for monitor ${monitorId}: ${err.message}`
    );
  }
}

// ── Main processing ───────────────────────────────────────────────────────────

/**
 * Processes an array of check results:
 * - Detects UP→DOWN and DOWN→UP transitions
 * - Respects maintenance windows (no alerts during maintenance)
 * - Fires email, Slack, and webhook notifications
 * - Auto-creates and resolves incidents
 * - Checks SLA latency thresholds
 *
 * @param {Array} results  From checker.checkAll()
 */
async function processResults(results) {
  for (const result of results) {
    try {
      const { monitor } = result;

      // Fetch the last 2 checks for transition detection
      const { rows: lastChecks } = await pool.query(`
        SELECT status FROM checks
        WHERE monitor_id = $1
        ORDER BY checked_at DESC
        LIMIT 2
      `, [monitor.id]);

      if (lastChecks.length < 2) continue;

      const currentStatus  = lastChecks[0].status;
      const previousStatus = lastChecks[1].status;

      // Check maintenance window
      let inMaintenance = false;
      try {
        inMaintenance = await isInMaintenance(monitor.id);
      } catch (_) {}

      // ── DOWN transition ───────────────────────────────────────────────────
      if (previousStatus === 'up' && currentStatus === 'down') {
        let incident = null;

        if (!inMaintenance) {
          // Create incident
          try { incident = await createIncident(monitor.id); } catch (_) {}

          const subject = `[DOWN] ${monitor.name} is unreachable`;
          const body    = `Monitor "${monitor.name}" (${monitor.url}) is DOWN.\n` +
                          `Status code: ${result.statusCode ?? 'N/A'}\n` +
                          `Latency: ${result.latency}ms\n` +
                          (result.errorMessage ? `Error: ${result.errorMessage}\n` : '') +
                          `Time: ${new Date().toISOString()}\n\n` +
                          `-- MonitorAvaliabilityWeb | Agencia Redlab | Juan Camilo Medina Godoy`;
          const html    = `<h2 style="color:#D8262F;">🚨 ${monitor.name} is DOWN</h2>` +
                          `<p><strong>URL:</strong> <a href="${monitor.url}">${monitor.url}</a></p>` +
                          `<p><strong>Status code:</strong> ${result.statusCode ?? 'N/A'}</p>` +
                          `<p><strong>Latency:</strong> ${result.latency}ms</p>` +
                          (result.errorMessage ? `<p><strong>Error:</strong> ${result.errorMessage}</p>` : '') +
                          `<p><strong>Time:</strong> ${new Date().toISOString()}</p>` +
                          (incident ? `<p><strong>Incident #:</strong> ${incident.id}</p>` : '') +
                          `<hr><small>MonitorAvaliabilityWeb — Agencia Redlab — Juan Camilo Medina Godoy</small>`;

          await Promise.allSettled([
            sendEmail(subject, body, html),
            sendSlack(`:red_circle: *[DOWN]* ${monitor.name} — ${monitor.url} — ${new Date().toISOString()}`),
            dispatchWebhooks(monitor.id, 'down', monitor, result, incident),
            saveAlert(monitor.id, 'down'),
          ]);

          console.log(`[${new Date().toISOString()}] [ALERT] DOWN alert fired for "${monitor.name}"`);
        } else {
          console.log(
            `[${new Date().toISOString()}] [ALERT] "${monitor.name}" is DOWN but in maintenance window — suppressed.`
          );
        }
      }

      // ── RECOVERY transition ───────────────────────────────────────────────
      else if (previousStatus === 'down' && currentStatus === 'up') {
        let incident = null;
        try { incident = await resolveIncident(monitor.id); } catch (_) {}

        if (!inMaintenance) {
          const subject = `[RECOVERY] ${monitor.name} is back online`;
          const body    = `Monitor "${monitor.name}" (${monitor.url}) has RECOVERED.\n` +
                          `Status code: ${result.statusCode ?? 'N/A'}\n` +
                          `Latency: ${result.latency}ms\n` +
                          `Time: ${new Date().toISOString()}\n\n` +
                          `-- MonitorAvaliabilityWeb | Agencia Redlab | Juan Camilo Medina Godoy`;
          const html    = `<h2 style="color:#2ECC71;">✅ ${monitor.name} is BACK ONLINE</h2>` +
                          `<p><strong>URL:</strong> <a href="${monitor.url}">${monitor.url}</a></p>` +
                          `<p><strong>Status code:</strong> ${result.statusCode ?? 'N/A'}</p>` +
                          `<p><strong>Latency:</strong> ${result.latency}ms</p>` +
                          `<p><strong>Time:</strong> ${new Date().toISOString()}</p>` +
                          (incident ? `<p><strong>Incident duration:</strong> ${incident.duration_seconds}s</p>` : '') +
                          `<hr><small>MonitorAvaliabilityWeb — Agencia Redlab — Juan Camilo Medina Godoy</small>`;

          await Promise.allSettled([
            sendEmail(subject, body, html),
            sendSlack(`:large_green_circle: *[RECOVERY]* ${monitor.name} — ${monitor.url} — ${new Date().toISOString()}`),
            dispatchWebhooks(monitor.id, 'recovery', monitor, result, incident),
            saveAlert(monitor.id, 'recovery'),
          ]);

          console.log(`[${new Date().toISOString()}] [ALERT] RECOVERY alert fired for "${monitor.name}"`);
        }
      }

      // ── SLA latency breach ────────────────────────────────────────────────
      if (monitor.sla_latency_ms && currentStatus === 'up' && result.latency > monitor.sla_latency_ms) {
        try {
          await Promise.allSettled([
            sendEmail(
              `[SLA BREACH] ${monitor.name} latency ${result.latency}ms > ${monitor.sla_latency_ms}ms`,
              `SLA latency threshold breached for "${monitor.name}" (${monitor.url}).\n` +
              `Current latency: ${result.latency}ms — Threshold: ${monitor.sla_latency_ms}ms\n` +
              `Time: ${new Date().toISOString()}\n\n` +
              `-- MonitorAvaliabilityWeb | Agencia Redlab | Juan Camilo Medina Godoy`,
              `<h2 style="color:#F39C12;">⚠️ SLA Breach: ${monitor.name}</h2>` +
              `<p>Latency <strong>${result.latency}ms</strong> exceeded threshold of ` +
              `<strong>${monitor.sla_latency_ms}ms</strong></p>` +
              `<hr><small>MonitorAvaliabilityWeb — Agencia Redlab — Juan Camilo Medina Godoy</small>`
            ),
            dispatchWebhooks(monitor.id, 'sla_breach', monitor, result, null),
            saveAlert(monitor.id, 'sla_breach'),
          ]);
          console.log(
            `[${new Date().toISOString()}] [ALERT] SLA breach for "${monitor.name}": ${result.latency}ms > ${monitor.sla_latency_ms}ms`
          );
        } catch (_) {}
      }

    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [ALERT] Error processing monitor ${result?.monitor?.id}: ${err.message}`
      );
    }
  }
}

/**
 * Processes SSL certificate check results and fires alerts for expiring/expired certs.
 *
 * @param {Array} sslResults  From sslChecker.checkAllSSL()
 */
async function processSSLResults(sslResults) {
  for (const r of sslResults) {
    try {
      const alertStatuses = ['expiring_soon', 'critical', 'expired'];
      if (!alertStatuses.includes(r.certStatus)) continue;

      const label   = r.certStatus === 'expired' ? 'EXPIRED' :
                      r.certStatus === 'critical' ? 'EXPIRING IN < 7 DAYS' : 'EXPIRING SOON';
      const subject = `[SSL ${label}] ${r.monitor.name}`;
      const text    = `SSL certificate for "${r.monitor.name}" (${r.monitor.url}) is ${r.certStatus}.\n` +
                      `Days remaining: ${r.daysRemaining ?? 'N/A'}\n` +
                      `Expiry date: ${r.validTo ? new Date(r.validTo).toISOString() : 'N/A'}\n` +
                      `Time: ${new Date().toISOString()}\n\n` +
                      `-- MonitorAvaliabilityWeb | Agencia Redlab | Juan Camilo Medina Godoy`;
      const html    = `<h2 style="color:#F39C12;">🔒 SSL ${label}: ${r.monitor.name}</h2>` +
                      `<p><strong>URL:</strong> <a href="${r.monitor.url}">${r.monitor.url}</a></p>` +
                      `<p><strong>Days remaining:</strong> ${r.daysRemaining ?? 'N/A'}</p>` +
                      `<p><strong>Expiry:</strong> ${r.validTo ? new Date(r.validTo).toDateString() : 'N/A'}</p>` +
                      `<hr><small>MonitorAvaliabilityWeb — Agencia Redlab — Juan Camilo Medina Godoy</small>`;

      await Promise.allSettled([
        sendEmail(subject, text, html),
        sendSlack(`:lock: *[SSL ${label}]* ${r.monitor.name} — ${r.daysRemaining ?? 'N/A'} days remaining`),
        dispatchWebhooks(r.monitor.id, 'ssl_expiring', r.monitor, { status: r.certStatus, statusCode: null, latency: 0 }, null),
        saveAlert(r.monitor.id, `ssl_${r.certStatus}`),
      ]);

      console.log(`[${new Date().toISOString()}] [ALERT] SSL alert fired for "${r.monitor.name}" (${r.certStatus})`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [ALERT] SSL alert error for monitor ${r?.monitor?.id}: ${err.message}`);
    }
  }
}

module.exports = { processResults, processSSLResults, sendEmail, sendSlack, dispatchWebhooks, isInMaintenance };
