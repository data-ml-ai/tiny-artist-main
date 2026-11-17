// ============================================================================
// Tiny Artist — server order endpoint (EXAMPLE, NOT ACTIVE)
// ============================================================================
// To activate (Phase 2, see SETUP.md step 5):
//   1. npm install @supabase/supabase-js
//   2. Move this file to api/create-order.js (Vercel Serverless Function)
//   3. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in Vercel (server only)
//   4. Call it from checkout WITHOUT blocking WhatsApp navigation:
//      save locally + navigate immediately; treat this call as best-effort
//      shared persistence, never as a gate on the WhatsApp redirect.
//
// The endpoint NEVER trusts client prices/totals. Pricing happens inside
// the create_order() database function (backend/supabase/schema.sql).
// Without env vars it fails closed with 503 — it never invents an order.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const PHONE_RE = /^(\+92|0)?3[0-9]{9}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    // Fail closed: backend not configured. Frontend must still complete
    // the WhatsApp order from its local save (see SETUP.md).
    return res.status(503).json({ error: 'Order backend not configured' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  const customer = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];

  const phone = String(customer.phone || '').replace(/[\s\-()]/g, '');
  if (
    typeof customer.name !== 'string' || customer.name.trim().length < 2 ||
    !PHONE_RE.test(phone) ||
    typeof customer.address !== 'string' || customer.address.trim().length < 8 ||
    typeof customer.city !== 'string' || customer.city.trim().length < 2 ||
    items.length === 0 || items.length > 50
  ) {
    return res.status(400).json({ error: 'Invalid order payload' });
  }
  for (const item of items) {
    if (
      typeof item.product_id !== 'string' ||
      !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99
    ) {
      return res.status(400).json({ error: 'Invalid order item' });
    }
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('create_order', {
    p_customer: {
      name: customer.name.trim().slice(0, 80),
      phone: customer.phone.trim().slice(0, 20),
      address: customer.address.trim().slice(0, 300),
      city: customer.city.trim().slice(0, 60),
      instructions: String(customer.instructions || '').trim().slice(0, 200),
    },
    p_items: items.map((i) => ({
      product_id: i.product_id,
      quantity: i.quantity,
      custom_pack: i.custom_pack ?? null,
    })),
  });

  if (error) {
    console.error('create_order failed:', error.message);
    return res.status(400).json({ error: 'Order could not be created' });
  }
  return res.status(201).json({
    order_code: data.order_code,
    status: data.status,
    total_pkr: data.total_pkr,
  });
}
