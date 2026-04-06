/**
 * tests/retention.test.js — Unit tests for src/retention.js
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

jest.mock('../src/db');

const { pool } = require('../src/db');
const { cleanupChecks, cleanupAlerts, cleanupIncidents, runRetention } = require('../src/retention');

beforeEach(() => jest.clearAllMocks());

describe('cleanupChecks', () => {
  test('executes DELETE query with correct retention period', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 150 });

    const count = await cleanupChecks(90);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM checks'),
      [90]
    );
    expect(count).toBe(150);
  });

  test('uses default 90 days when no argument given', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    await cleanupChecks();

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [90]);
  });
});

describe('cleanupAlerts', () => {
  test('executes DELETE query on alerts table', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 20 });

    const count = await cleanupAlerts(180);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM alerts'),
      [180]
    );
    expect(count).toBe(20);
  });
});

describe('cleanupIncidents', () => {
  test('only deletes resolved incidents', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 5 });

    const count = await cleanupIncidents(365);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'resolved'"),
      [365]
    );
    expect(count).toBe(5);
  });
});

describe('runRetention', () => {
  test('runs all three cleanup functions and returns summary', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 100 }) // checks
      .mockResolvedValueOnce({ rowCount: 30 })  // alerts
      .mockResolvedValueOnce({ rowCount: 5 });  // incidents

    const result = await runRetention();

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ checks: 100, alerts: 30, incidents: 5 });
  });

  test('continues even if one cleanup fails', async () => {
    pool.query
      .mockRejectedValueOnce(new Error('lock timeout')) // checks fails
      .mockResolvedValueOnce({ rowCount: 30 })          // alerts ok
      .mockResolvedValueOnce({ rowCount: 5 });          // incidents ok

    const result = await runRetention();

    expect(result.checks).toBe(0);
    expect(result.alerts).toBe(30);
    expect(result.incidents).toBe(5);
  });
});
