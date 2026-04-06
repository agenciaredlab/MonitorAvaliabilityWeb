/**
 * auth.js — API key authentication middleware
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

/**
 * Generates a new random API key and stores its hash in the database.
 *
 * @param {string} name  Human-readable label for this key
 * @returns {Promise<{ plainKey: string, id: number }>}
 *   plainKey is returned ONCE and never stored in plain text.
 */
async function generateApiKey(name) {
  const plainKey = 'maw_' + crypto.randomBytes(32).toString('hex');
  const keyHash  = crypto.createHash('sha256').update(plainKey).digest('hex');

  const { rows } = await pool.query(`
    INSERT INTO api_keys (key_hash, name, created_at)
    VALUES ($1, $2, NOW())
    RETURNING id, name, created_at
  `, [keyHash, name]);

  return { plainKey, ...rows[0] };
}

/**
 * Validates an API key by hashing and looking up in the database.
 * Updates last_used_at on success.
 *
 * @param {string} plainKey
 * @returns {Promise<object|null>} The api_key row, or null if invalid/revoked
 */
async function validateApiKey(plainKey) {
  if (!plainKey || typeof plainKey !== 'string') return null;

  const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');

  const { rows } = await pool.query(`
    SELECT id, name, last_used_at, created_at
    FROM api_keys
    WHERE key_hash = $1 AND revoked = FALSE
  `, [keyHash]);

  if (rows.length === 0) return null;

  // Update last_used_at async (fire and forget)
  pool.query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
    [rows[0].id]
  ).catch(() => {});

  return rows[0];
}

/**
 * Express middleware — enforces API key authentication when
 * the REQUIRE_API_KEY env var is set to 'true'.
 *
 * Clients pass the key as:
 *   Authorization: Bearer maw_<key>
 * or:
 *   X-Api-Key: maw_<key>
 *
 * Public routes (GET /api/public/* and GET /status*) are always allowed through.
 */
async function authMiddleware(req, res, next) {
  // Skip if auth is not enforced
  if (process.env.REQUIRE_API_KEY !== 'true') return next();

  // Always allow public endpoints and static files
  const publicPrefixes = ['/api/public', '/status', '/'];
  if (publicPrefixes.some(p => req.path === p || req.path.startsWith(p + '/'))) {
    if (req.path === '/' || req.path.startsWith('/static') ||
        req.path === '/status' || req.path.startsWith('/api/public')) {
      return next();
    }
  }

  // Extract key from Authorization header or X-Api-Key
  let plainKey = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    plainKey = authHeader.slice(7).trim();
  } else if (req.headers['x-api-key']) {
    plainKey = req.headers['x-api-key'].trim();
  }

  if (!plainKey) {
    return res.status(401).json({ error: 'Authentication required. Provide Authorization: Bearer <key> header.' });
  }

  try {
    const keyRecord = await validateApiKey(plainKey);
    if (!keyRecord) {
      return res.status(403).json({ error: 'Invalid or revoked API key.' });
    }
    req.apiKey = keyRecord;
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [AUTH] Error validating key: ${err.message}`);
    res.status(500).json({ error: 'Authentication error' });
  }
}

module.exports = { generateApiKey, validateApiKey, authMiddleware };
