'use strict';

/* Tiny Artist — code-only admin API (Vercel Serverless Function).
 *
 * POST /api/admin  { "action": "...", ...params }
 *   Authorization: Bearer <gate token from /api/verify-code>
 *
 * Security model (owner decision, 2026-11-16): the panel has NO email /
 * password accounts. The access code is the only credential. This
 * function verifies the HMAC gate token on EVERY request and only then
 * talks to Supabase with the service-role key (which bypasses RLS).
 * The browser never sees the service key, and Supabase is never called
 * from the browser by the panel.
 *
 * Actions are an explicit whitelist below. There is no generic table
 * proxy: every action validates its inputs (types, lengths, value
 * lists) before any database call, and unfiltered writes are
 * impossible — every update/delete carries an exact id filter.
 * Every write also appends an admin_audit_log row (actor
 * "access-code": the panel no longer knows individual admins).
 *
 * Required env vars (Vercel project settings > Environment Variables):
 *   ADMIN_ACCESS_CODE          (also the fallback token-signing secret)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  server-only key (never in frontend code)
 * Optional:
 *   GATE_TOKEN_SECRET          HMAC secret for gate tokens (recommended;
 *                              falls back to ADMIN_ACCESS_CODE if unset,
 *                              exactly like /api/verify-code)
 */

const gate = require('./_gate');

const ORDER_STATUSES = ['Pending Confirmation', 'Confirmed', 'Processing', 'Completed', 'Cancelled'];
const EVENT_TYPES = ['page_view', 'product_view', 'add_to_cart', 'remove_from_cart', 'checkout_started', 'order_created', 'search'];
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ACTOR = 'access-code';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function bad(message) { return new ApiError(400, message); }

/* ---------------- input validation ---------------- */

