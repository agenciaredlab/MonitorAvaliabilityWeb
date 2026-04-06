/**
 * tests/alertEngine.test.js — Unit tests for src/alertEngine.js
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');
jest.mock('axios');
jest.mock('nodemailer');
jest.mock('../src/incidentManager');

const axios        = require('axios');
const nodemailer   = require('nodemailer');
const { pool }     = require('../src/db');
const incidentMgr  = require('../src/incidentManager');
const { processResults, processSSLResults, isInMaintenance } = require('../src/alertEngine');

const mockMonitor = { id: 1, name: 'Test', url: 'https://example.com', sla_latency_ms: null };
const mockResult  = (status, latency = 50) => ({
  monitor:        mockMonitor,
  status,
  statusCode:     status === 'up' ? 200 : 500,
  latency,
  errorMessage:   null,
  assertionPassed: null,
});

// nodemailer mock
const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'mock' });
nodemailer.createTransport = jest.fn().mockReturnValue({ sendMail: sendMailMock });

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no maintenance window
  pool.query.mockResolvedValue({ rows: [] });
  incidentMgr.createIncident.mockResolvedValue({ id: 42 });
  incidentMgr.resolveIncident.mockResolvedValue({ id: 42, duration_seconds: 120 });
});

// ── isInMaintenance ───────────────────────────────────────────────────────────

describe('isInMaintenance', () => {
  test('returns true when maintenance window row found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const result = await isInMaintenance(1);
    expect(result).toBe(true);
  });

  test('returns false when no maintenance window', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await isInMaintenance(1);
    expect(result).toBe(false);
  });
});

// ── processResults — transitions ──────────────────────────────────────────────

describe('processResults', () => {
  test('does nothing when fewer than 2 checks exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'up' }] }); // only 1 check
    await processResults([mockResult('down')]);
    expect(incidentMgr.createIncident).not.toHaveBeenCalled();
  });

  test('fires DOWN alert on up→down transition', async () => {
    // last 2 checks: first=down (current), second=up (previous)
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'down' }, { status: 'up' }] }) // checks
      .mockResolvedValueOnce({ rows: [] })  // maintenance window check
      .mockResolvedValue({ rows: [] });     // alert insert + webhooks

    process.env.ALERT_EMAIL = 'test@test.com';
    process.env.SMTP_HOST   = 'smtp.test.com';
    process.env.SMTP_USER   = 'u';
    process.env.SMTP_PASS   = 'p';

    await processResults([mockResult('down')]);

    expect(incidentMgr.createIncident).toHaveBeenCalledWith(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toMatch(/\[DOWN\]/);
  });

  test('fires RECOVERY alert on down→up transition', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'up' }, { status: 'down' }] }) // checks
      .mockResolvedValueOnce({ rows: [] })  // maintenance
      .mockResolvedValue({ rows: [] });

    await processResults([mockResult('up')]);

    expect(incidentMgr.resolveIncident).toHaveBeenCalledWith(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toMatch(/\[RECOVERY\]/);
  });

  test('suppresses alerts during maintenance window', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'down' }, { status: 'up' }] }) // checks
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }); // maintenance window found

    await processResults([mockResult('down')]);

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(incidentMgr.createIncident).not.toHaveBeenCalled();
  });

  test('does not alert when status has not changed (up→up)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'up' }, { status: 'up' }] });

    await processResults([mockResult('up')]);

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(incidentMgr.createIncident).not.toHaveBeenCalled();
  });

  test('does not alert when status has not changed (down→down)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'down' }, { status: 'down' }] });

    await processResults([mockResult('down')]);

    expect(sendMailMock).not.toHaveBeenCalled();
  });

  test('fires SLA breach alert when latency exceeds threshold', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'up' }, { status: 'up' }] })
      .mockResolvedValue({ rows: [] });

    const monitor = { ...mockMonitor, sla_latency_ms: 100 };
    const result  = { monitor, status: 'up', statusCode: 200, latency: 500, errorMessage: null };

    await processResults([result]);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toMatch(/SLA/);
  });

  test('skips email when ALERT_EMAIL not set', async () => {
    delete process.env.ALERT_EMAIL;
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'down' }, { status: 'up' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    await processResults([mockResult('down')]);

    expect(sendMailMock).not.toHaveBeenCalled();
  });

  test('skips Slack when SLACK_WEBHOOK not set', async () => {
    delete process.env.SLACK_WEBHOOK;
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'up' }, { status: 'down' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    await processResults([mockResult('up')]);

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handles error on single result without throwing', async () => {
    pool.query.mockRejectedValueOnce(new Error('unexpected'));

    await expect(processResults([mockResult('up')])).resolves.toBeUndefined();
  });
});

// ── processSSLResults ─────────────────────────────────────────────────────────

describe('processSSLResults', () => {
  beforeEach(() => {
    process.env.ALERT_EMAIL = 'test@test.com';
    process.env.SMTP_HOST   = 'smtp.test.com';
    process.env.SMTP_USER   = 'u';
    process.env.SMTP_PASS   = 'p';
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('sends alert for expiring_soon certificate', async () => {
    const sslResult = {
      monitor:       mockMonitor,
      certStatus:    'expiring_soon',
      daysRemaining: 20,
      validTo:       new Date(Date.now() + 20 * 86400000).toISOString(),
      issuer:        'Let\'s Encrypt',
      error:         null,
    };

    await processSSLResults([sslResult]);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toMatch(/SSL/);
  });

  test('does not send alert for valid certificate', async () => {
    const sslResult = {
      monitor:       mockMonitor,
      certStatus:    'valid',
      daysRemaining: 90,
      validTo:       new Date(Date.now() + 90 * 86400000).toISOString(),
      issuer:        'Let\'s Encrypt',
      error:         null,
    };

    await processSSLResults([sslResult]);

    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
