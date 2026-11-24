import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import db from '../server/lib/db.js';
import { HttpError, stripeConfig } from '../server/lib/stripe.js';
import { webhookHandler } from '../server/routes/stripe.js';

const envNames = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'APP_ORIGIN'];
const webhookSecret = 'whsec_local_fake_not_real';

function withEnvironment(values, fn) {
  const old = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try { return fn(); }
  finally {
    for (const name of envNames) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

const configuredEnv = {
  STRIPE_SECRET_KEY: 'sk_test_local_fake_not_real',
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  APP_ORIGIN: 'https://example.org',
};

test('Stripe solo admite claves secretas o restringidas de pruebas inequívocas', () => {
  for (const key of ['sk_test_local_fake_not_real', 'rk_test_local_fake_not_real']) {
    withEnvironment({ ...configuredEnv, STRIPE_SECRET_KEY: key }, () => {
      const config = stripeConfig();
      assert.equal(config.origin, 'https://example.org');
      assert.equal(config.webhookSecret, webhookSecret);
      assert.ok(config.stripe);
    });
  }
  for (const key of ['sk_live_do_not_use', 'rk_live_do_not_use', 'pk_test_fake', 'whsec_fake',
    'sk_test_', 'rk_test_', 'SK_TEST_fake', ' sk_test_fake', 'sk_test_fake\n', 'rk_test_fake fake', 'unknown']) {
    withEnvironment({ ...configuredEnv, STRIPE_SECRET_KEY: key }, () => {
      assert.throws(() => stripeConfig(), error => {
        assert.ok(error instanceof HttpError, key);
        assert.equal(error.status, 503, key);
        assert.match(error.message, /cobros reales están deshabilitados hasta completar la conciliación/i, key);
        assert.doesNotMatch(error.message, /sk_live_do_not_use|rk_live_do_not_use/, 'no filtrar la clave');
        return true;
      });
    });
  }
  withEnvironment({ ...configuredEnv, STRIPE_SECRET_KEY: undefined }, () => {
    assert.throws(() => stripeConfig(), error => error instanceof HttpError && error.status === 503);
  });
  // El bloqueo de claves de producción prevalece aunque falten otras variables.
  withEnvironment({ STRIPE_SECRET_KEY: 'sk_live_do_not_use' }, () => {
    assert.throws(() => stripeConfig(), error => error.status === 503 && /conciliación/.test(error.message));
  });
});

function fakeDatabase() {
  let state = {
    events: [],
    family: { id: 15, status: 'active' },
    event: { id: 42 },
    order: { id: 29, family_id: 15, event_id: 42, amount_cents: 1000, status: 'pending', live_reservation: 1, stripe_session_id: 'cs_test_ticket' },
    charge: { id: 99, family_id: 15, kind: 'extra', amount_cents: 1000, status: 'pending' },
    payments: [{ id: 7, family_id: 15, charge_id: 99, ticket_order_id: null, amount_cents: 1000, provider: 'stripe',
      status: 'pending', stripe_session_id: 'cs_test_charge', stripe_payment_intent_id: null, stripe_invoice_id: null }],
  };
  let before;
  const conn = {
    async beginTransaction() { before = structuredClone(state); },
    async commit() {},
    async rollback() { state = before; },
    release() {},
    async execute(sql, args = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO stripe_events')) {
        if (state.events.includes(args[0])) { const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error; }
        state.events.push(args[0]); return [{ affectedRows: 1 }];
      }
      if (s.startsWith('SELECT * FROM events WHERE id')) return [[state.event.id === args[0] ? state.event : args[0] === 43 ? { id: 43 } : null].filter(Boolean)];
      if (s.startsWith('SELECT * FROM families WHERE id')) return [[state.family.id === args[0] ? state.family : args[0] === 16 ? { id: 16, status: 'active' } : null].filter(Boolean)];
      if (s.startsWith('SELECT *, (expires_at > UTC_TIMESTAMP())')) return [[state.order.id === args[0] ? state.order : null].filter(Boolean)];
      if (s.startsWith('SELECT *, DATE_FORMAT(due_date')) return [[state.charge.id === args[0] ? state.charge : args[0] === 100 ? { id: 100, family_id: 16 } : null].filter(Boolean)];
      if (s.startsWith('SELECT COUNT(*) AS n FROM family_members')) return [[{ n: 2 }]];
      if (s.startsWith('SELECT COALESCE(SUM(member_qty), 0) AS n FROM ticket_orders')) return [[{ n: 1 }]];
      if (s.startsWith('SELECT * FROM payments WHERE')) {
        const columns = [...s.matchAll(/(id|stripe_session_id|stripe_payment_intent_id|stripe_invoice_id) = \?/g)].map(m => m[1]);
        return [state.payments.filter(row => columns.some((column, i) => row[column] === args[i]))];
      }
      if (s.startsWith('UPDATE ticket_orders SET stripe_session_id')) {
        state.order.stripe_session_id ||= args[0]; return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE ticket_orders SET status')) {
        state.order.status = args[0]; return [{ affectedRows: 1 }];
      }
      if (s.startsWith("UPDATE payments SET status = 'failed'")) {
        const row = state.payments.find(p => p.id === args[1]);
        row.status = 'failed'; row.stripe_session_id ||= args[0]; return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE payments SET stripe_session_id')) {
        const [session, intent, invoice, charge, order, amount, status, reference, , id] = args;
        const row = state.payments.find(p => p.id === id);
        row.stripe_session_id ||= session; row.stripe_payment_intent_id ||= intent; row.stripe_invoice_id ||= invoice;
        row.charge_id ||= charge; row.ticket_order_id ||= order; row.amount_cents = amount; row.status = status; row.reference = reference;
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith('INSERT INTO payments')) {
        const [family, charge, order, amount, status, session, intent, invoice, reference] = args;
        const row = { id: 8, family_id: family, charge_id: charge, ticket_order_id: order, amount_cents: amount,
          provider: 'stripe', status, stripe_session_id: session, stripe_payment_intent_id: intent, stripe_invoice_id: invoice, reference };
        state.payments.push(row); return [{ insertId: row.id }];
      }
      if (s.startsWith("UPDATE charges SET status = 'paid'")) {
        state.charge.status = 'paid'; return [{ affectedRows: 1 }];
      }
      throw new Error(`Consulta inesperada en prueba: ${s}`);
    },
  };
  return { conn, get state() { return state; } };
}

async function withWebhook(t, fn) {
  const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const oldGetConnection = db.getConnection;
  const fake = fakeDatabase();
  t.mock.method(console, 'error', () => {});
  Object.assign(process.env, configuredEnv);
  db.getConnection = async () => fake.conn;
  try { await fn(fake); }
  finally {
    db.getConnection = oldGetConnection;
    for (const name of envNames) {
      if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name];
    }
  }
}

