/**
 * tests/auth.test.js — Unit tests for src/auth.js
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');

const { pool }  = require('../src/db');
const { generateApiKey, validateApiKey, authMiddleware } = require('../src/auth');

beforeEach(() => jest.clearAllMocks());

// ── generateApiKey ────────────────────────────────────────────────────────────

describe('generateApiKey', () => {
  test('returns a plainKey with maw_ prefix and stores hash in DB', async () => {
    const row = { id: 1, name: 'CI Key', created_at: new Date() };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await generateApiKey('CI Key');

    expect(result.plainKey).toMatch(/^maw_[a-f0-9]{64}$/);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO api_keys'),
      expect.arrayContaining(['CI Key'])
    );
    expect(result.id).toBe(1);
  });

  test('each call generates a unique key', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, name: 'K', created_at: new Date() }] });

    const a = await generateApiKey('A');
    const b = await generateApiKey('B');

    expect(a.plainKey).not.toBe(b.plainKey);
  });
});

// ── validateApiKey ────────────────────────────────────────────────────────────

describe('validateApiKey', () => {
  test('returns key record for a valid non-revoked key', async () => {
    const keyRecord = { id: 1, name: 'Test', last_used_at: null, created_at: new Date() };
    pool.query
      .mockResolvedValueOnce({ rows: [keyRecord] }) // SELECT
      .mockResolvedValueOnce({ rows: [] });           // UPDATE last_used_at

    // Generate a valid key format
    const plainKey = 'maw_' + 'a'.repeat(64);
    const result   = await validateApiKey(plainKey);

    expect(result).toEqual(keyRecord);
  });

  test('returns null for unknown key', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await validateApiKey('maw_unknown');

    expect(result).toBeNull();
  });

  test('returns null for null/empty input', async () => {
    expect(await validateApiKey(null)).toBeNull();
    expect(await validateApiKey('')).toBeNull();
    expect(await validateApiKey(undefined)).toBeNull();
  });
});

// ── authMiddleware ────────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  const next = jest.fn();
  const res  = { status: jest.fn().mockReturnThis(), json: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_API_KEY;
  });

  test('calls next() when REQUIRE_API_KEY is not set', async () => {
    const req = { path: '/api/monitors', headers: {} };
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('calls next() when REQUIRE_API_KEY=true and valid key provided in Authorization header', async () => {
    process.env.REQUIRE_API_KEY = 'true';
    const keyRecord = { id: 1, name: 'Test', last_used_at: null };
    pool.query
      .mockResolvedValueOnce({ rows: [keyRecord] })
      .mockResolvedValueOnce({ rows: [] });

    const req = {
      path: '/api/monitors',
      headers: { authorization: 'Bearer maw_validkey' },
    };
    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('returns 401 when REQUIRE_API_KEY=true and no key provided', async () => {
    process.env.REQUIRE_API_KEY = 'true';
    const req = { path: '/api/monitors', headers: {} };

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Authentication required') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 when REQUIRE_API_KEY=true and invalid key provided', async () => {
    process.env.REQUIRE_API_KEY = 'true';
    pool.query.mockResolvedValueOnce({ rows: [] }); // key not found

    const req = {
      path: '/api/monitors',
      headers: { authorization: 'Bearer maw_badkey' },
    };
    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows public API paths without key even when auth is enabled', async () => {
    process.env.REQUIRE_API_KEY = 'true';
    const req = { path: '/api/public/status', headers: {} };

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
