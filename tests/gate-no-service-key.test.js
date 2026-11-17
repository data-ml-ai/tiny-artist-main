// Tiny Artist — functional gate check. Run: node tests/gate-no-service-key.test.js
// Proves the access-code gate works with ONLY ADMIN_ACCESS_CODE set
// (no Supabase URL / service key): wrong code -> 401, right code -> 200
// with a token, 5 wrong codes from one IP -> 429 lockout, and no code
// configured at all -> 503. Uses a dummy code; never a real secret.
'use strict';

process.env.ADMIN_ACCESS_CODE = 'dummy-test-code-123';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.GATE_TOKEN_SECRET;

const handler = require('../api/verify-code.js');

let pass = 0, fail = 0;
function A(name, ok, extra) {
  if (ok) { pass++; } else { fail++; console.error('FAIL: ' + name, extra || ''); }
}

function call(code, ip) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      socket: {},
      body: { code: code },
    };
    const res = {
      statusCode: 0,
      setHeader: function () {},
      end: function (body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
    };
    handler(req, res);
  });
}

(async () => {
  // Right code, fresh IP -> 200 + token, weak_code false (19 chars).
  let r = await call('dummy-test-code-123', '10.0.0.1');
  A('right code returns 200 with token', r.status === 200 && r.body.ok === true && typeof r.body.token === 'string' && r.body.token.indexOf('.') !== -1, JSON.stringify(r));
  A('long dummy code is not weak', r.body.weak_code === false, JSON.stringify(r));

  // Wrong code, fresh IP -> 401 wrong_code with 4 remaining.
  r = await call('nope', '10.0.0.2');
  A('wrong code returns 401 wrong_code', r.status === 401 && r.body.error === 'wrong_code', JSON.stringify(r));
  A('wrong code reports remaining attempts', r.body.remaining_attempts === 4, JSON.stringify(r));

  // 4 more wrong codes from the same IP, then the 6th is locked out.
  for (let i = 0; i < 4; i++) await call('nope', '10.0.0.2');
  r = await call('nope', '10.0.0.2');
  A('6th failure from one IP returns 429 locked_out', r.status === 429 && r.body.error === 'locked_out', JSON.stringify(r));

  // A different IP is unaffected by the first IP's lockout.
  r = await call('dummy-test-code-123', '10.0.0.3');
  A('other IP unaffected by lockout', r.status === 200 && r.body.ok === true, JSON.stringify(r));

  // No code configured at all -> 503 not_configured.
  delete process.env.ADMIN_ACCESS_CODE;
  r = await call('whatever', '10.0.0.4');
  A('no code configured returns 503', r.status === 503 && r.body.error === 'not_configured', JSON.stringify(r));

  console.log('\n' + pass + '/' + (pass + fail) + ' gate checks passed');
  if (fail) { console.log('FAILED'); process.exit(1); }
  console.log('ALL GATE CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