async function signedWebhook(id, type, object, livemode = false) {
  const payload = JSON.stringify({ id, type, livemode, created: Math.floor(Date.now() / 1000), data: { object } });
  const stripe = new Stripe('sk_test_local_fake_not_real');
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  let status = 200, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await webhookHandler({ body: Buffer.from(payload), get: () => signature }, res);
  return { status, body };
}

function session(kind) {
  return {
    id: `cs_test_${kind}`, mode: 'payment', status: 'complete', payment_status: 'paid',
    client_reference_id: kind === 'ticket' ? 'ticket:29' : 'charge-payment:7',
    metadata: kind === 'ticket'
      ? { kind, order_id: '29', family_id: '15', event_id: '42' }
      : { kind, payment_id: '7', charge_id: '99', family_id: '15' },
    payment_intent: `pi_test_${kind}`, amount_total: 1000, currency: 'eur', created: Math.floor(Date.now() / 1000),
  };
}

function assertUnchanged(fake, previous, label) {
  assert.deepEqual(fake.state, previous, `${label}: rollback completo, sin pago ni evento persistido`);
}

test('un webhook real firmado se rechaza antes de modificar la base', async t => {
  await withWebhook(t, async fake => {
    const previous = structuredClone(fake.state);
    const result = await signedWebhook('evt_live', 'checkout.session.completed', session('ticket'), true);
    assert.equal(result.status, 503);
    assertUnchanged(fake, previous, 'evento de producción');
  });
});

