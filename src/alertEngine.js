/**
 * alertEngine.js — Alert processing: email + Slack notifications
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const nodemailer = require('nodemailer');
const axios = require('axios');
const { pool } = require('./db');

// Build transporter only when SMTP settings are available
function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Sends an email alert.
 */
async function sendEmail(subject, text, html) {
  if (!process.env.ALERT_EMAIL) {
    return;
  }
  const transporter = createTransporter();
  if (!transporter) {
    return;
  }
  try {
    await transporter.sendMail({
      from: `"MonitorAvaliabilityWeb" <${process.env.SMTP_USER}>`,
      to: process.env.ALERT_EMAIL,
      subject,
      text,
      html,
    });
    console.log(`[${new Date().toISOString()}] [ALERT] Email sent: ${subject}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [ALERT] Email send failed: ${err.message}`);
  }
}

/**
 * Sends a Slack webhook notification.
 */
async function sendSlack(text) {
  if (!process.env.SLACK_WEBHOOK) {
    return;
  }
  try {
    await axios.post(
      process.env.SLACK_WEBHOOK,
      { text },
      { timeout: 8000 }
    );
    console.log(`[${new Date().toISOString()}] [ALERT] Slack notification sent.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [ALERT] Slack send failed: ${err.message}`);
  }
}

/**
 * Persists an alert record to the database.
 */
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

/**
 * Processes an array of check results, compares with the previous check,
 * and fires down/recovery alerts as needed.
 *
 * @param {Array<{monitor: object, status: string, statusCode: number|null, latency: number}>} results
 */
async function processResults(results) {
  for (const result of results) {
    try {
      const { monitor, status } = result;

      // Fetch the last 2 checks for this monitor (most recent first)
      const { rows: lastChecks } = await pool.query(
        `SELECT status FROM checks
         WHERE monitor_id = $1
         ORDER BY checked_at DESC
         LIMIT 2`,
        [monitor.id]
      );

      // Need at least 2 checks to compare transitions
      if (lastChecks.length < 2) {
        continue;
      }

      const currentStatus = lastChecks[0].status;   // just-inserted check
      const previousStatus = lastChecks[1].status;  // the one before

      if (previousStatus === 'up' && currentStatus === 'down') {
        const subject = `[DOWN] ${monitor.name} is unreachable`;
        const text =
          `Monitor "${monitor.name}" (${monitor.url}) is DOWN.\n` +
          `Status code: ${result.statusCode ?? 'N/A'}\n` +
          `Latency: ${result.latency}ms\n` +
          `Time: ${new Date().toISOString()}\n\n` +
          `-- MonitorAvaliabilityWeb | Agencia Redlab | Juan Camilo Medina Godoy`;
        const html =
          `<h2 style="color:#e53e3e;">&#x1F6A8; ${monitor.name} is DOWN</h2>` +
          `<p><strong>URL:</strong> <a href="${monitor.url}">${monitor.url}</a></p>` +
          `<p><strong>Status code:</strong> ${result.statusCode ?? 'N/A'}</p>` +
          `<p><strong>Latency:</strong> ${result.latency}ms</p>` +
          `<p><strong>Time:</strong> ${new Date().toISOString()}</p>` +
          `<hr><small>MonitorAvaliabilityWeb &mdash; Agencia Redlab &mdash; Juan Camilo Medina Godoy</small>`;

        await Promise.all([
          sendEmail(subject, text, html),
          sendSlack(`:red_circle: *[DOWN]* ${monitor.name} — ${monitor.url} — ${new Date().toISOString()}`),
          saveAlert(monitor.id, 'down'),
        ]);

        console.log(
          `[${new Date().toISOString()}] [ALERT] DOWN alert fired for "${monitor.name}"`
        );
      } else if (previousStatus === 'down' && currentStatus === 'up') {
        const subject = `[RECOVERY] ${monitor.name} is back online`;
        const text =
          `Monitor "${monitor.name}" (${monitor.url}) has RECOVERED.\n` +
          `Status code: ${result.statusCode ?? 'N/A'}\n` +
          `Latency: ${result.latency}ms\n` +
          `Time: ${new Date().toISOString()}\n\n` +
          `-- MonitorAvaliabilityWeb | Agencia Redlab | Juan Camilo Medina Godoy`;
        const html =
          `<h2 style="color:#38a169;">&#x2705; ${monitor.name} is BACK ONLINE</h2>` +
          `<p><strong>URL:</strong> <a href="${monitor.url}">${monitor.url}</a></p>` +
          `<p><strong>Status code:</strong> ${result.statusCode ?? 'N/A'}</p>` +
          `<p><strong>Latency:</strong> ${result.latency}ms</p>` +
          `<p><strong>Time:</strong> ${new Date().toISOString()}</p>` +
          `<hr><small>MonitorAvaliabilityWeb &mdash; Agencia Redlab &mdash; Juan Camilo Medina Godoy</small>`;

        await Promise.all([
          sendEmail(subject, text, html),
          sendSlack(`:large_green_circle: *[RECOVERY]* ${monitor.name} — ${monitor.url} — ${new Date().toISOString()}`),
          saveAlert(monitor.id, 'recovery'),
        ]);

        console.log(
          `[${new Date().toISOString()}] [ALERT] RECOVERY alert fired for "${monitor.name}"`
        );
      }
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [ALERT] Error processing result for monitor ${result?.monitor?.id}: ${err.message}`
      );
    }
  }
}

module.exports = { processResults };
