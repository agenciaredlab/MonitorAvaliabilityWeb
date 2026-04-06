/**
 * tests/checker.test.js — Unit tests for src/checker.js
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');
jest.mock('axios');

const axios      = require('axios');
const { pool }   = require('../src/db');
const { checkUrl, checkAll, evaluateAssertion, statusCodeMatches } = require('../src/checker');

const mockMonitor = {
  id: 1,
  name: 'Test Monitor',
  url: 'https://example.com',
  method: 'GET',
  interval_seconds: 60,
  timeout_ms: 10000,
  expected_status_codes: '200-399',
  assertion_type: null,
  assertion_value: null,
  sla_latency_ms: null,
  check_ssl: false,
  tags: [],
  request_headers: {},
  request_body: null,
};

// ── statusCodeMatches ─────────────────────────────────────────────────────────

describe('statusCodeMatches', () => {
  test('matches simple range 200-399', () => {
    expect(statusCodeMatches('200-399', 200)).toBe(true);
    expect(statusCodeMatches('200-399', 301)).toBe(true);
    expect(statusCodeMatches('200-399', 399)).toBe(true);
    expect(statusCodeMatches('200-399', 400)).toBe(false);
    expect(statusCodeMatches('200-399', 500)).toBe(false);
  });

  test('matches exact codes comma-separated', () => {
    expect(statusCodeMatches('200,201,204', 200)).toBe(true);
    expect(statusCodeMatches('200,201,204', 204)).toBe(true);
    expect(statusCodeMatches('200,201,204', 202)).toBe(false);
  });

  test('matches mixed ranges and exact codes', () => {
    expect(statusCodeMatches('200-299,404', 200)).toBe(true);
    expect(statusCodeMatches('200-299,404', 404)).toBe(true);
    expect(statusCodeMatches('200-299,404', 500)).toBe(false);
  });

  test('returns false for null/undefined code', () => {
    expect(statusCodeMatches('200-399', null)).toBe(false);
    expect(statusCodeMatches('200-399', undefined)).toBe(false);
  });

  test('returns false for null/empty expected', () => {
    expect(statusCodeMatches(null, 200)).toBe(false);
    expect(statusCodeMatches('', 200)).toBe(false);
  });
});

// ── evaluateAssertion ─────────────────────────────────────────────────────────

describe('evaluateAssertion', () => {
  test('no type returns passed=true', () => {
    expect(evaluateAssertion(null, null, 'body').passed).toBe(true);
    expect(evaluateAssertion('', '', 'body').passed).toBe(true);
  });

  describe('contains_text', () => {
    test('passes when text is found', () => {
      expect(evaluateAssertion('contains_text', 'healthy', '{"status":"healthy"}').passed).toBe(true);
    });
    test('fails when text is not found', () => {
      const r = evaluateAssertion('contains_text', 'healthy', '{"status":"error"}');
      expect(r.passed).toBe(false);
      expect(r.message).toMatch(/does not contain/);
    });
  });

  describe('not_contains_text', () => {
    test('passes when text is absent', () => {
      expect(evaluateAssertion('not_contains_text', 'error', '{"status":"ok"}').passed).toBe(true);
    });
    test('fails when text is present', () => {
      const r = evaluateAssertion('not_contains_text', 'error', '{"status":"error"}');
      expect(r.passed).toBe(false);
    });
  });

  describe('regex', () => {
    test('passes when pattern matches', () => {
      expect(evaluateAssertion('regex', '"status":\\s*"ok"', '{"status":"ok"}').passed).toBe(true);
    });
    test('fails when pattern does not match', () => {
      expect(evaluateAssertion('regex', '"status":\\s*"ok"', '{"status":"error"}').passed).toBe(false);
    });
  });

  describe('json_path', () => {
    test('passes on equality match', () => {
      expect(evaluateAssertion('json_path', 'status==ok', '{"status":"ok"}').passed).toBe(true);
    });
    test('fails on equality mismatch', () => {
      const r = evaluateAssertion('json_path', 'status==ok', '{"status":"error"}');
      expect(r.passed).toBe(false);
    });
    test('handles nested path', () => {
      expect(evaluateAssertion('json_path', 'data.count>0', '{"data":{"count":5}}').passed).toBe(true);
    });
    test('fails for invalid JSON', () => {
      const r = evaluateAssertion('json_path', 'status==ok', 'not-json');
      expect(r.passed).toBe(false);
      expect(r.message).toMatch(/not valid JSON/);
    });
  });
});

// ── checkUrl ──────────────────────────────────────────────────────────────────

describe('checkUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('returns status=up when HTTP 200', async () => {
    axios.mockResolvedValue({ status: 200, data: 'OK' });

    const result = await checkUrl(mockMonitor);

    expect(result.status).toBe('up');
    expect(result.statusCode).toBe(200);
    expect(result.monitor).toBe(mockMonitor);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO checks'),
      expect.arrayContaining([1, 'up', 200])
    );
  });

  test('returns status=down when HTTP 500', async () => {
    axios.mockResolvedValue({ status: 500, data: 'Internal Server Error' });

    const result = await checkUrl(mockMonitor);

    expect(result.status).toBe('down');
    expect(result.statusCode).toBe(500);
  });

  test('returns status=down when HTTP 404 with default expected codes 200-399', async () => {
    axios.mockResolvedValue({ status: 404, data: 'Not Found' });

    const result = await checkUrl(mockMonitor);

    expect(result.status).toBe('down');
  });

  test('returns status=up when HTTP 404 with expected_status_codes including 404', async () => {
    axios.mockResolvedValue({ status: 404, data: 'Not Found' });

    const monitor = { ...mockMonitor, expected_status_codes: '200-399,404' };
    const result  = await checkUrl(monitor);

    expect(result.status).toBe('up');
  });

  test('returns status=down on network error (axios throws)', async () => {
    axios.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkUrl(mockMonitor);

    expect(result.status).toBe('down');
    expect(result.statusCode).toBeNull();
    expect(result.errorMessage).toMatch(/ECONNREFUSED/);
  });

  test('marks down when assertion fails even with 200', async () => {
    axios.mockResolvedValue({ status: 200, data: '{"status":"error"}' });

    const monitor = { ...mockMonitor, assertion_type: 'contains_text', assertion_value: 'healthy' };
    const result  = await checkUrl(monitor);

    expect(result.status).toBe('down');
    expect(result.assertionPassed).toBe(false);
  });

  test('marks up when assertion passes', async () => {
    axios.mockResolvedValue({ status: 200, data: '{"status":"healthy"}' });

    const monitor = { ...mockMonitor, assertion_type: 'contains_text', assertion_value: 'healthy' };
    const result  = await checkUrl(monitor);

    expect(result.status).toBe('up');
    expect(result.assertionPassed).toBe(true);
  });

  test('handles DB save error gracefully (does not throw)', async () => {
    axios.mockResolvedValue({ status: 200, data: 'OK' });
    pool.query.mockRejectedValueOnce(new Error('DB error'));

    await expect(checkUrl(mockMonitor)).resolves.toBeDefined();
  });
});

// ── checkAll ──────────────────────────────────────────────────────────────────

describe('checkAll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fetches active due monitors and returns results', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [mockMonitor] }) // SELECT monitors
      .mockResolvedValue({ rows: [] });                // INSERT checks + UPDATE

    axios.mockResolvedValue({ status: 200, data: 'OK' });

    const results = await checkAll();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('up');
  });

  test('returns empty array when no monitors are due', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const results = await checkAll();

    expect(results).toHaveLength(0);
  });

  test('returns empty array when DB query fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB down'));

    const results = await checkAll();

    expect(results).toHaveLength(0);
  });
});
