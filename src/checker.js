/**
 * checker.js — URL health checker with assertions, SSL and custom methods
 * MonitorAvaliabilityWeb — Uptime Monitoring System
 *
 * Created by Agencia Redlab
 * Developed by Juan Camilo Medina Godoy
 */

'use strict';

const axios = require('axios');
const { pool } = require('./db');

// ── Assertion evaluation ─────────────────────────────────────────────────────

/**
 * Parses the expected_status_codes string and returns true if statusCode matches.
 * Supports ranges like "200-399", exact codes "200,201,204", or mixed.
 *
 * @param {string} expected  e.g. "200-399" or "200,201,204" or "200-299,404"
 * @param {number} code
 * @returns {boolean}
 */
function statusCodeMatches(expected, code) {
  if (!expected || code == null) return false;
  const segments = String(expected).split(',').map(s => s.trim());
  for (const seg of segments) {
    if (seg.includes('-')) {
      const [lo, hi] = seg.split('-').map(Number);
      if (code >= lo && code <= hi) return true;
    } else {
      if (code === parseInt(seg, 10)) return true;
    }
  }
  return false;
}

/**
 * Evaluates a response body assertion.
 *
 * @param {string} type    'contains_text' | 'not_contains_text' | 'regex' | 'json_path'
 * @param {string} value   The expected value / pattern
 * @param {string} body    Response body as string
 * @returns {{ passed: boolean, message: string }}
 */
function evaluateAssertion(type, value, body) {
  if (!type || !value) return { passed: true, message: null };

  try {
    switch (type) {
      case 'contains_text':
        return body.includes(value)
          ? { passed: true, message: null }
          : { passed: false, message: `Response does not contain "${value}"` };

      case 'not_contains_text':
        return !body.includes(value)
          ? { passed: true, message: null }
          : { passed: false, message: `Response unexpectedly contains "${value}"` };

      case 'regex': {
        const re = new RegExp(value);
        return re.test(body)
          ? { passed: true, message: null }
          : { passed: false, message: `Response does not match regex /${value}/` };
      }

      case 'json_path': {
        // Format: "path==expected"  e.g. "status==ok" or "data.count>0"
        const [pathPart, ...rest] = value.split(/([=!><]{1,2})/);
        if (rest.length < 2) {
          return { passed: false, message: `Invalid json_path assertion format: "${value}"` };
        }
        const operator = rest[0];
        const expected = rest.slice(1).join('');
        let parsed;
        try { parsed = JSON.parse(body); } catch (_) {
          return { passed: false, message: 'Response is not valid JSON' };
        }
        // Traverse the path
        const actual = pathPart.trim().split('.').reduce((obj, key) => {
          return obj != null ? obj[key] : undefined;
        }, parsed);
        const actualStr = String(actual);
        switch (operator) {
          case '==': return actualStr === expected
            ? { passed: true, message: null }
            : { passed: false, message: `json_path: ${pathPart} == ${actual}, expected ${expected}` };
          case '!=': return actualStr !== expected
            ? { passed: true, message: null }
            : { passed: false, message: `json_path: ${pathPart} should not equal ${expected}` };
          case '>':  return Number(actual) >  Number(expected)
            ? { passed: true, message: null }
            : { passed: false, message: `json_path: ${pathPart} (${actual}) not > ${expected}` };
          case '<':  return Number(actual) <  Number(expected)
            ? { passed: true, message: null }
            : { passed: false, message: `json_path: ${pathPart} (${actual}) not < ${expected}` };
          case '>=': return Number(actual) >= Number(expected)
            ? { passed: true, message: null }
            : { passed: false, message: `json_path: ${pathPart} (${actual}) not >= ${expected}` };
          case '<=': return Number(actual) <= Number(expected)
            ? { passed: true, message: null }
            : { passed: false, message: `json_path: ${pathPart} (${actual}) not <= ${expected}` };
          default:
            return { passed: false, message: `Unknown json_path operator: ${operator}` };
        }
      }

      default:
        return { passed: false, message: `Unknown assertion type: ${type}` };
    }
  } catch (err) {
    return { passed: false, message: `Assertion error: ${err.message}` };
  }
}

