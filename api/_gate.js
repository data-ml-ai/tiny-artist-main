'use strict';

/* Tiny Artist — shared gate-token helpers for the admin server functions.
 *
 * A gate token proves the caller entered the access code. It is an
 * HMAC-SHA256-signed, base64url-encoded JSON payload:
 *   token = b64url('{"exp":<ms epoch>,"nonce":"<hex>"}') + "." +
 *           b64url(HMAC-SHA256(secret, body))
 * The token grants no Supabase access by itself: /api/admin verifies it
 * before using the service-role key, and /api/verify-code is the only
 * function that issues one. Signature comparison is timing-safe.
 *
 * Files in api/ whose names start with "_" are not routed as functions
 * by Vercel; they are shared helpers required by the real functions.
 */

const crypto = require('crypto');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function issueToken(secret, ttlMs) {
  const payload = JSON.stringify({
    exp: Date.now() + ttlMs,
    nonce: crypto.randomBytes(12).toString('hex'),
  });
  const body = b64urlEncode(payload);
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

function verifyToken(secret, token) {
  try {
    if (!secret || typeof token !== 'string') return { ok: false, reason: 'invalid' };
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid' };
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
    const provided = b64urlDecode(parts[1]);
    if (provided.length !== expected.length) return { ok: false, reason: 'invalid' };
    if (!crypto.timingSafeEqual(provided, expected)) return { ok: false, reason: 'invalid' };
    const payload = JSON.parse(b64urlDecode(parts[0]).toString('utf-8'));
    if (!payload || typeof payload.exp !== 'number' || typeof payload.nonce !== 'string' || !payload.nonce) {
      return { ok: false, reason: 'invalid' };
    }
    if (Date.now() >= payload.exp) return { ok: false, reason: 'expired' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
}

module.exports = { issueToken, verifyToken };
