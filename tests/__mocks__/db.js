/**
 * tests/__mocks__/db.js — Mock del pool de PostgreSQL para tests unitarios
 * MonitorAvaliabilityWeb
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */
'use strict';

const pool = {
  query:   jest.fn(),
  connect: jest.fn(),
  end:     jest.fn(),
  on:      jest.fn(),
};

const initDB = jest.fn().mockResolvedValue(undefined);

module.exports = { pool, initDB };
