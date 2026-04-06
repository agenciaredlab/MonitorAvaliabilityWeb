/**
 * tests/api.test.js — Integration tests for src/api.js (Express endpoints)
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');
jest.mock('../src/auth', () => ({
  authMiddleware: (req, res, next) => next(), // bypass auth in tests
  generateApiKey: jest.fn().mockResolvedValue({
    plainKey: 'maw_testkey',
    id: 1,
    name: 'Test',
    created_at: new Date(),
  }),
}));
jest.mock('../src/incidentManager', () => ({
  getIncidents:        jest.fn().mockResolvedValue([]),
  getAllOpenIncidents:  jest.fn().mockResolvedValue([]),
  addNote:             jest.fn().mockResolvedValue({ id: 1, text: 'note' }),
}));

const request = require('supertest');
const { pool }  = require('../src/db');
const { startAPI } = require('../src/api');

let server;

beforeAll(() => {
  process.env.PORT = '0'; // OS assigns a random free port
  server = startAPI();
});

afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => jest.clearAllMocks());

// ── Helpers ───────────────────────────────────────────────────────────────────

const monitorRow = {
  id: 1, name: 'Google', url: 'https://google.com', method: 'GET',
  interval_seconds: 60, timeout_ms: 10000, expected_status_codes: '200-399',
  assertion_type: null, assertion_value: null, sla_latency_ms: null,
  check_ssl: true, is_public: true, tags: ['search'], created_at: new Date(),
  current_status: 'up', last_latency: 120, last_checked_at: new Date(),
  ssl_status: 'valid', ssl_days_remaining: 80, open_incidents: 0,
};

// ── GET /api/monitors ─────────────────────────────────────────────────────────

describe('GET /api/monitors', () => {
  test('returns 200 with array of monitors', async () => {
    pool.query.mockResolvedValueOnce({ rows: [monitorRow] });

    const res = await request(server).get('/api/monitors');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].name).toBe('Google');
  });

  test('returns 500 on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB down'));

    const res = await request(server).get('/api/monitors');

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

// ── GET /api/monitors/:id ─────────────────────────────────────────────────────

describe('GET /api/monitors/:id', () => {
  test('returns 200 with monitor row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [monitorRow] });

    const res = await request(server).get('/api/monitors/1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  test('returns 404 for unknown monitor', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(server).get('/api/monitors/999');

    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).get('/api/monitors/abc');
    expect(res.status).toBe(400);
  });
});

// ── POST /api/monitors ────────────────────────────────────────────────────────

describe('POST /api/monitors', () => {
  test('creates monitor and returns 201', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...monitorRow, id: 2 }] });

    const res = await request(server)
      .post('/api/monitors')
      .send({ name: 'My API', url: 'https://api.example.com' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Google'); // from mock
  });

  test('returns 400 when name is missing', async () => {
    const res = await request(server)
      .post('/api/monitors')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('returns 400 when url is missing', async () => {
    const res = await request(server)
      .post('/api/monitors')
      .send({ name: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });
});

// ── DELETE /api/monitors/:id ──────────────────────────────────────────────────

describe('DELETE /api/monitors/:id', () => {
  test('returns 200 on soft delete', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(server).delete('/api/monitors/1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('returns 404 when monitor not found', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(server).delete('/api/monitors/999');

    expect(res.status).toBe(404);
  });
});

// ── GET /api/monitors/:id/history ─────────────────────────────────────────────

describe('GET /api/monitors/:id/history', () => {
  test('returns array of checks', async () => {
    const checkRows = [
      { id: 1, monitor_id: 1, status: 'up', latency_ms: 120, checked_at: new Date() },
    ];
    pool.query.mockResolvedValueOnce({ rows: checkRows });

    const res = await request(server).get('/api/monitors/1/history');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

// ── GET /api/monitors/:id/stats ───────────────────────────────────────────────

describe('GET /api/monitors/:id/stats', () => {
  test('returns stats object', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [
        { status: 'up', latency_ms: 100, checked_at: new Date() },
        { status: 'up', latency_ms: 200, checked_at: new Date() },
        { status: 'down', latency_ms: 0, checked_at: new Date() },
      ]})
      .mockResolvedValueOnce({ rows: [] }); // incidents

    const res = await request(server).get('/api/monitors/1/stats?days=30');

    expect(res.status).toBe(200);
    expect(res.body.monitor_id).toBe(1);
    expect(res.body.period_days).toBe(30);
    expect(typeof res.body.uptime_pct).toBe('number');
  });
});

// ── GET /api/stats ─────────────────────────────────────────────────────────────

describe('GET /api/stats', () => {
  test('returns aggregate stats', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ total: 3, up: 2, down: 1, avg_latency: 150 }],
    });

    const res = await request(server).get('/api/stats');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.up).toBe(2);
    expect(res.body.down).toBe(1);
  });
});

// ── GET /api/incidents ────────────────────────────────────────────────────────

describe('GET /api/incidents', () => {
  test('returns open incidents array', async () => {
    const { getAllOpenIncidents } = require('../src/incidentManager');
    getAllOpenIncidents.mockResolvedValueOnce([{ id: 1, monitor_name: 'Google' }]);

    const res = await request(server).get('/api/incidents');

    expect(res.status).toBe(200);
    expect(res.body[0].monitor_name).toBe('Google');
  });
});

// ── POST /api/monitors/:id/maintenance ────────────────────────────────────────

describe('POST /api/monitors/:id/maintenance', () => {
  test('creates maintenance window and returns 201', async () => {
    const row = { id: 1, monitor_id: 1, starts_at: new Date(), ends_at: new Date(Date.now() + 3600000), reason: 'Deploy' };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const res = await request(server)
      .post('/api/monitors/1/maintenance')
      .send({
        starts_at: new Date().toISOString(),
        ends_at:   new Date(Date.now() + 3600000).toISOString(),
        reason:    'Deploy',
      });

    expect(res.status).toBe(201);
  });

  test('returns 400 when starts_at or ends_at is missing', async () => {
    const res = await request(server)
      .post('/api/monitors/1/maintenance')
      .send({ reason: 'Deploy' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when ends_at is before starts_at', async () => {
    const res = await request(server)
      .post('/api/monitors/1/maintenance')
      .send({
        starts_at: new Date(Date.now() + 3600000).toISOString(),
        ends_at:   new Date().toISOString(),
      });

    expect(res.status).toBe(400);
  });
});

// ── POST /api/incidents/:id/notes ─────────────────────────────────────────────

describe('POST /api/incidents/:id/notes', () => {
  test('adds note and returns 201', async () => {
    const { addNote } = require('../src/incidentManager');
    addNote.mockResolvedValueOnce({ id: 1, text: 'Investigating the issue' });

    const res = await request(server)
      .post('/api/incidents/1/notes')
      .send({ text: 'Investigating the issue' });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe('Investigating the issue');
  });

  test('returns 400 when text is empty', async () => {
    const res = await request(server)
      .post('/api/incidents/1/notes')
      .send({ text: '' });

    expect(res.status).toBe(400);
  });
});

// ── POST /api/keys ────────────────────────────────────────────────────────────

describe('POST /api/keys', () => {
  test('generates API key and returns 201 with plainKey', async () => {
    const res = await request(server)
      .post('/api/keys')
      .send({ name: 'My CI Key' });

    expect(res.status).toBe(201);
    expect(res.body.plainKey).toBe('maw_testkey');
    expect(res.body.note).toBeDefined();
  });

  test('returns 400 when name is missing', async () => {
    const res = await request(server)
      .post('/api/keys')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── GET /api/public/status ────────────────────────────────────────────────────

describe('GET /api/public/status', () => {
  test('returns public status object', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Google', url: 'https://google.com',
        tags: [], current_status: 'up', last_latency: 50, uptime_90d: '99.90' }] })
      .mockResolvedValueOnce({ rows: [] })  // open incidents
      .mockResolvedValueOnce({ rows: [] }); // recent incidents

    const res = await request(server).get('/api/public/status');

    expect(res.status).toBe(200);
    expect(res.body.overall_status).toBeDefined();
    expect(Array.isArray(res.body.monitors)).toBe(true);
    expect(Array.isArray(res.body.open_incidents)).toBe(true);
  });
});

// ── GET /api/monitors/:id ─────────────────────────────────────────────────────

describe('GET /api/monitors/:id', () => {
  test('returns 200 with monitor detail', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...monitorRow, ssl_valid_to: null, ssl_issuer: null }] });
    const res = await request(server).get('/api/monitors/1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.name).toBe('Google');
  });

  test('returns 404 for unknown monitor', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(server).get('/api/monitors/999');
    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).get('/api/monitors/abc');
    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/monitors/:id ───────────────────────────────────────────────────

describe('PATCH /api/monitors/:id', () => {
  test('updates monitor fields and returns 200', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...monitorRow, name: 'Updated' }] });
    const res = await request(server)
      .patch('/api/monitors/1')
      .send({ name: 'Updated', interval_seconds: 120 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });

  test('returns 400 when no valid fields are provided', async () => {
    const res = await request(server)
      .patch('/api/monitors/1')
      .send({ unknown_field: 'value' });
    expect(res.status).toBe(400);
  });

  test('returns 404 when monitor not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(server)
      .patch('/api/monitors/999')
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).patch('/api/monitors/abc').send({ name: 'x' });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/monitors/:id/maintenance ────────────────────────────────────────

describe('GET /api/monitors/:id/maintenance', () => {
  test('returns 200 with maintenance windows array', async () => {
    const window = { id: 1, monitor_id: 1, reason: 'Deploy', starts_at: new Date(), ends_at: new Date() };
    pool.query.mockResolvedValueOnce({ rows: [window] });
    const res = await request(server).get('/api/monitors/1/maintenance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].reason).toBe('Deploy');
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).get('/api/monitors/abc/maintenance');
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/maintenance/:id ───────────────────────────────────────────────

describe('DELETE /api/maintenance/:id', () => {
  test('deletes maintenance window and returns 200', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(server).delete('/api/maintenance/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('returns 404 when window not found', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(server).delete('/api/maintenance/999');
    expect(res.status).toBe(404);
  });
});

// ── GET /api/monitors/:id/incidents ──────────────────────────────────────────

describe('GET /api/monitors/:id/incidents', () => {
  test('returns 200 with incidents array', async () => {
    // uses getIncidents() from incidentManager (already mocked), not pool.query
    const { getIncidents } = require('../src/incidentManager');
    getIncidents.mockResolvedValueOnce([{ id: 1, monitor_id: 1, status: 'open', started_at: new Date() }]);
    const res = await request(server).get('/api/monitors/1/incidents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).get('/api/monitors/abc/incidents');
    expect(res.status).toBe(400);
  });
});

// ── GET /api/monitors/:id/webhooks ────────────────────────────────────────────

describe('GET /api/monitors/:id/webhooks', () => {
  test('returns 200 with webhooks array', async () => {
    const webhook = { id: 1, monitor_id: 1, url: 'https://hooks.example.com', format: 'generic', active: true };
    pool.query.mockResolvedValueOnce({ rows: [webhook] });
    const res = await request(server).get('/api/monitors/1/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].format).toBe('generic');
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).get('/api/monitors/abc/webhooks');
    expect(res.status).toBe(400);
  });
});

// ── POST /api/monitors/:id/webhooks ──────────────────────────────────────────

describe('POST /api/monitors/:id/webhooks', () => {
  test('creates webhook and returns 201', async () => {
    const row = { id: 5, name: 'Deploy hook', url: 'https://hooks.example.com', events: ['down'], format: 'slack', active: true };
    pool.query.mockResolvedValueOnce({ rows: [row] });
    const res = await request(server)
      .post('/api/monitors/1/webhooks')
      .send({ url: 'https://hooks.example.com', format: 'slack', events: ['down'] });
    expect(res.status).toBe(201);
    expect(res.body.format).toBe('slack');
  });

  test('returns 400 when url is missing', async () => {
    const res = await request(server).post('/api/monitors/1/webhooks').send({ format: 'slack' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid monitor id', async () => {
    const res = await request(server).post('/api/monitors/abc/webhooks').send({ url: 'https://x.com' });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/webhooks/:id ──────────────────────────────────────────────────

describe('DELETE /api/webhooks/:id', () => {
  test('deletes webhook and returns 200', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(server).delete('/api/webhooks/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('returns 404 when webhook not found', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(server).delete('/api/webhooks/999');
    expect(res.status).toBe(404);
  });
});

// ── GET /api/keys ─────────────────────────────────────────────────────────────

describe('GET /api/keys', () => {
  test('returns 200 with list of API keys', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'CI Key', revoked: false, created_at: new Date() }] });
    const res = await request(server).get('/api/keys');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].name).toBe('CI Key');
  });

  test('returns 500 on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB error'));
    const res = await request(server).get('/api/keys');
    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/keys/:id ──────────────────────────────────────────────────────

describe('DELETE /api/keys/:id', () => {
  test('revokes key and returns 200', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(server).delete('/api/keys/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('returns 404 when key not found', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(server).delete('/api/keys/999');
    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).delete('/api/keys/abc');
    expect(res.status).toBe(400);
  });
});

// ── GET /api/monitors/:id/history/export ─────────────────────────────────────

describe('GET /api/monitors/:id/history/export', () => {
  test('returns CSV file with correct headers', async () => {
    const rows = [
      { id: 1, status: 'up', status_code: 200, latency_ms: 100, assertion_passed: true, error_message: null, checked_at: new Date() },
    ];
    pool.query.mockResolvedValueOnce({ rows });
    const res = await request(server).get('/api/monitors/1/history/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toMatch(/id,status,status_code/);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(server).get('/api/monitors/abc/history/export');
    expect(res.status).toBe(400);
  });
});

// ── GET /api/public/monitors/:id/uptime ──────────────────────────────────────

describe('GET /api/public/monitors/:id/uptime', () => {
  test('returns 200 with uptime bars array', async () => {
    // endpoint makes a single query — no monitor existence check
    const rows = [{ day: '2026-04-01', checks_count: 100, uptime_pct: '99.0' }];
    pool.query.mockResolvedValueOnce({ rows });
    const res = await request(server).get('/api/public/monitors/1/uptime?days=7');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('returns empty array when monitor has no checks', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(server).get('/api/public/monitors/999/uptime');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── GET /api/monitors/:id/badge.svg ──────────────────────────────────────────

describe('GET /api/monitors/:id/badge.svg', () => {
  test('returns SVG content with correct content-type', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ name: 'Google', status: 'up' }] });

    const res = await request(server).get('/api/monitors/1/badge.svg').buffer(true);
    const body = res.text || (res.body instanceof Buffer ? res.body.toString() : String(res.body));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    expect(body).toMatch(/<svg/);
    expect(body).toMatch(/UP/);
  });

  test('returns 404 for unknown/private monitor', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(server).get('/api/monitors/999/badge.svg');

    expect(res.status).toBe(404);
  });
});
