// Tiny Artist — functional tests. Run: node tests/checkout.test.js
// Runs the REAL scripts from index.html in a VM sandbox (stubbed DOM/storage)
// and asserts cart math, WhatsApp message format/encoding, validation,
// unpriced-item guards, duplicate-submit guards, and admin honesty.
// Functional tests for Tiny Artist index.html — runs the REAL page scripts in a VM sandbox.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf-8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 2) { console.error('expected 2 script blocks, got', scripts.length); process.exit(1); }

function makeStore() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
  };
}
const elements = {};
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', disabled: false,
    style: {}, _h: null, onclick: null, onsubmit: null,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, focus() {}, querySelectorAll: () => [],
  };
}
const locationStub = { hash: '#/', href: 'http://test/' };
const sandbox = {
  console,
  URLSearchParams,
  navigator: { webdriver: false },
  localStorage: makeStore(),
  sessionStorage: makeStore(),
  location: locationStub,
  setInterval: () => 1,
  clearTimeout: () => {},
  setTimeout: () => 0, // do not auto-run deferred callbacks; tests invoke views directly
  document: {
    title: 'Tiny Artist',
    head: { appendChild() {} },
    body: null, // set below (needs makeEl)
    createElement: () => ({ textContent: '', setAttribute() {} }),
    getElementById: id => (elements[id] || (elements[id] = makeEl(id))),
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
};
sandbox.document.body = makeEl('body');
sandbox.window = sandbox;
sandbox.window.scrollTo = () => {};
sandbox.window.addEventListener = () => {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const results = [];
sandbox.__results = results;
sandbox.__assert = (name, cond, extra) => {
  results.push({ name, pass: !!cond, extra: extra || '' });
  if (!cond) console.error('FAIL:', name, extra || '');
};

vm.runInContext(scripts.join('\n;\n'), sandbox, { filename: 'index-combined.js' });

const tests = `
;(function(){
  const A = __assert;
  // 1. Home renders kits + coming soon + prices
  const home = homeView();
  A('home has 20 Pcs kit', home.includes('20 Pcs Painting Set'));
  A('home has 30 Pcs kit', home.includes('30 Pcs Painting Kit'));
  A('home shows PKR 1,000', home.includes('PKR 1,000'));
  A('home shows PKR 1,300', home.includes('PKR 1,300'));
  A('home has Coming Soon', home.includes('Coming Soon'));
  A('home has no demo-order text', !home.includes('demo order'));

  // 2. Cart math: 1x20pcs + 2x30pcs = 3600, free delivery
  cart.length = 0; prices = {};
  addKit('20-pcs-painting-set');
  addKit('30-pcs-painting-kit'); addKit('30-pcs-painting-kit');
  A('cart count 3', cartCount() === 3, 'got ' + cartCount());
  A('subtotal 3600', cartSubtotal() === 3600, 'got ' + cartSubtotal());
  A('delivery FREE over 2000', deliveryInfo(3600).label === 'FREE');
  A('delivery TBC at 1000', deliveryInfo(1000).label === 'To Be Confirmed');
  A('delivery TBC at exactly 2000', deliveryInfo(2000).label === 'To Be Confirmed');

  // 3. Message format (exact) + URL encoding round-trip
  const d = {name:'Test User', phone:'03001234567', city:'Lahore', address:'House 1, Street 2, Lahore', note:'Ring the bell'};
  const msg = buildOrderMessage(d, cartMessageLines(), 3600, deliveryInfo(3600));
  A('msg greeting', msg.startsWith('Hello Tiny Artist! I want to place an order.'));
  A('msg has customer block', msg.includes('Name: Test User') && msg.includes('Phone: 03001234567') && msg.includes('City: Lahore'));
  A('msg has kit lines with line totals', msg.includes('20 Pcs Painting Set × 1 — PKR 1,000') && msg.includes('30 Pcs Painting Kit × 2 — PKR 2,600'), msg);
  A('msg subtotal/total/delivery', msg.includes('Subtotal: PKR 3,600') && msg.includes('Delivery Charges: FREE') && msg.includes('Total: PKR 3,600'));
  A('msg instructions + confirm', msg.includes('Additional Instructions: Ring the bell') && msg.endsWith('Please confirm my order.'));
  const url = 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(msg);
  A('wa url host/number', url.startsWith('https://wa.me/923098426672?text='));
  A('wa round-trip decode', decodeURIComponent(url.split('text=')[1]) === msg);
  A('msg with empty note shows None', buildOrderMessage({...d, note:''}, cartMessageLines(), 3600, deliveryInfo(3600)).includes('Additional Instructions: None'));

  // 4. Phone validation
  A('phone 0300 ok', validPhone('03001234567'));
  A('phone +92 ok', validPhone('+923001234567'));
  A('phone spaced ok', validPhone('0300 1234567'));
  A('phone 10-digit ok', validPhone('3001234567'));
  A('phone short rejected', !validPhone('03001234'));
  A('phone letters rejected', !validPhone('abc'));
  A('phone landline rejected', !validPhone('0421234567'));

  // 5. Figures cost Rs. 70 by default; unpriced colour pack blocks totals; pricing it unblocks
  A('every figure defaults to Rs. 70', PRODUCTS.every(p => priceOf(p.slug) === 70));
  A('packs still unpriced by default', priceOf('pack-small') === null && priceOf('pack-large') === null);
  A('admin override wins, clearing restores 70', (() => { prices['rocket'] = 500; const a = priceOf('rocket') === 500; delete prices['rocket']; return a && priceOf('rocket') === 70; })());
  addProduct('rocket');
  A('subtotal 3670 with default-priced rocket', cartSubtotal() === 3670, 'got ' + cartSubtotal());
  cartQty(cart.length - 1, -1); // remove rocket (qty 1 -> removed)
  A('subtotal back to 3600', cartSubtotal() === 3600);
  cart.push({kind:'pack', pack:'small', name:'Custom Pack — Small Colour Pack', items:{rocket:1}, qty:1});
  A('subtotal null with unpriced colour pack', cartSubtotal() === null);
  A('unpricedItems names the custom pack', unpricedItems().includes('Custom Pack — Small Colour Pack'));
  A('cart view disables Order Now when unpriced', cartView().includes('disabled') && cartView().includes('no price yet'));
  prices['pack-small'] = 300;
  A('pack total uses priceKey + figure price (3600+300+70)', cartSubtotal() === 3970, 'got ' + cartSubtotal());
  A('cart view enables Order Now when priced', cartView().includes('Order Now') && !cartView().includes('no price yet'));
  cartRemove(cart.length - 1);
  A('subtotal back to 3600', cartSubtotal() === 3600);
  delete prices['pack-small'];

  // 6. Quantity controls
  cartQty(0, 1);
  A('qty+ works', cart[0].qty === 2 && cartSubtotal() === 4600, 'got ' + JSON.stringify(cart) + ' ' + cartSubtotal());
  cartQty(0, -1);
  A('qty- works', cart[0].qty === 1 && cartSubtotal() === 3600);
  cartRemove(1);
  A('remove works', cart.length === 1 && cartSubtotal() === 1000);

  // 7. Shop filtering + kit detail + search
  A('shop Space filter excludes kits', !shopView('', 'Space', '').includes('20 Pcs Painting Set') && shopView('', 'Space', '').includes('Rocket'));
  A('shop Painting Kits filter shows kits only', shopView('', 'Painting Kits', '').includes('30 Pcs Painting Kit') && !shopView('', 'Painting Kits', '').includes('Cute Baby Astronaut'));
  A('shop search finds kit', shopView('painting', '', '').includes('20 Pcs Painting Set'));
  const kv = kitView(KITS[0]);
  A('kit detail has contents + price', kv.includes('12 colours') && kv.includes('PKR 1,000') && kv.includes('Add to Cart'));
  A('kit detail has poster image', kv.includes('assets/kit-20pcs.webp') && kv.includes('assets/kit-20pcs.png'));

  // 8. Checkout validation blocks bad input, keeps cart
  cart.length = 0; addKit('20-pcs-painting-set');
  const beforeHref = location.href;
  document.getElementById('coname').value = '';
  document.getElementById('cophone').value = '123';
  document.getElementById('cocity').value = '';
  document.getElementById('coaddr').value = 'short';
  document.getElementById('conote').value = '';
  placeOrder({ preventDefault() {} });
  A('invalid checkout shows name error', document.getElementById('err-name').textContent.length > 0);
  A('invalid checkout shows phone error', document.getElementById('err-phone').textContent.length > 0);
  A('invalid checkout does not navigate', location.href === beforeHref);
  A('invalid checkout keeps cart', cart.length === 1);

  // 9. Valid checkout: saves Pending Confirmation order, clears cart, navigates to wa.me
  document.getElementById('coname').value = 'Ayesha Khan';
  document.getElementById('cophone').value = '0321 7654321';
  document.getElementById('cocity').value = 'Karachi';
  document.getElementById('coaddr').value = 'Flat 5, Building 9, DHA Phase 6, Karachi';
  document.getElementById('conote').value = 'Call on arrival';
  const ordersBefore = orders.length;
  placeOrder({ preventDefault() {} });
  A('valid checkout navigates to wa.me', location.href.startsWith('https://wa.me/923098426672?text='), location.href.slice(0, 60));
  const sent = decodeURIComponent(location.href.split('text=')[1]);
  A('sent message has customer + order', sent.includes('Ayesha Khan') && sent.includes('0321 7654321') && sent.includes('Karachi') && sent.includes('20 Pcs Painting Set × 1 — PKR 1,000') && sent.includes('Call on arrival'));
  A('order saved', orders.length === ordersBefore + 1);
  A('order status Pending Confirmation', orders[0].status === 'Pending Confirmation', orders[0].status);
  A('order total 1000', orders[0].total === 1000);
  A('cart cleared after save', cart.length === 0);
  A('confirmation view shows pending + fallback link', confirmView().includes('Pending Confirmation') && confirmView().includes('Open WhatsApp Order Again'));

  // 10. Duplicate submission blocked while submitting
  cart.push({kind:'kit', slug:'20-pcs-painting-set', name:'20 Pcs Painting Set', qty:1});
  const hrefAfterFirst = location.href;
  placeOrder({ preventDefault() {} }); // waSubmitting still true (setTimeout stubbed)
  A('duplicate submit blocked', orders.length === ordersBefore + 1 && location.href === hrefAfterFirst);
  render(); // resets guard
  A('guard reset after render allows new order path (cart still present)', cart.length === 1);

  // 11. Admin shows real local numbers only, no fake data
  adminOn = true;
  const ov = adminView('overview');
  A('admin overview has no sample offsets', !ov.includes('sample + live') && !ov.includes('Total visitors (sample'));
  A('admin overview labels local preview', ov.includes('Local preview only'));
  const cartsHtml = adminView('carts');
  A('admin carts has no fake customers', !cartsHtml.includes('SAMPLE') && !cartsHtml.includes('Bilal'));
  const prodHtml = adminView('products');
  A('admin products lists fixed kit prices', prodHtml.includes('20 Pcs Painting Set') && prodHtml.includes('fixed'));

  // 12. Kill switch: confirmation guard, blank page, recovery
  A('confirmDeletion requires DELETE + ack', confirmDeletion('DELETE', true) === true && confirmDeletion('delete', true) === false && confirmDeletion('DELETE', false) === false && confirmDeletion('', true) === false);
  A('site starts active', siteDeactivated === false);
  const dangerHtml = adminView('danger');
  A('danger tab has Delete Website + typed confirmation + recovery link', dangerHtml.includes('Delete Website') && dangerHtml.includes('DELETE') && dangerHtml.includes('recovery.html') && dangerHtml.includes('Local preview only'));
  document.getElementById('app').innerHTML = 'SENTINEL';
  siteDeactivated = true; render();
  A('render blanks page when deactivated', document.body.innerHTML === '' && document.getElementById('app').innerHTML === 'SENTINEL');
  siteDeactivated = false; render();
  A('render restores content after recovery', document.getElementById('app').innerHTML.includes('Painting Kits'));
  LS.set('deactivated', true);
  A('local deactivation flag persists', LS.get('deactivated', false) === true);
  LS.set('deactivated', false);
  A('local deactivation flag clears', LS.get('deactivated', false) === false);
})();
`;
vm.runInContext(tests, sandbox, { filename: 'tests.js' });

// Host-side repo checks: status file, recovery page, server allowlist, no leaks.
(function hostChecks() {
  const path = require('path');
  const root = path.join(__dirname, '..');
  const H = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra || '' });
    if (!cond) console.error('FAIL:', name, extra || '');
  };
  const statusJson = JSON.parse(fs.readFileSync(path.join(root, 'site-status.json'), 'utf-8'));
  H('site-status.json exists and site is active', statusJson.deactivated === false);
  const recovery = fs.readFileSync(path.join(root, 'recovery.html'), 'utf-8');
  H('recovery page requires RESTORE', recovery.includes('RESTORE'));
  H('recovery page deletes nothing (wording)', recovery.includes('deletes nothing'));
  H('recovery page exposes no admin emails', !recovery.includes('moosamahmood') && !recovery.includes('asadvendor'));
  const schema = fs.readFileSync(path.join(root, 'backend/supabase/schema.sql'), 'utf-8');
  H('schema allowlist includes moosamahmood20002512@gmail.com', schema.includes("'moosamahmood20002512@gmail.com'"));
  H('schema allowlist includes asadvendor0@gmail.com', schema.includes("'asadvendor0@gmail.com'"));
  H('schema has site_settings + set_site_deactivated', schema.includes('site_settings') && schema.includes('set_site_deactivated'));
  H('schema has RLS on site_settings', schema.includes('enable row level security') && schema.includes('site settings super admin update') && schema.includes('is_super_admin'));
  const indexSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
  H('index checks site status on boot', indexSrc.includes('site-status.json') && indexSrc.includes('bootSite'));
  H('index exposes no admin emails', !indexSrc.includes('moosamahmood') && !indexSrc.includes('asadvendor'));
})();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('FAILED:', failed.map(f => f.name).join(' | '));
  process.exit(1);
}
console.log('ALL TESTS PASSED');
