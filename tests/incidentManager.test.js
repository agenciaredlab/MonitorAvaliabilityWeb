/**
 * tests/incidentManager.test.js — Unit tests for src/incidentManager.js
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');

const { pool } = require('../src/db');
const {
  createIncident, resolveIncident, getOpenIncident,
  getIncidents, getAllOpenIncidents, addNote,
} = require('../src/incidentManager');

beforeEach(() => jest.clearAllMocks());

describe('createIncident', () => {
  test('inserts a new incident and returns the row', async () => {
    const row = { id: 1, monitor_id: 5, status: 'open', started_at: new Date(), auto_created: true };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await createIncident(5);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incidents'),
      [5, true]
    );
    expect(result).toEqual(row);
  });
});

describe('resolveIncident', () => {
  test('updates incident status to resolved and returns row', async () => {
    const row = { id: 1, status: 'resolved', duration_seconds: 300 };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await resolveIncident(5);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status           = 'resolved'"),
      [5]
    );
    expect(result.status).toBe('resolved');
    expect(result.duration_seconds).toBe(300);
  });

  test('returns null when no open incident found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await resolveIncident(5);

    expect(result).toBeNull();
  });
});

describe('getOpenIncident', () => {
  test('returns the open incident row', async () => {
    const row = { id: 3, monitor_id: 5, status: 'open' };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await getOpenIncident(5);

    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'open'"),
      [5]
    );
  });

  test('returns null when no open incident', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getOpenIncident(5);

    expect(result).toBeNull();
  });
});

describe('getIncidents', () => {
  test('returns list of incidents for a monitor', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    pool.query.mockResolvedValueOnce({ rows });

    const result = await getIncidents(5, 10);

    expect(result).toEqual(rows);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [5, 10]);
  });
});

describe('getAllOpenIncidents', () => {
  test('returns all open incidents across monitors', async () => {
    const rows = [{ id: 1, monitor_name: 'A' }, { id: 2, monitor_name: 'B' }];
    pool.query.mockResolvedValueOnce({ rows });

    const result = await getAllOpenIncidents();

    expect(result).toEqual(rows);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'open'")
    );
  });
});

describe('addNote', () => {
  test('inserts a note and returns the row', async () => {
    const row = { id: 10, incident_id: 1, text: 'Investigating', created_at: new Date() };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await addNote(1, 'Investigating');

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incident_updates'),
      [1, 'Investigating']
    );
    expect(result).toEqual(row);
  });
});
