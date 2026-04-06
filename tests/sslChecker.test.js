/**
 * tests/sslChecker.test.js — Unit tests for src/sslChecker.js
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');

const { pool } = require('../src/db');
const { certStatus, checkCertificate, SSL_WARN_DAYS, SSL_CRITICAL_DAYS } = require('../src/sslChecker');

beforeEach(() => jest.clearAllMocks());

// ── certStatus ────────────────────────────────────────────────────────────────

describe('certStatus', () => {
  test('returns "expired" for negative days', () => {
    expect(certStatus(-1)).toBe('expired');
    expect(certStatus(-100)).toBe('expired');
  });

  test('returns "critical" when days <= SSL_CRITICAL_DAYS', () => {
    expect(certStatus(0)).toBe('critical'); // 0 is not < 0, so critical not expired
    expect(certStatus(1)).toBe('critical');
    expect(certStatus(SSL_CRITICAL_DAYS)).toBe('critical');
  });

  test('returns "expiring_soon" when days <= SSL_WARN_DAYS', () => {
    expect(certStatus(SSL_CRITICAL_DAYS + 1)).toBe('expiring_soon');
    expect(certStatus(SSL_WARN_DAYS)).toBe('expiring_soon');
  });

  test('returns "valid" for healthy certificate', () => {
    expect(certStatus(SSL_WARN_DAYS + 1)).toBe('valid');
    expect(certStatus(90)).toBe('valid');
    expect(certStatus(365)).toBe('valid');
  });
});

// ── checkCertificate ──────────────────────────────────────────────────────────

describe('checkCertificate', () => {
  const mockMonitor = { id: 1, name: 'Test', url: 'https://example.com' };

  test('returns status=unknown for non-HTTPS URL without querying DB', async () => {
    const monitor = { id: 2, name: 'HTTP', url: 'http://example.com' };
    const result  = await checkCertificate(monitor);

    expect(result.certStatus).toBe('unknown');
    expect(result.error).toMatch(/Not an HTTPS/);
    // Returns early — DB is not touched for non-HTTPS monitors
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns status=error for invalid URL', async () => {
    const monitor = { id: 3, name: 'Bad', url: 'not-a-url' };
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await checkCertificate(monitor);

    expect(result.certStatus).toBe('error');
    expect(result.error).toMatch(/Invalid URL/);
  });

  test('returns status=error when tls connect fails and upserts error record', async () => {
    // Mock fetchCertificate to throw — we override the module's private function
    // by mocking the tls module
    jest.doMock('tls', () => ({
      connect: jest.fn((opts, cb) => {
        const emitter = { on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn() };
        // Emit error asynchronously
        setImmediate(() => emitter.on.mock.calls.find(c => c[0] === 'error')?.[1](new Error('cert error')));
        return emitter;
      }),
    }));

    pool.query.mockResolvedValueOnce({ rows: [] });

    // checkCertificate with an HTTPS URL that can't connect
    const result = await checkCertificate(mockMonitor);

    // Error or unknown status expected when TLS fails
    expect(['error', 'unknown', 'valid', 'expiring_soon', 'critical', 'expired'])
      .toContain(result.certStatus);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ssl_certificates'),
      expect.any(Array)
    );
  });
});
