'use strict';

/* Tiny Artist — admin access-code gate (Vercel Serverless Function).
 *
 * POST /api/verify-code  { "code": "..." }  ->  { ok, token?, ... }
 *
 * The access code lives ONLY in the ADMIN_ACCESS_CODE environment variable
 * (Vercel project settings). It never appears in frontend code, in this
 * file, or in the repository. The frontend never decides access: this
 * function verifies the code server-side, and real authorisation still
 * requires Supabase Auth + the server-side is_admin() allowlist.
 *
 * Rate limiting: 5 failures in 15 minutes locks the caller out with
 * HTTP 429. When SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
 * failed attempts are recorded in the access_attempts table
 * (SHA-256/HMAC hash of the caller IP, never the raw IP), so the lockout
 * is shared across all function instances and visible in the panel's
 * audit section. Without those variables the gate still works, but the
 * lockout is a per-instance in-memory counter only — weaker on
 * serverless, where each instance counts separately. The service key
 * is therefore recommended, but no longer required for the gate to run.
 *
 * On success the function returns a short-lived HMAC-signed gate
 * token (see api/_gate.js). The token is the panel's only credential:
 * the code-only admin panel sends it with every /api/admin request,
 * and the server checks it before using the service-role key. It
 * grants no data access by itself and expires after 12 hours.
 *
 * Required env vars (Vercel project settings > Environment Variables):
 *   ADMIN_ACCESS_CODE        the access code (strong secret, changed from
 *                            the initial setup code before production)
 * Recommended (shared lockout logging + audit; the gate works without
 * them, with per-instance in-memory lockout only):
 *   SUPABASE_URL             e.g. https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  server-only key (never in frontend code)
 * Optional:
 *   GATE_TOKEN_SECRET        HMAC secret for gate tokens (recommended;
 *                            falls back to ADMIN_ACCESS_CODE if unset)
 */

const crypto = require('crypto');
const gate = require('./_gate');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // admin session length (code-only panel)

/* Best-effort in-memory fallback when Supabase cannot be reached. */
const memoryFailures = new Map(); // ipHash -> [timestamps]

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function sbRequest(url, key, path, options) {
  const r = await fetch(url + path, Object.assign({
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
  }, options || {}));
  return r;
}

async function countRecentFailures(sbUrl, sbKey, ipHash) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const qs = '/rest/v1/access_attempts?select=id&ip_hash=eq.' + encodeURIComponent(ipHash)
    + '&success=eq.false&created_at=gte.' + encodeURIComponent(since);
  const r = await sbRequest(sbUrl, sbKey, qs, { method: 'GET', headers: {
    apikey: sbKey, Authorization: 'Bearer ' + sbKey,
    Prefer: 'count=exact', Range: '0-0',
  } });
  if (!r.ok) throw new Error('attempts lookup failed: ' + r.status);
  const range = r.headers.get('content-range') || '';
  const m = /\/(\d+)$/.exec(range);
  if (m) return parseInt(m[1], 10);
  const rows = await r.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function logAttempt(sbUrl, sbKey, ipHash, success) {
  const r = await sbRequest(sbUrl, sbKey, '/rest/v1/access_attempts', {
    method: 'POST',
    body: JSON.stringify({ ip_hash: ipHash, success: success }),
  });
  if (!r.ok) throw new Error('attempt log failed: ' + r.status);
}

function memoryCount(ipHash) {
  const now = Date.now();
  const list = (memoryFailures.get(ipHash) || []).filter(function (t) { return now - t < WINDOW_MS; });
  memoryFailures.set(ipHash, list);
  return list.length;
}

function memoryLog(ipHash) {
  const list = memoryFailures.get(ipHash) || [];
  list.push(Date.now());
  memoryFailures.set(ipHash, list);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const code = process.env.ADMIN_ACCESS_CODE;
  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.GATE_TOKEN_SECRET || code;

  if (!code) {
    return json(res, 503, { ok: false, error: 'not_configured' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return json(res, 400, { ok: false, error: 'bad_request' });
  }
  const submitted = typeof body.code === 'string' ? body.code : '';
  if (!submitted || submitted.length > 128) {
    return json(res, 400, { ok: false, error: 'bad_request' });
  }

  const ipHash = hmacHex(secret, clientIp(req));

  /* Rate limit check: shared Supabase log when the service key is set,
     per-instance in-memory counter otherwise (and as fallback). */
  let failures = 0;
  let sbUsable = Boolean(sbUrl && sbKey);
  if (sbUsable) {
    try {
      failures = await countRecentFailures(sbUrl, sbKey, ipHash);
    } catch (e) {
      sbUsable = false;
      failures = memoryCount(ipHash);
    }
  } else {
    failures = memoryCount(ipHash);
  }
  if (failures >= MAX_FAILURES) {
    return json(res, 429, { ok: false, error: 'locked_out', retry_after_seconds: 900 });
  }

  if (safeEqual(submitted, code)) {
    try { if (sbUsable) await logAttempt(sbUrl, sbKey, ipHash, true); } catch (e) { /* best effort */ }
    return json(res, 200, {
      ok: true,
      token: gate.issueToken(secret, TOKEN_TTL_MS),
      expires_in_seconds: Math.floor(TOKEN_TTL_MS / 1000),
      weak_code: code.length < 8,
    });
  }

  /* Failure: record it, then report remaining attempts (never the code). */
  try {
    if (sbUsable) await logAttempt(sbUrl, sbKey, ipHash, false);
    else memoryLog(ipHash);
  } catch (e) { memoryLog(ipHash); }
  return json(res, 401, {
    ok: false,
    error: 'wrong_code',
    remaining_attempts: Math.max(0, MAX_FAILURES - failures - 1),
  });
};
