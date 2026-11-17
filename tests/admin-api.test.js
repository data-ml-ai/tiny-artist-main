// Tiny Artist — functional admin API checks. Run: node tests/admin-api.test.js
// Runs the real /api/admin handler with a stubbed fetch (no network, no
// real Supabase): token verification, action whitelist, input validation,
// service-key use upstream, audit writes, storage upload rules, and the
// gate-token interop with /api/verify-code. Dummy secrets only.
'use strict';

process.env.SUPABASE_URL = 'https://dummy-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
process.env.ADMIN_ACCESS_CODE = 'dummy-test-code-123';
process.env.GATE_TOKEN_SECRET = 'dummy-gate-secret-456';

const gate = require('../api/_gate.js');
const adminHandler = require('../api/admin.js');
const verifyHandler = require('../api/verify-code.js');

let pass = 0, fail = 0;
function A(name, ok, extra) {
  if (ok) { pass++; } else { fail++; console.error('FAIL: ' + name, extra || ''); }
}

/* ---- stubbed fetch: records upstream calls, returns canned rows ---- */
const calls = [];
function upstreamResponse(url, opts) {
  const u = String(url);
  if (u.includes('/rest/v1/orders?select=status,admin_notes')) {
    return [{ status: 'Pending Confirmation', admin_notes: '' }];
  }
  if (u.includes('/rest/v1/orders?select=*&id=eq.')) {
    return [{ id: 'ord-1', order_code: 'TA-ABC', status: 'Pending Confirmation' }];
  }
  if (u.includes('/rest/v1/products?select=slug,is_available') || u.includes('/rest/v1/products?select=slug,stock_quantity')) {
    return [{ slug: 'rocket', is_available: true, stock_quantity: 3 }];
  }
  if (u.includes('/rest/v1/products?select=slug,name,price_pkr,stock_quantity,is_available')) {
    return [{ slug: 'rocket', name: 'Rocket', price_pkr: 70, stock_quantity: 3, is_available: true }];
  }
  if (u.includes('/rest/v1/products?select=slug,name') || u.includes('/rest/v1/products?select=id&id=eq.')) {
    return [{ slug: 'rocket', name: 'Rocket', id: 'prod-1' }];
  }
  if (u.includes('/rest/v1/site_settings?select=*&id=eq.1')) {
    return [{ id: 1, deactivated: false, reason: '', deactivated_by: null, deactivated_at: null }];
  }
  if (u.includes('/rest/v1/product_images?select=storage_path')) {
    return [{ storage_path: 'prod-1/123.webp' }];
  }
  if (u.includes('/rest/v1/products') && (opts.method === 'POST' || opts.method === 'PATCH')
      && opts.headers && opts.headers.Prefer === 'return=representation') {
    return [{ id: 'prod-9', slug: 'new-thing' }];
  }
  return [];
}
global.fetch = async function (url, opts) {
  opts = opts || {};
  calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  const data = upstreamResponse(url, opts);
  return {
    ok: true, status: 200,
    text: async function () { return JSON.stringify(data); },
    headers: { get: function () { return null; } },
  };
};

function callAdmin(body, token) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      headers: { authorization: token ? 'Bearer ' + token : '', 'content-type': 'application/json' },
      body: body,
    };
    const res = {
      statusCode: 0,
      setHeader: function () {},
      end: function (b) { let d = null; try { d = JSON.parse(b); } catch (e) {} resolve({ status: this.statusCode, body: d }); },
    };
    adminHandler(req, res);
  });
}

function callVerify(code) {
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9' }, socket: {}, body: { code: code } };
    const res = {
      statusCode: 0,
      setHeader: function () {},
      end: function (b) { let d = null; try { d = JSON.parse(b); } catch (e) {} resolve({ status: this.statusCode, body: d }); },
    };
    verifyHandler(req, res);
  });
}