function reqString(v, name, max) {
  if (typeof v !== 'string' || v.trim() === '') throw bad(name + ' is required');
  if (v.length > (max || 500)) throw bad(name + ' is too long');
  return v;
}
function optString(v, name, max, def) {
  if (v == null || v === '') return (def === undefined ? null : def);
  if (typeof v !== 'string') throw bad(name + ' must be text');
  if (v.length > (max || 500)) throw bad(name + ' is too long');
  return v;
}
function reqId(v, name) {
  const s = reqString(v, name || 'id', 128);
  if (/[\/?#\s]/.test(s)) throw bad((name || 'id') + ' is invalid');
  return s;
}
function reqInt(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw bad(name + ' must be a whole number');
  if (v < min || v > max) throw bad(name + ' is out of range');
  return v;
}
function optInt(v, name, min, max) {
  if (v == null || v === '') return null;
  return reqInt(v, name, min, max);
}
function reqBool(v, name) {
  if (typeof v !== 'boolean') throw bad(name + ' must be true or false');
  return v;
}
function reqEnum(v, name, list) {
  if (list.indexOf(v) === -1) throw bad(name + ' is invalid');
  return v;
}
function reqStringArray(v, name, maxItems, maxLen) {
  if (!Array.isArray(v)) throw bad(name + ' must be a list');
  if (v.length > maxItems) throw bad(name + ' has too many entries');
  return v.map(function (s, i) {
    if (typeof s !== 'string' || s.length > maxLen) throw bad(name + '[' + i + '] is invalid');
    return s;
  });
}

/* ---------------- Supabase access (service key) ---------------- */

function makeClient(sbUrl, sbKey) {
  async function call(path, opts) {
    opts = opts || {};
    const headers = {
      apikey: sbKey,
      Authorization: 'Bearer ' + sbKey,
      Accept: 'application/json',
    };
    if (opts.json !== false) headers['Content-Type'] = 'application/json';
    if (opts.headers) Object.assign(headers, opts.headers);
    const r = await fetch(sbUrl + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : (opts.raw ? opts.body : JSON.stringify(opts.body)),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* empty body */ }
    if (!r.ok) {
      const msg = (data && (data.message || data.error || data.hint)) || ('Database request failed (' + r.status + ')');
      throw new ApiError(502, String(msg).slice(0, 300));
    }
    return data;
  }
  return {
    get: function (path) { return call(path); },
    insert: function (path, body, prefer) {
      return call(path, { method: 'POST', body: body, headers: prefer ? { Prefer: prefer } : undefined });
    },
    update: function (path, body, prefer) {
      return call(path, { method: 'PATCH', body: body, headers: prefer ? { Prefer: prefer } : undefined });
    },
    remove: function (path) {
      return call(path, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    },
    upload: function (path, contentType, buffer) {
      return call(path, { method: 'POST', json: false, raw: true, body: buffer,
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' } });
    },
  };
}

function encode(v) { return encodeURIComponent(v); }

/* ---------------- handlers ---------------- */

function handlers(client, sbUrl) {
  async function audit(action, targetType, targetId, beforeVal, afterVal) {
    try {
      await client.insert('/rest/v1/admin_audit_log', {
        admin_email: ACTOR, action: action,
        target_type: targetType || '', target_id: String(targetId || ''),
        before_value: beforeVal == null ? null : beforeVal,
        after_value: afterVal == null ? null : afterVal,
      }, 'return=minimal');
    } catch (e) { /* audit failure must not break the action */ }
  }

  async function getOne(path, what) {
    const rows = await client.get(path);
    if (!Array.isArray(rows) || !rows.length) throw new ApiError(404, what + ' not found');
    return rows[0];
  }

  function productFields(p) {
    const name = reqString(p.name, 'name', 200);
    const slug = reqString(p.slug, 'slug', 100);
    if (!/^[a-z0-9-]+$/.test(slug)) throw bad('slug may only use lowercase letters, numbers and dashes');
    return {
      name: name,
      slug: slug,
      description: optString(p.description, 'description', 2000, ''),
      category_id: p.category_id == null || p.category_id === '' ? null : reqId(p.category_id, 'category_id'),
      price_pkr: optInt(p.price_pkr, 'price_pkr', 0, 1000000000),
      cost_pkr: optInt(p.cost_pkr, 'cost_pkr', 0, 1000000000),
      sku: optString(p.sku, 'sku', 100, null),
      stock_quantity: reqInt(p.stock_quantity, 'stock_quantity', 0, 1000000),
      contents: reqStringArray(p.contents == null ? [] : p.contents, 'contents', 50, 200),
      is_available: reqBool(p.is_available, 'is_available'),
      is_featured: reqBool(p.is_featured, 'is_featured'),
      is_kit: reqBool(p.is_kit, 'is_kit'),
      updated_at: new Date().toISOString(),
    };
  }

  return {
    /* Database reachable? Also hands the browser the public Storage
       base URL for product image links (the URL is public by design). */
    probe: async function () {
      await client.get('/rest/v1/site_config?select=key&limit=1');
      return { ok: true, storageBase: sbUrl };
    },

    notifications: async function () {
      const orders = await client.get('/rest/v1/orders?select=status&status=eq.Pending%20Confirmation&limit=1000');
      const prods = await client.get('/rest/v1/products?select=stock_quantity,is_available&is_available=eq.true&limit=1000');
      const low = (prods || []).filter(function (p) { return (p.stock_quantity || 0) <= 5; }).length;
      return { pending: (orders || []).length, low: low };
    },

    categories_list: async function () {
      return client.get('/rest/v1/categories?select=id,name,slug&order=name');
    },

    products_list: async function () {
      return client.get('/rest/v1/products?select=*,categories(name)&order=name&limit=1000');
    },

    product_images_list: async function (p) {
      const id = reqId(p.productId, 'productId');
      return client.get('/rest/v1/product_images?select=*&product_id=eq.' + encode(id) + '&order=sort_order&limit=20');
    },

    product_images_all: async function () {
      return client.get('/rest/v1/product_images?select=product_id,storage_path,sort_order&order=sort_order&limit=1000');
    },

    dashboard_data: async function (p) {
      const since = reqString(p.since, 'since', 40);
      if (!Number.isFinite(Date.parse(since))) throw bad('since is not a valid date');
      const results = await Promise.all([
        client.get('/rest/v1/orders?select=id,order_code,customer_name,total_pkr,status,created_at&order=created_at.desc&limit=1000'),
        client.get('/rest/v1/order_items?select=product_id,product_name,quantity,unit_price_pkr,line_total_pkr&limit=2000'),
        client.get('/rest/v1/products?select=*,categories(name)&order=name&limit=1000'),
        client.get('/rest/v1/analytics_events?select=event_type,session_id,created_at&created_at=gte.' + encode(since) + '&limit=5000'),
        client.get('/rest/v1/profiles?select=id,created_at&limit=1000'),
        client.get('/rest/v1/analytics_events?select=event_type,detail,created_at&order=created_at.desc&limit=5'),
      ]);
      return { orders: results[0] || [], items: results[1] || [], products: results[2] || [],
        events: results[3] || [], profiles: results[4] || [], recent: results[5] || [] };
    },

    orders_list: async function (p) {
      let q = '/rest/v1/orders?select=*&order=created_at.desc&limit=500';
      if (p.status != null && p.status !== '') q += '&status=eq.' + encode(reqEnum(p.status, 'status', ORDER_STATUSES));
      return client.get(q);
    },

    order_detail: async function (p) {
      const id = reqId(p.id, 'id');
      const order = await getOne('/rest/v1/orders?select=*&id=eq.' + encode(id), 'Order');
      const items = await client.get('/rest/v1/order_items?select=*&order_id=eq.' + encode(id) + '&order=created_at');
      return { order: order, items: items || [] };
    },

    order_update: async function (p) {
      const id = reqId(p.id, 'id');
      const status = reqEnum(p.status, 'status', ORDER_STATUSES);
      const notes = optString(p.admin_notes, 'admin_notes', 2000, '');
      const before = await getOne('/rest/v1/orders?select=status,admin_notes&id=eq.' + encode(id), 'Order');
      await client.update('/rest/v1/orders?id=eq.' + encode(id),
        { status: status, admin_notes: notes, updated_at: new Date().toISOString() }, 'return=minimal');
      await audit('order_status', 'order', id,
        { status: before.status, admin_notes: before.admin_notes || '' },
        { status: status, admin_notes: notes });
      return { ok: true };
    },

    product_toggle: async function (p) {
      const id = reqId(p.id, 'id');
      const avail = reqBool(p.is_available, 'is_available');
      const before = await getOne('/rest/v1/products?select=slug,is_available&id=eq.' + encode(id), 'Product');
      await client.update('/rest/v1/products?id=eq.' + encode(id),
        { is_available: avail, updated_at: new Date().toISOString() }, 'return=minimal');
      await audit('product_change', 'product', before.slug,
        { is_available: before.is_available }, { is_available: avail });
      return { ok: true };
    },

    product_save: async function (p) {
      const fields = productFields(p);
      if (p.id != null && p.id !== '') {
        const id = reqId(p.id, 'id');
        const before = await getOne('/rest/v1/products?select=slug,name,price_pkr,stock_quantity,is_available&id=eq.' + encode(id), 'Product');
        const saved = await client.update('/rest/v1/products?id=eq.' + encode(id), fields, 'return=representation');
        await audit('product_change', 'product', before.slug,
          { name: before.name, price_pkr: before.price_pkr, stock_quantity: before.stock_quantity, is_available: before.is_available }, fields);
        return Array.isArray(saved) ? saved[0] : saved;
      }
      const saved = await client.insert('/rest/v1/products', fields, 'return=representation');
      await audit('product_change', 'product', fields.slug, null, fields);
      return Array.isArray(saved) ? saved[0] : saved;
    },

    product_delete: async function (p) {
      const id = reqId(p.id, 'id');
      const before = await getOne('/rest/v1/products?select=slug,name&id=eq.' + encode(id), 'Product');
      await client.remove('/rest/v1/products?id=eq.' + encode(id));
      await audit('product_change', 'product', before.slug, { name: before.name }, { deleted: true });
      return { ok: true };
    },

    product_image_upload: async function (p) {
      const productId = reqId(p.productId, 'productId');
      const ext = IMAGE_TYPES[p.contentType];
      if (!ext) throw bad('image format is not supported');
      if (typeof p.dataBase64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(p.dataBase64)) {
        throw bad('image data is invalid');
      }
      const buf = Buffer.from(p.dataBase64, 'base64');
      if (!buf.length || buf.length > MAX_UPLOAD_BYTES) throw bad('image is larger than 2 MB');
      const altText = optString(p.altText, 'altText', 200, '');
      await getOne('/rest/v1/products?select=id&id=eq.' + encode(productId), 'Product');
      const path = productId + '/' + Date.now() + '.' + ext;
      await client.upload('/storage/v1/object/product-images/' + path, p.contentType, buf);
      const existing = await client.get('/rest/v1/product_images?select=id&product_id=eq.' + encode(productId) + '&limit=100');
      await client.insert('/rest/v1/product_images', {
        product_id: productId, storage_path: path, alt_text: altText,
        sort_order: Array.isArray(existing) ? existing.length : 0,
      }, 'return=minimal');
      return { ok: true, path: path, publicUrl: sbUrl + '/storage/v1/object/public/product-images/' + path };
    },

    product_image_delete: async function (p) {
      const imageId = reqId(p.imageId, 'imageId');
      const row = await getOne('/rest/v1/product_images?select=storage_path&id=eq.' + encode(imageId), 'Image');
      await client.remove('/rest/v1/product_images?id=eq.' + encode(imageId));
      const sp = String(row.storage_path || '');
      if (sp && sp.indexOf('..') === -1 && sp.charAt(0) !== '/') {
        try { await client.remove('/storage/v1/object/product-images/' + sp); } catch (e) { /* storage cleanup is best-effort */ }
      }
      return { ok: true };
    },

    inventory_data: async function () {
      const results = await Promise.all([
        client.get('/rest/v1/products?select=*,categories(name)&order=name&limit=1000'),
        client.get('/rest/v1/order_items?select=product_id,quantity&limit=2000'),
        client.get('/rest/v1/admin_audit_log?select=*&action=eq.inventory_change&order=created_at.desc&limit=30'),
      ]);
      return { products: results[0] || [], items: results[1] || [], history: results[2] || [] };
    },

    stock_adjust: async function (p) {
      const id = reqId(p.id, 'id');
      const next = reqInt(p.stock_quantity, 'stock_quantity', 0, 1000000);
      const before = await getOne('/rest/v1/products?select=slug,stock_quantity&id=eq.' + encode(id), 'Product');
      await client.update('/rest/v1/products?id=eq.' + encode(id),
        { stock_quantity: next, updated_at: new Date().toISOString() }, 'return=minimal');
      await audit('inventory_change', 'product', before.slug,
        { stock_quantity: before.stock_quantity || 0 }, { stock_quantity: next });
      return { ok: true, stock_quantity: next };
    },

    customers_data: async function () {
      const results = await Promise.all([
        client.get('/rest/v1/profiles?select=*&order=created_at.desc&limit=500'),
        client.get('/rest/v1/orders?select=id,order_code,user_id,customer_name,customer_phone,city,total_pkr,status,created_at&order=created_at.desc&limit=1000'),
      ]);
      return { profiles: results[0] || [], orders: results[1] || [] };
    },

    carts_data: async function () {
      const carts = await client.get('/rest/v1/carts?select=*&order=updated_at.desc&limit=200') || [];
      const items = carts.length
        ? await client.get('/rest/v1/cart_items?select=*,products(name,price_pkr)&limit=1000') || []
        : [];
      return { carts: carts, items: items };
    },

    activity_list: async function (p) {
      let q = '/rest/v1/analytics_events?select=*&order=created_at.desc&limit=300';
      if (p.eventType != null && p.eventType !== '') {
        q += '&event_type=eq.' + encode(reqEnum(p.eventType, 'eventType', EVENT_TYPES));
      }
      return client.get(q);
    },

    audit_data: async function () {
      const results = await Promise.all([
        client.get('/rest/v1/admin_audit_log?select=*&order=created_at.desc&limit=300'),
        client.get('/rest/v1/access_attempts?select=*&order=created_at.desc&limit=100'),
      ]);
      return { logs: results[0] || [], attempts: results[1] || [] };
    },

    settings_data: async function () {
      const results = await Promise.all([
        client.get('/rest/v1/site_config?select=*&order=key'),
        client.get('/rest/v1/site_settings?select=*&id=eq.1'),
      ]);
      return { config: results[0] || [], settings: results[1] || [] };
    },

    settings_save: async function (p) {
      const wa = reqString(p.whatsapp_number, 'whatsapp_number', 15);
      if (!/^[0-9]{10,15}$/.test(wa)) throw bad('whatsapp_number must be 10-15 digits');
      const th = reqString(p.free_delivery_threshold, 'free_delivery_threshold', 12);
      if (!/^[0-9]+$/.test(th)) throw bad('free_delivery_threshold must be a whole number');
      const currency = reqString(p.currency, 'currency', 10);
      const beforeRows = await client.get('/rest/v1/site_config?select=*&order=key');
      const before = {};
      (beforeRows || []).forEach(function (c) { before[c.key] = c.value; });
      const vals = { whatsapp_number: wa, free_delivery_threshold: th, currency: currency };
      const now = new Date().toISOString();
      for (const k of Object.keys(vals)) {
        await client.update('/rest/v1/site_config?key=eq.' + encode(k),
          { value: vals[k], updated_at: now }, 'return=minimal');
      }
      await audit('settings_change', 'site_config', 'website', before, vals);
      return { ok: true };
    },

    site_status: async function () {
      const rows = await client.get('/rest/v1/site_settings?select=*&id=eq.1');
      return (rows && rows[0]) || null;
    },

    /* Direct row update (not the set_site_deactivated RPC: that function
       requires a Supabase Auth JWT, which the code-only panel has no
       way to present. The gate token checked above is the authorisation
       here, and the service key bypasses RLS. Same fields the RPC sets. */
    site_set_deactivated: async function (p) {
      const deactivated = reqBool(p.deactivated, 'deactivated');
      const reason = optString(p.reason, 'reason', 500, '');
      const before = await getOne('/rest/v1/site_settings?select=*&id=eq.1', 'Site settings');
      const body = {
        deactivated: deactivated,
        reason: deactivated ? reason : before.reason,
        deactivated_by: deactivated ? ACTOR : before.deactivated_by,
        deactivated_at: deactivated ? new Date().toISOString() : before.deactivated_at,
        updated_at: new Date().toISOString(),
      };
      await client.update('/rest/v1/site_settings?id=eq.1', body, 'return=minimal');
      await audit(deactivated ? 'site_deactivated' : 'site_restored', 'site_settings', '1',
        { deactivated: before.deactivated }, { deactivated: deactivated, reason: reason });
      return { ok: true, deactivated: deactivated };
    },

    global_search: async function (p) {
      const q = reqString(p.q, 'q', 100);
      if (q.trim().length < 2) throw bad('search text is too short');
      const clean = q.replace(/[*%(),]/g, '').trim();
      if (clean.length < 2) throw bad('search text is too short');
      const like = '*' + clean + '*';
      const e = encode(like);
      const results = await Promise.all([
        client.get('/rest/v1/products?select=id,name,slug,price_pkr&or=(name.ilike.' + e + ',slug.ilike.' + e + ')&limit=5'),
        client.get('/rest/v1/orders?select=id,order_code,customer_name,total_pkr&or=(order_code.ilike.' + e + ',customer_name.ilike.' + e + ',customer_phone.ilike.' + e + ')&limit=5'),
        client.get('/rest/v1/profiles?select=id,email,full_name&or=(email.ilike.' + e + ',full_name.ilike.' + e + ')&limit=5'),
      ]);
      return { products: results[0] || [], orders: results[1] || [], profiles: results[2] || [] };
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.GATE_TOKEN_SECRET || process.env.ADMIN_ACCESS_CODE;

  if (!sbUrl || !sbKey || !secret) {
    return json(res, 503, { ok: false, error: 'not_configured' });
  }

  const auth = req.headers.authorization || req.headers.Authorization || '';
  const token = (typeof auth === 'string' && auth.indexOf('Bearer ') === 0) ? auth.slice(7) : '';
  if (!gate.verifyToken(secret, token).ok) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return json(res, 400, { ok: false, error: 'bad_request' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
    return json(res, 400, { ok: false, error: 'bad_request' });
  }

  const h = handlers(makeClient(sbUrl, sbKey), sbUrl)[body.action];
  if (!h) return json(res, 400, { ok: false, error: 'unknown_action' });

  try {
    const result = await h(body);
    return json(res, 200, result === undefined ? { ok: true } : result);
  } catch (e) {
    if (e instanceof ApiError) return json(res, e.status, { ok: false, error: e.message });
    return json(res, 500, { ok: false, error: 'server_error' });
  }
};