// ── Main check function ───────────────────────────────────────────────────────

/**
 * Performs an HTTP check on the given monitor, evaluates assertions,
 * persists the result and returns a result object.
 *
 * @param {object} monitor  Row from the monitors table
 * @returns {Promise<{monitor, status, statusCode, latency, assertionPassed, errorMessage}>}
 */
async function checkUrl(monitor) {
  let status = 'down';
  let statusCode = null;
  let latency = 0;
  let assertionPassed = null;
  let errorMessage = null;

  const start = Date.now();

  try {
    // Build request config
    const config = {
      method:         (monitor.method || 'GET').toUpperCase(),
      url:            monitor.url,
      timeout:        monitor.timeout_ms || 10000,
      validateStatus: () => true,
      maxRedirects:   5,
      headers: {
        'User-Agent': 'MonitorAvaliabilityWeb/1.0 (Agencia Redlab)',
        ...(monitor.request_headers || {}),
      },
    };

    if (monitor.request_body && ['POST', 'PUT', 'PATCH'].includes(config.method)) {
      config.data = monitor.request_body;
    }

    // Execute request — capture full response body for assertions
    const response = await axios({ ...config, responseType: 'text' });

    latency = Date.now() - start;
    statusCode = response.status;

    // Evaluate status code
    const expectedCodes = monitor.expected_status_codes || '200-399';
    const codeOk = statusCodeMatches(expectedCodes, statusCode);

    // Evaluate body assertion
    if (monitor.assertion_type && monitor.assertion_value) {
      const result = evaluateAssertion(
        monitor.assertion_type,
        monitor.assertion_value,
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      );
      assertionPassed = result.passed;
      if (!result.passed) errorMessage = result.message;
    }

    // Monitor is UP only if status code AND assertion both pass
    status = (codeOk && (assertionPassed === null || assertionPassed)) ? 'up' : 'down';

    if (!codeOk) {
      errorMessage = `Unexpected status code: ${statusCode} (expected ${expectedCodes})`;
    }

  } catch (err) {
    latency = Date.now() - start;
    status = 'down';
    errorMessage = err.message;
    console.error(
      `[${new Date().toISOString()}] [CHECKER] Error checking "${monitor.name}": ${err.message}`
    );
  }

  // Persist check result
  try {
    await pool.query(
      `INSERT INTO checks (monitor_id, status, status_code, latency_ms, assertion_passed, error_message, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [monitor.id, status, statusCode, latency, assertionPassed, errorMessage]
    );
  } catch (dbErr) {
    console.error(
      `[${new Date().toISOString()}] [CHECKER] Failed to save check for monitor ${monitor.id}: ${dbErr.message}`
    );
  }

  // Update next_check_at for per-monitor interval scheduling
  try {
    await pool.query(
      `UPDATE monitors SET next_check_at = NOW() + ($1 || ' seconds')::INTERVAL WHERE id = $2`,
      [monitor.interval_seconds || 60, monitor.id]
    );
  } catch (_) { /* non-critical */ }

  return { monitor, status, statusCode, latency, assertionPassed, errorMessage };
}

/**
 * Fetches all active monitors whose next_check_at is due and runs checkUrl in parallel.
 *
 * @returns {Promise<Array>}
 */
async function checkAll() {
  let monitors = [];
  try {
    const { rows } = await pool.query(`
      SELECT id, name, url, method, interval_seconds, timeout_ms,
             expected_status_codes, assertion_type, assertion_value,
             sla_latency_ms, check_ssl, tags, request_headers, request_body
      FROM monitors
      WHERE active = TRUE
        AND next_check_at <= NOW()
      ORDER BY id
    `);
    monitors = rows;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [CHECKER] Failed to fetch monitors: ${err.message}`);
    return [];
  }

  if (monitors.length === 0) return [];

  const results = await Promise.all(monitors.map((m) => checkUrl(m)));
  return results;
}

module.exports = { checkUrl, checkAll, evaluateAssertion, statusCodeMatches };