for (const kind of ['charge', 'ticket']) {
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    test(`${kind}: ${type} acepta exclusivamente la sesión completa correlacionada y es idempotente`, async t => {
      await withWebhook(t, async fake => {
        const s = session(kind);
        assert.equal((await signedWebhook('evt_good', type, s)).status, 200);
        const item = kind === 'ticket' ? fake.state.order : fake.state.charge;
        assert.equal(item.status, 'paid');
        const record = fake.state.payments.find(p => p.stripe_session_id === s.id);
        assert.equal(record.status, 'paid');
        assert.equal(kind === 'ticket' ? record.ticket_order_id : record.id, kind === 'ticket' ? 29 : 7);
        assert.equal((await signedWebhook('evt_good', type, s)).status, 200);
        assert.equal((await signedWebhook('evt_second', type, s)).status, 200);
        assert.equal(fake.state.payments.filter(p => p.stripe_session_id === s.id).length, 1);
        assert.equal(item.status, 'paid');
      });
    });

    test(`${kind}: ${type} rechaza modo, estado, referencia y datos contradictorios`, async t => {
      await withWebhook(t, async fake => {
        const cases = [
          ['modo suscripción', s => { s.mode = 'subscription'; }],
          ['modo ausente', s => { delete s.mode; }],
          ['estado open', s => { s.status = 'open'; }],
          ['estado expired', s => { s.status = 'expired'; }],
          ['estado ausente', s => { delete s.status; }],
          ['referencia ausente', s => { delete s.client_reference_id; }],
          ['referencia nula', s => { s.client_reference_id = null; }],
          ['referencia con identificador distinto', s => { s.client_reference_id = kind === 'ticket' ? 'ticket:30' : 'charge-payment:8'; }],
          ['referencia con prefijo distinto', s => { s.client_reference_id = kind === 'ticket' ? 'charge-payment:29' : 'ticket:7'; }],
          ['referencia no canónica', s => { s.client_reference_id = kind === 'ticket' ? 'ticket:029' : 'charge-payment:07'; }],
          ['referencia al cargo en vez del pago', s => { s.client_reference_id = kind === 'ticket' ? 'ticket:42' : 'charge-payment:99'; }],
          ['id ausente', s => { delete s.id; }],
          ['sesión diferente de la persistida', s => { s.id = 'cs_test_other'; }],
          ['familia distinta en metadata', s => { s.metadata.family_id = '16'; }],
          ['familia inexistente en metadata', s => { s.metadata.family_id = '17'; }],
          [kind === 'ticket' ? 'evento distinto en metadata' : 'cargo distinto en metadata', s => {
            if (kind === 'ticket') s.metadata.event_id = '43'; else s.metadata.charge_id = '100';
          }],
          ['identificador de origen distinto en metadata', s => {
            if (kind === 'ticket') s.metadata.order_id = '30'; else s.metadata.payment_id = '8';
          }],
        ];
        for (const [label, change] of cases) {
          const before = structuredClone(fake.state);
          const s = session(kind); change(s);
          const result = await signedWebhook(`evt_bad_${label}`, type, s);
          assert.ok(result.status >= 400, `${label}: HTTP ${result.status}`);
          assertUnchanged(fake, before, label);
        }
      });
    });
  }

  test(`${kind}: expiración y fallo asíncrono no requieren estado complete`, async t => {
    for (const [type, status, expected] of [
      ['checkout.session.expired', 'expired', kind === 'ticket' ? 'expired' : 'failed'],
      ['checkout.session.expired', undefined, kind === 'ticket' ? 'expired' : 'failed'],
      ['checkout.session.async_payment_failed', undefined, kind === 'ticket' ? 'cancelled' : 'failed'],
    ]) {
      await withWebhook(t, async fake => {
        const s = session(kind); s.payment_status = 'unpaid';
        if (status === undefined) delete s.status; else s.status = status;
        assert.equal((await signedWebhook('evt_unsuccessful', type, s)).status, 200);
        assert.equal(kind === 'ticket' ? fake.state.order.status : fake.state.payments[0].status, expected);
        assert.equal(fake.state.charge.status, 'pending');
      });
    }
  });

  test(`${kind}: fallo o expiración contradictorios no liberan la operación`, async t => {
    await withWebhook(t, async fake => {
      for (const type of ['checkout.session.expired', 'checkout.session.async_payment_failed']) {
        for (const [label, change] of [
          ['referencia incorrecta', s => { s.client_reference_id = 'wrong'; s.payment_status = 'unpaid'; }],
          ['modo incorrecto', s => { s.mode = 'subscription'; s.payment_status = 'unpaid'; }],
          ['pago contradictorio', () => {}],
        ]) {
          const s = session(kind); change(s);
          const before = structuredClone(fake.state);
          assert.equal((await signedWebhook(`evt_${type}_${label}`, type, s)).status, 500, label);
          assertUnchanged(fake, before, label);
        }
      }
    });
  });

  test(`${kind}: webhook de pago antes de guardar la sesión se vincula por el ID originario`, async t => {
    await withWebhook(t, async fake => {
      if (kind === 'ticket') fake.state.order.stripe_session_id = null;
      else fake.state.payments[0].stripe_session_id = null;
      assert.equal((await signedWebhook('evt_early', 'checkout.session.completed', session(kind))).status, 200);
      assert.equal(kind === 'ticket' ? fake.state.order.status : fake.state.charge.status, 'paid');
      assert.equal(fake.state.payments.find(p => p.stripe_session_id === `cs_test_${kind}`).status, 'paid');
    });
  });

  test(`${kind}: checkout completo sin pago todavía no acredita`, async t => {
    await withWebhook(t, async fake => {
      const s = session(kind); s.payment_status = 'unpaid';
      assert.equal((await signedWebhook('evt_unpaid', 'checkout.session.completed', s)).status, 200);
      assert.equal(kind === 'ticket' ? fake.state.order.status : fake.state.charge.status, 'pending');
      assert.equal(fake.state.payments.filter(p => p.status === 'paid').length, 0);
      s.payment_status = 'paid';
      assert.equal((await signedWebhook('evt_paid', 'checkout.session.async_payment_succeeded', s)).status, 200);
      assert.equal(kind === 'ticket' ? fake.state.order.status : fake.state.charge.status, 'paid');
    });
  });

  test(`${kind}: importe o moneda incompatibles quedan en revisión sin acreditar`, async t => {
    for (const change of [s => { s.amount_total = 999; }, s => { s.currency = 'usd'; }]) {
      await withWebhook(t, async fake => {
        const s = session(kind); change(s);
        assert.equal((await signedWebhook('evt_mismatch', 'checkout.session.completed', s)).status, 200);
        assert.equal(kind === 'ticket' ? fake.state.order.status : fake.state.charge.status, kind === 'ticket' ? 'needs_review' : 'pending');
        const record = fake.state.payments.find(p => p.stripe_session_id === s.id);
        assert.equal(record.status, 'needs_review');
        assert.equal(fake.state.payments.filter(p => p.status === 'paid').length, 0);
      });
    }
  });
}

test('un pago de entradas tardío queda en revisión, no acredita entradas', async t => {
  await withWebhook(t, async fake => {
    fake.state.order.live_reservation = 0;
    assert.equal((await signedWebhook('evt_late', 'checkout.session.completed', session('ticket'))).status, 200);
    assert.equal(fake.state.order.status, 'needs_review');
    assert.equal(fake.state.payments.find(p => p.ticket_order_id === 29).status, 'needs_review');
  });
});

test('una clave de producción bloquea incluso el webhook sintético antes de acceder a la base', async t => {
  await withWebhook(t, async fake => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_do_not_use';
    const result = await signedWebhook('evt_blocked', 'checkout.session.completed', session('ticket'));
    assert.equal(result.status, 503);
    assert.match(result.body.error, /cobros reales están deshabilitados hasta completar la conciliación/i);
    assert.deepEqual(fake.state.events, []);
    assert.equal(fake.state.order.status, 'pending');
  });
});

test.after(async () => { await db.end(); });
