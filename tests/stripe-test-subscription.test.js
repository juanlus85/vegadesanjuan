import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import db from '../server/lib/db.js';
import router, { validateSubscriptionConsent } from '../server/routes/stripe.js';
import { SUBSCRIPTION_CONSENT_TEXT, SUBSCRIPTION_CONSENT_VERSION } from '../server/lib/subscriptions.js';

const names = ['STRIPE_ENABLE_TEST_SUBSCRIPTIONS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'APP_ORIGIN'];
const fakeConfig = {
  STRIPE_ENABLE_TEST_SUBSCRIPTIONS: 'true',
  STRIPE_SECRET_KEY: 'sk_test_synthetic_not_real',
  STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_not_real',
  APP_ORIGIN: 'https://example.org',
};

async function withApp(env, run) {
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldExecute = db.execute;
  const oldGetConnection = db.getConnection;
  const calls = { authentication: 0, transactions: 0 };
  for (const name of names) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  db.execute = async (sql, args) => {
    assert.match(sql, /^SELECT id, family_id, role, active FROM users WHERE id = \? LIMIT 1$/);
    assert.deepEqual(args, [1]);
    calls.authentication++;
    return [[{ id: 1, family_id: 2, role: 'member', active: 1 }]];
  };
  db.getConnection = async () => {
    calls.transactions++;
    throw new Error('La prueba no permite conexiones ni escrituras de base de datos');
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = req.get('x-test-user') === '1' ? { userId: 1 } : {};
    next();
  });
  app.use('/api', router);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = async (path, { authenticated = true, method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { ...(authenticated ? { 'x-test-user': '1' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try { await run({ request, calls }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    db.execute = oldExecute;
    db.getConnection = oldGetConnection;
    for (const name of names) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
  }
}

test('estado informativo autenticado: texto y versión exactos, cerrado por defecto', async () => {
  await withApp({}, async ({ request, calls }) => {
    const anonymous = await request('/api/member/card/status', { authenticated: false });
    assert.equal(anonymous.status, 401);
    assert.equal(calls.authentication, 0);
    const response = await request('/api/member/card/status');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true, enabledTest: false,
      consentText: SUBSCRIPTION_CONSENT_TEXT, consentVersion: SUBSCRIPTION_CONSENT_VERSION,
    });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(calls.authentication, 1);
    assert.equal(calls.transactions, 0);
  });
});

test('la configuración de prueba no permite altas sin aislamiento verificable de la base', async () => {
  for (const config of [
    fakeConfig,
    { ...fakeConfig, STRIPE_SECRET_KEY: 'rk_test_synthetic_not_real' },
    { ...fakeConfig, STRIPE_SECRET_KEY: 'sk_live_do_not_use' },
    { ...fakeConfig, STRIPE_SECRET_KEY: 'rk_live_do_not_use' },
    { ...fakeConfig, STRIPE_WEBHOOK_SECRET: undefined },
    { ...fakeConfig, APP_ORIGIN: 'http://example.org' },
    { ...fakeConfig, STRIPE_ENABLE_TEST_SUBSCRIPTIONS: undefined },
    { ...fakeConfig, STRIPE_ENABLE_TEST_SUBSCRIPTIONS: 'TRUE' },
  ]) {
    await withApp(config, async ({ request, calls }) => {
      const status = await request('/api/member/card/status');
      assert.equal(status.status, 200);
      assert.equal(status.body.enabledTest, false);
      const setup = await request('/api/member/card/setup', {
        method: 'POST', body: { consent: true, consentVersion: SUBSCRIPTION_CONSENT_VERSION },
      });
      assert.equal(setup.status, 503);
      assert.equal(setup.body.ok, false);
      assert.match(setup.body.error, /No se ha registrado consentimiento/);
      assert.equal(calls.authentication, 2);
      assert.equal(calls.transactions, 0);
    });
  }
});

test('la validación candidata solo acepta consentimiento explícito y versión exacta', () => {
  assert.doesNotThrow(() => validateSubscriptionConsent({ consent: true, consentVersion: SUBSCRIPTION_CONSENT_VERSION }));
  for (const value of [null, {}, [], { consent: 'true', consentVersion: SUBSCRIPTION_CONSENT_VERSION },
    { consent: false, consentVersion: SUBSCRIPTION_CONSENT_VERSION },
    { consent: true }, { consent: true, consentVersion: 'annual-card-old' },
    { consent: true, consentVersion: `${SUBSCRIPTION_CONSENT_VERSION} ` },
    { consent: true, consentVersion: null }]) {
    assert.throws(() => validateSubscriptionConsent(value), error => error.status === 400);
  }
});

test('una versión desactualizada no inicia Stripe ni escribe, incluso con opt-in de prueba', async () => {
  await withApp(fakeConfig, async ({ request, calls }) => {
    for (const body of [{ consent: true, consentVersion: 'annual-card-old' }, { consent: true }, { consent: false }]) {
      const setup = await request('/api/member/card/setup', { method: 'POST', body });
      // La puerta de cierre prevalece hasta resolver el aislamiento de datos.
      assert.equal(setup.status, 503);
      assert.equal(setup.body.ok, false);
    }
    assert.equal(calls.authentication, 3);
    assert.equal(calls.transactions, 0);
  });
});

test.after(async () => { await db.end(); });