(async () => {
  const secret = process.env.GATE_TOKEN_SECRET;
  const goodToken = gate.issueToken(secret, 60 * 60 * 1000);
  const expiredToken = gate.issueToken(secret, -1000);

  // 1. Auth: missing / bad / expired tokens are refused before any DB call.
  calls.length = 0;
  let r = await callAdmin({ action: 'probe' }, null);
  A('no token returns 401', r.status === 401 && r.body.error === 'unauthorized', JSON.stringify(r));
  r = await callAdmin({ action: 'probe' }, 'garbage.token');
  A('bad token returns 401', r.status === 401, JSON.stringify(r));
  r = await callAdmin({ action: 'probe' }, expiredToken);
  A('expired token returns 401', r.status === 401, JSON.stringify(r));
  A('no upstream call happens without a valid token', calls.length === 0, JSON.stringify(calls));

  // 2. Probe works with a valid token and hands back the storage base.
  r = await callAdmin({ action: 'probe' }, goodToken);
  A('probe returns storage base', r.status === 200 && r.body.storageBase === 'https://dummy-project.supabase.co', JSON.stringify(r));
  A('upstream calls carry the service key', calls.length > 0 && calls.every(function (c) {
    return c.headers.Authorization === 'Bearer dummy-service-key' && c.headers.apikey === 'dummy-service-key';
  }), JSON.stringify(calls.map(function (c) { return c.headers; })));

  // 3. Unknown actions and bad methods are rejected.
  r = await callAdmin({ action: 'drop_tables' }, goodToken);
  A('unknown action returns 400', r.status === 400 && r.body.error === 'unknown_action', JSON.stringify(r));
  r = await callAdmin({ action: 'orders_list', status: 'Shipped' }, goodToken);
  A('invalid order status is rejected', r.status === 400, JSON.stringify(r));

  // 4. Order update: validates, patches one row, writes an audit row.
  calls.length = 0;
  r = await callAdmin({ action: 'order_update', id: 'ord-1', status: 'Confirmed', admin_notes: 'ok' }, goodToken);
  A('order update succeeds', r.status === 200 && r.body.ok === true, JSON.stringify(r));
  const patch = calls.find(function (c) { return c.method === 'PATCH' && c.url.includes('/rest/v1/orders?id=eq.ord-1'); });
  A('order patch targets exactly one id', !!patch && JSON.parse(patch.body).status === 'Confirmed', JSON.stringify(calls));
  const auditCall = calls.find(function (c) { return c.url.includes('admin_audit_log'); });
  A('order update writes an audit row as access-code', !!auditCall && JSON.parse(auditCall.body).admin_email === 'access-code', JSON.stringify(calls));

  // 5. Product save validation: bad slug rejected, good save returns the row.
  r = await callAdmin({ action: 'product_save', name: 'X', slug: 'Bad Slug!', stock_quantity: 1, is_available: true, is_featured: false, is_kit: false }, goodToken);
  A('bad slug is rejected', r.status === 400, JSON.stringify(r));
  r = await callAdmin({ action: 'product_save', name: 'New Thing', slug: 'new-thing', stock_quantity: 5, is_available: true, is_featured: false, is_kit: false, contents: ['a'] }, goodToken);
  A('product create returns the saved row', r.status === 200 && r.body.id === 'prod-9', JSON.stringify(r));

  // 6. Stock adjust clamps through validation (negative rejected).
  r = await callAdmin({ action: 'stock_adjust', id: 'prod-1', stock_quantity: -2 }, goodToken);
  A('negative stock is rejected', r.status === 400, JSON.stringify(r));
  r = await callAdmin({ action: 'stock_adjust', id: 'prod-1', stock_quantity: 9 }, goodToken);
  A('stock adjust succeeds', r.status === 200 && r.body.stock_quantity === 9, JSON.stringify(r));

  // 7. Kill switch: direct row update with the right fields, never the RPC.
  calls.length = 0;
  r = await callAdmin({ action: 'site_set_deactivated', deactivated: true, reason: 'test' }, goodToken);
  A('deactivate succeeds', r.status === 200 && r.body.deactivated === true, JSON.stringify(r));
  const sitePatch = calls.find(function (c) { return c.method === 'PATCH' && c.url.includes('site_settings?id=eq.1'); });
  A('deactivate patches the settings row as access-code', !!sitePatch
    && JSON.parse(sitePatch.body).deactivated === true
    && JSON.parse(sitePatch.body).deactivated_by === 'access-code', JSON.stringify(calls));
  A('deactivate never calls the JWT-bound RPC', !calls.some(function (c) { return c.url.includes('set_site_deactivated'); }), JSON.stringify(calls));

  // 8. Image upload: type + size enforced, storage + row insert on success.
  const smallPng = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  r = await callAdmin({ action: 'product_image_upload', productId: 'prod-1', contentType: 'image/bmp', dataBase64: smallPng }, goodToken);
  A('unsupported image type is rejected', r.status === 400, JSON.stringify(r));
  const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  r = await callAdmin({ action: 'product_image_upload', productId: 'prod-1', contentType: 'image/png', dataBase64: big }, goodToken);
  A('oversized image is rejected', r.status === 400, JSON.stringify(r));
  calls.length = 0;
  r = await callAdmin({ action: 'product_image_upload', productId: 'prod-1', contentType: 'image/png', dataBase64: smallPng, altText: 'Rocket' }, goodToken);
  A('image upload returns a public URL', r.status === 200 && typeof r.body.publicUrl === 'string' && r.body.publicUrl.includes('/storage/v1/object/public/product-images/prod-1/'), JSON.stringify(r));
  A('image upload posts bytes to storage', calls.some(function (c) { return c.url.includes('/storage/v1/object/product-images/prod-1/') && Buffer.isBuffer(c.body); }), JSON.stringify(calls.map(function (c) { return c.url; })));

  // 9. Global search strips PostgREST metacharacters from the query.
  calls.length = 0;
  r = await callAdmin({ action: 'global_search', q: 'roc(ket),x' }, goodToken);
  A('global search succeeds', r.status === 200 && Array.isArray(r.body.products), JSON.stringify(r));
  A('search query is sanitised upstream', calls.length > 0 && calls.every(function (c) { return c.url.indexOf('roc(ket)') === -1; }), JSON.stringify(calls));

  // 10. Missing service key: the API refuses to run at all.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  r = await callAdmin({ action: 'probe' }, goodToken);
  A('no service key returns 503', r.status === 503 && r.body.error === 'not_configured', JSON.stringify(r));
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';

  // 11. Gate interop: a token issued by /api/verify-code opens /api/admin.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const v = await callVerify('dummy-test-code-123');
  A('verify-code issues a token', v.status === 200 && typeof v.body.token === 'string', JSON.stringify(v));
  process.env.SUPABASE_URL = 'https://dummy-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
  r = await callAdmin({ action: 'probe' }, v.body.token);
  A('verify-code token is accepted by the admin API', r.status === 200 && r.body.ok === true, JSON.stringify(r));

  console.log('\n' + pass + '/' + (pass + fail) + ' admin API checks passed');
  if (fail) { console.log('FAILED'); process.exit(1); }
  console.log('ALL ADMIN API CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
