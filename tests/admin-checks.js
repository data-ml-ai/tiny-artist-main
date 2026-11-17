// Tiny Artist — admin panel checks. Run: node tests/admin-checks.js
// Static verification of the admin panel wiring: no secrets or allowlist
// emails in browser code, the server gate reads env vars only, the schema
// carries the 3-admin allowlist + super admin, and the /admin route exists.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf-8');

let pass = 0, fail = 0;
function A(name, ok, extra) {
  if (ok) { pass++; } else { fail++; console.error('FAIL: ' + name, extra || ''); }
}

const admin = read('admin.html');
const apiFn = read('api/verify-code.js');
const adminApi = read('api/admin.js');
const gateLib = read('api/_gate.js');
const schema = read('backend/supabase/schema.sql');
const vercel = JSON.parse(read('vercel.json'));
const index = read('index.html');

// 1. No secrets in browser code, and no direct Supabase access from the panel
A('admin.html has no access code literal', !/2272/.test(admin));
A('admin.html has no admin emails', !/moosamahmood|asadvendor|learnandlead/.test(admin));
A('admin.html has no secret key material', !/sb_secret|service_role|SERVICE_ROLE/i.test(admin));
A('admin.html has no fake/sample data markers', !/SAMPLE_|sample customer|fake order/i.test(admin));
A('admin.html never calls Supabase directly', !admin.includes('/rest/v1') && !admin.includes('/auth/v1') && !admin.includes('supabase-config'));
A('admin.html has no account login', !admin.includes('grant_type=password') && !admin.includes('is_admin') && !admin.includes('kill-pass') && !admin.includes('login-form'));
A('admin.html talks to the server API only', admin.includes('/api/admin') && admin.includes('Bearer '));
A('index.html still exposes no admin emails', !/moosamahmood|asadvendor|learnandlead/.test(index));
A('api fn reads the code from env only', apiFn.includes('process.env.ADMIN_ACCESS_CODE') && !/2272/.test(apiFn));
A('api fn uses the service key from env only', apiFn.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'));
A('api fn gate works without the service key', apiFn.includes("if (!code) {") && !/if \(!code \|\| !sbUrl/.test(apiFn) && apiFn.includes('sbUsable = Boolean(sbUrl && sbKey)'));
A('api fn still refuses to run without a code', apiFn.includes("error: 'not_configured'"));
A('api fn has rate limiting + lockout', apiFn.includes('MAX_FAILURES') && apiFn.includes('429') && apiFn.includes('access_attempts'));
A('api fn signs gate tokens via shared lib', apiFn.includes("require('./_gate')") && apiFn.includes('gate.issueToken'));
A('gate lib issues + verifies tokens', gateLib.includes('issueToken') && gateLib.includes('verifyToken') && gateLib.includes('timingSafeEqual'));
A('admin api requires the service key', adminApi.includes('process.env.SUPABASE_SERVICE_ROLE_KEY') && adminApi.includes("error: 'not_configured'"));
A('admin api verifies the gate token first', adminApi.includes('verifyToken') && adminApi.includes("error: 'unauthorized'"));
A('admin api whitelists actions', adminApi.includes("error: 'unknown_action'") && adminApi.includes('site_set_deactivated') && adminApi.includes('product_image_upload') && adminApi.includes('global_search'));
A('admin api has no generic table proxy', !/req\.body\.table|params\.table|body\.path/.test(adminApi));
A('admin api audits writes as access-code', adminApi.includes("ACTOR = 'access-code'") && adminApi.includes('admin_audit_log'));

// 2. Admin panel structure
const sections = ['dashboard', 'orders', 'products', 'packs', 'inventory', 'customers', 'carts', 'activity', 'audit', 'settings', 'super'];
sections.forEach((s) => A('admin section present: ' + s, admin.includes('"' + s + '"')));
A('admin uses the gate token for the panel', admin.includes('GATE_KEY') && admin.includes('gateTokenValid'));
A('admin kill switch requires typed confirm', admin.includes('DEACTIVATE') && admin.includes('kill-confirm') && admin.includes('site_set_deactivated'));
A('admin api fn parses', (() => { try { new vm.Script(adminApi, { filename: 'admin.js' }); return true; } catch (e) { console.error(e.message); return false; } })());
A('gate lib parses', (() => { try { new vm.Script(gateLib, { filename: '_gate.js' }); return true; } catch (e) { console.error(e.message); return false; } })());
A('admin JS parses', (() => {
  try {
    const blocks = [...admin.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    blocks.forEach((b, i) => new vm.Script(b, { filename: 'admin-' + i + '.js' }));
    return blocks.length === 3;
  } catch (e) { console.error(e.message); return false; }
})());
A('api fn parses', (() => { try { new vm.Script(apiFn, { filename: 'verify-code.js' }); return true; } catch (e) { console.error(e.message); return false; } })());

// 3. Schema v2
A('schema allowlists 3 admins', schema.includes('moosamahmood20002512@gmail.com') && schema.includes('asadvendor0@gmail.com') && schema.includes('learnandlead36@gmail.com'));
A('schema has is_super_admin', schema.includes('create or replace function public.is_super_admin()'));
A('schema deactivation is super-admin-only', schema.includes('is_super_admin() then') && schema.includes('site settings super admin update'));
A('schema seeds 16 figures at Rs. 70', (schema.match(/, 70, 'TA-/g) || []).length === 16);
A('schema seeds official packs', schema.includes('pack-15-big-pieces') && schema.includes('899') && schema.includes('pack-20-big-pieces') && schema.includes('1199') && schema.includes('pack-30-big-pieces') && schema.includes('1499'));
A('schema keeps poster kits', schema.includes('20-pcs-painting-set') && schema.includes('1000') && schema.includes('30-pcs-painting-kit') && schema.includes('1300'));
A('schema seeds colour packs unpriced', schema.includes('small-colour-pack') && schema.includes('large-colour-pack'));
A('schema has audit + attempts + config tables', schema.includes('admin_audit_log') && schema.includes('access_attempts') && schema.includes('site_config'));
A('schema has product cost/sku/featured', schema.includes('cost_pkr') && schema.includes('sku text') && schema.includes('is_featured'));
A('schema has order admin notes + coords', schema.includes('admin_notes') && schema.includes('delivery_lat'));
A('schema order statuses match spec', schema.includes("'Completed', 'Cancelled'"));
A('schema create_order prices custom packs', schema.includes('pack_product_id') && schema.includes('Build-Your-Own pack'));
A('schema grants RPC execute', schema.includes('grant execute on function public.create_order'));
A('schema has product-images bucket', schema.includes("storage.buckets") && schema.includes('product-images'));

// 4. Routing + storefront wiring
A('vercel rewrites /admin to admin.html', (vercel.rewrites || []).some((r) => r.source === '/admin' && r.destination === '/admin.html'));
A('vercel CSP allows storage images', JSON.stringify(vercel).includes('img-src') && JSON.stringify(vercel).includes('*.supabase.co'));
A('storefront has no admin nav link', !index.includes('href="#/admin"'));
A('storefront fetches live catalogue', index.includes('refreshCatalogue') && index.includes('/rest/v1/products'));
A('storefront submits orders to backend', index.includes('submitOrderToBackend') && index.includes('rpc/create_order'));
A('storefront logs events to backend', index.includes('logEventRemote') && index.includes('analytics_events'));
A('storefront reads live site config', index.includes('refreshConfig') && index.includes('site_config'));

console.log('\n' + pass + '/' + (pass + fail) + ' admin checks passed');
if (fail) { console.log('FAILED'); process.exit(1); }
console.log('ALL ADMIN CHECKS PASSED');
