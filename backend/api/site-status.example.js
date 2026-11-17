// ============================================================================
// Tiny Artist — site status endpoint (EXAMPLE, NOT ACTIVE)
// ============================================================================
// To activate (Phase 2, see SETUP.md step 5):
//   1. npm install @supabase/supabase-js
//   2. Move this file to api/site-status.js (Vercel Serverless Function)
//   3. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
//      in Vercel (service-role key is SERVER ONLY)
//   4. In index.html + recovery.html, set BACKEND_CONFIG.enabled = true
//      and statusApi = "/api/site-status", and wire window.supabaseClient
//      to the Supabase JS client with the signed-in session.
//
// GET  -> { deactivated: boolean }           (public; RLS allows the read)
// POST -> { deactivated: boolean }           (admin only; Bearer JWT + the
//        server-side email allowlist below, then the set_site_deactivated
//        database function, which re-checks is_admin() itself.)
// Without env vars it fails closed with 503. It never deletes anything:
// deactivation only flips the flag the storefront reads.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

// Server-side allowlist. This file runs ONLY on the server — never import
// it, or these addresses, into frontend code.
const ADMIN_EMAILS = new Set([
  'moosamahmood20002512@gmail.com',
  'asadvendor0@gmail.com',
]);

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    return res.status(503).json({ error: 'Site status backend not configured' });
  }

  if (req.method === 'GET') {
    const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('site_settings')
      .select('deactivated')
      .eq('id', 1)
      .single();
    if (error) {
      console.error('site_settings read failed:', error.message);
      return res.status(503).json({ error: 'Site status unavailable' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ deactivated: data.deactivated === true });
  }

  if (req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign-in required' });

    const supabaseAuth = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    const email = userData?.user?.email || '';
    if (userError || !ADMIN_EMAILS.has(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (typeof body.deactivated !== 'boolean') {
      return res.status(400).json({ error: 'deactivated must be a boolean' });
    }

    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
    // The gate is the verified JWT + email allowlist above, enforced here on
    // the server. The service-role client performs only this one minimal,
    // pre-validated update; it never sees or trusts any client-side role.
    const update = {
      deactivated: body.deactivated,
      reason: String(body.reason || '').slice(0, 200),
      updated_at: new Date().toISOString(),
    };
    if (body.deactivated) {
      update.deactivated_by = email;
      update.deactivated_at = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('site_settings')
      .update(update)
      .eq('id', 1)
      .select('deactivated')
      .single();
    if (error) {
      console.error('site_settings update failed:', error.message);
      return res.status(500).json({ error: 'Site status could not be changed' });
    }
    return res.status(200).json({ deactivated: data.deactivated === true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
