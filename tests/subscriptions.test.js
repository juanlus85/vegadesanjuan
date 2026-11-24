import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import express from 'express';
import Stripe from 'stripe';
import db from '../server/lib/db.js';
import router, { webhookHandler } from '../server/routes/stripe.js';
import { januaryAnchor, nextTrialEnd, subscriptionCheckoutParams, annualInvoiceYear, SUBSCRIPTION_CONSENT_TEXT, SUBSCRIPTION_CONSENT_VERSION } from '../server/lib/subscriptions.js';

function invoice(year = 2027) {
  return {
    id: 'in_test', status: 'paid', currency: 'eur', amount_paid: 2000, amount_due: 2000,
    amount_remaining: 0, subtotal: 2000, total: 2000, paid_out_of_band: false,
    starting_balance: 0, ending_balance: 0, payment_intent: 'pi_test', billing_reason: 'subscription_cycle',
    lines: { has_more: false, data: [{ type: 'subscription', subscription: 'sub_test', currency: 'eur',
      proration: false, quantity: 1, amount: 2000, price: { currency: 'eur', unit_amount: 2000,
        recurring: { interval: 'year', interval_count: 1 } }, period: { start: januaryAnchor(year), end: januaryAnchor(year + 1) } }] },
  };
}

test('el primer vencimiento no corresponde al año exento y es a las 09:00 Madrid', () => {
  assert.equal(januaryAnchor(2027), Date.parse('2027-01-01T08:00:00Z') / 1000);
  assert.equal(nextTrialEnd(new Date('2026-06-01T12:00:00Z')), januaryAnchor(2027));
  assert.throws(() => januaryAnchor(2026), RangeError);
  assert.equal(januaryAnchor(2028), Date.parse('2028-01-01T08:00:00Z') / 1000);
});

test('se exige estrictamente más de 72 horas, incluidas las horas iniciales del 1 de enero', () => {
  const t = januaryAnchor(2027) * 1000;
  assert.equal(nextTrialEnd(new Date(t - 72 * 3600_000 - 1)), januaryAnchor(2027));
  assert.equal(nextTrialEnd(new Date(t - 72 * 3600_000)), null);
  assert.equal(nextTrialEnd(new Date('2027-01-01T00:00:00Z')), null);
  assert.equal(nextTrialEnd(new Date('2027-01-01T08:00:00Z')), januaryAnchor(2028));
});

test('Checkout exige tarjeta y suscripción anual, sin cobro ni cargo único inicial', () => {
  const params = subscriptionCheckoutParams({ attemptId: 7, familyId: 15, trialEnd: januaryAnchor(2027), expiresAt: 1800000000, origin: 'https://example.org' });
  assert.equal(params.mode, 'subscription');
  assert.equal(params.payment_method_collection, 'always');
  assert.deepEqual(params.payment_method_types, ['card']);
  assert.equal(params.subscription_data.trial_end, januaryAnchor(2027));
  assert.equal(params.line_items.length, 1);
  assert.equal(params.line_items[0].price_data.unit_amount, 2000);
  assert.equal(params.line_items[0].price_data.currency, 'eur');
  assert.deepEqual(params.line_items[0].price_data.recurring, { interval: 'year', interval_count: 1 });
  assert.deepEqual(params.metadata, params.subscription_data.metadata);
  assert.equal(params.metadata.attempt_id, '7');
  assert.equal(params.metadata.family_id, '15');
  assert.equal(params.client_reference_id, 'subscription-attempt:7');
  assert.equal(SUBSCRIPTION_CONSENT_VERSION, 'annual-card-v1');
  assert.match(SUBSCRIPTION_CONSENT_TEXT, /20 €/);
  assert.match(SUBSCRIPTION_CONSENT_TEXT, /2026 está exento/);
});

test('solo la factura anual exacta determina el año', () => {
  assert.equal(annualInvoiceYear(invoice(), 'sub_test'), 2027);
  assert.equal(annualInvoiceYear(invoice(2028), 'sub_test'), 2028);
  assert.equal(annualInvoiceYear(invoice(), 'sub_other'), null);
});

for (const [label, change] of [
  ['factura de 0 euros', i => { i.amount_paid = 0; }],
  ['importe distinto', i => { i.amount_paid = 1999; }],
  ['moneda extranjera', i => { i.currency = 'usd'; }],
  ['pago fuera de Stripe', i => { i.paid_out_of_band = true; }],
  ['saldo de cliente', i => { i.starting_balance = -100; }],
  ['sin PaymentIntent', i => { i.payment_intent = null; }],
  ['periodo incompleto', i => { i.lines.data[0].period.end--; }],
  ['periodo con hora incorrecta', i => { i.lines.data[0].period.start++; }],
  ['prorrateo', i => { i.lines.data[0].proration = true; }],
  ['líneas truncadas', i => { i.lines.has_more = true; }],
  ['dos líneas', i => { i.lines.data.push({}); }],
  ['línea mensual', i => { i.lines.data[0].price.recurring.interval = 'month'; }],
  ['línea no recurrente', i => { i.lines.data[0].type = 'invoiceitem'; }],
  ['factura no pagada', i => { i.status = 'open'; }],
]) {
  test(`factura rechazada: ${label}`, () => {
    const i = invoice(); change(i); assert.equal(annualInvoiceYear(i, 'sub_test'), null);
  });
}

test('migración adicional idempotente y una fila por familia', async () => {
  const sql = await fs.readFile(new URL('../database/subscriptions.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS subscription_attempts/);
  assert.match(sql, /UNIQUE KEY uq_subscription_attempt_family \(family_id\)/);
  assert.match(sql, /UNIQUE KEY uq_subscription_attempt_session \(stripe_session_id\)/);
  assert.match(sql, /consent_text TEXT NOT NULL/);
});

test('el endpoint de alta permanece cerrado incluso con consentimiento verdadero', async () => {
  const original = db.execute;
  let calls = 0;
  db.execute = async (sql) => {
    calls++;
    assert.match(sql, /FROM users WHERE id/);
    return [[{ id: 1, family_id: 2, role: 'member', active: 1 }]];
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 1, familyId: 2, role: 'member' }; next(); });
  app.use(router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/member/card/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.match(body.error, /No se ha registrado consentimiento/);
    assert.equal(calls, 1); // solo autenticación; ninguna escritura ni acceso a Stripe
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.execute = original;
  }
});

test.after(async () => { await db.end(); });

function fakeWebhookDatabase() {
  let state = {
    events: [], payments: [],
    family: { id: 15, status: 'active', stripe_customer_id: null, stripe_subscription_id: null, payment_method: 'manual' },
    attempt: { id: 7, family_id: 15, state: 'open', stripe_session_id: 'cs_test', stripe_customer_id: null, stripe_subscription_id: null, trial_end: januaryAnchor(2027) },
    charge: { id: 99, family_id: 15, kind: 'annual', year: 2027, amount_cents: 2000, due_date_iso: '2027-01-01', status: 'pending' },
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
        if (state.events.includes(args[0])) { const e = new Error('duplicate'); e.code = 'ER_DUP_ENTRY'; throw e; }
        state.events.push(args[0]); return [{ affectedRows: 1 }];
      }
      if (s.startsWith('SELECT * FROM families WHERE id')) return [[state.family]];
      if (s.startsWith('SELECT * FROM families WHERE (stripe_customer_id')) {
        return [[(state.family.stripe_customer_id === args[0] && args[0]) ||
          (state.family.stripe_subscription_id === args[2] && args[2]) ? state.family : null].filter(Boolean)];
      }
      if (s.startsWith('SELECT * FROM subscription_attempts WHERE id')) return [[state.attempt]];
      if (s.startsWith('SELECT * FROM subscription_attempts WHERE family_id')) {
        return [[state.attempt.family_id === args[0] && state.attempt.stripe_subscription_id === args[1] ? state.attempt : null].filter(Boolean)];
      }
      if (s.startsWith('UPDATE subscription_attempts SET stripe_customer_id')) {
        state.attempt.stripe_customer_id = args[0]; state.attempt.stripe_subscription_id = args[1]; return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE families SET stripe_customer_id')) {
        state.family.stripe_customer_id = args[0]; state.family.stripe_subscription_id = args[1]; return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE subscription_attempts SET stripe_session_id') && s.includes('state = CASE')) {
        state.attempt.stripe_session_id ||= args[0];
        if (['created', 'open'].includes(state.attempt.state)) state.attempt.state = 'expired';
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE subscription_attempts SET stripe_session_id')) {
        state.attempt.stripe_session_id ||= args[0]; state.attempt.state = args[1]; return [{ affectedRows: 1 }];
      }
      if (s.startsWith("UPDATE subscription_attempts SET state = 'cancelled'")) {
        state.attempt.state = 'cancelled'; return [{ affectedRows: 1 }];
      }
      if (s.startsWith('UPDATE families SET payment_method')) { state.family.payment_method = 'card'; return [{ affectedRows: 1 }]; }
      if (s.startsWith('SELECT *, DATE_FORMAT(due_date') && s.includes('WHERE family_id = ? AND year = ?')) {
        return [[state.charge?.family_id === args[0] && state.charge.year === args[1] ? state.charge : null].filter(Boolean)];
      }
      if (s.startsWith('INSERT IGNORE INTO charges')) {
        state.charge ||= { id: 99, family_id: args[0], kind: 'annual', year: args[1], amount_cents: 2000, due_date_iso: args[3], status: 'pending' };
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith('SELECT * FROM payments WHERE')) {
        return [state.payments.filter(p => args.some(v => v && [p.stripe_invoice_id, p.stripe_payment_intent_id, p.stripe_session_id].includes(v)))];
      }
      if (s.startsWith('INSERT INTO payments')) {
        const [family, charge, order, amount, status, session, intent, inv, reference] = args;
        const row = { id: state.payments.length + 1, family_id: family, charge_id: charge, ticket_order_id: order,
          amount_cents: amount, provider: 'stripe', status, stripe_session_id: session, stripe_payment_intent_id: intent,
          stripe_invoice_id: inv, reference };
        state.payments.push(row); return [{ insertId: row.id }];
      }
      if (s.startsWith('UPDATE payments SET stripe_session_id')) {
        const [session, intent, inv, charge, order, amount, status, reference, , id] = args;
        const row = state.payments.find(p => p.id === id);
        row.stripe_session_id ||= session; row.stripe_payment_intent_id ||= intent; row.stripe_invoice_id ||= inv;
        row.charge_id ||= charge; row.ticket_order_id ||= order; row.amount_cents = amount; row.status = status; row.reference = reference;
        return [{ affectedRows: 1 }];
      }
      if (s.startsWith("UPDATE charges SET status = 'paid'")) { state.charge.status = 'paid'; return [{ affectedRows: 1 }]; }
      throw new Error(`Consulta inesperada en prueba: ${s}`);
    },
  };
  return { conn, get state() { return state; } };
}

const subMetadata = { kind: 'annual_subscription', attempt_id: '7', family_id: '15' };
const sessionEventObject = {
  id: 'cs_test', mode: 'subscription', status: 'complete', client_reference_id: 'subscription-attempt:7',
  metadata: subMetadata, customer: 'cus_test', subscription: 'sub_test', payment_method_collection: 'always',
};
async function signedWebhook(id, type, object) {
  const secret = 'whsec_local_fake_not_real';
  const payload = JSON.stringify({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
  const stripe = new Stripe('sk_test_local_fake_not_real');
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  let status = 200, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await webhookHandler({ body: Buffer.from(payload), get: () => signature }, res);
  return { status, body };
}

async function withWebhookMock(t, run) {
  const originalConnection = db.getConnection;
  const old = { ...process.env };
  const fake = fakeWebhookDatabase();
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-01T10:00:00Z') });
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_fake_not_real';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_fake_not_real';
  process.env.APP_ORIGIN = 'https://example.org';
  db.getConnection = async () => fake.conn;
  try { await run(fake); }
  finally {
    db.getConnection = originalConnection;
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'APP_ORIGIN']) {
      if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name];
    }
    t.mock.timers.reset();
  }
}

function recurringInvoice() {
  return { ...invoice(), customer: 'cus_test', subscription: 'sub_test', subscription_details: { metadata: subMetadata } };
}

test('webhook: prueba de cero, factura antes del alta, reintento y deduplicación por factura', async t => {
  await withWebhookMock(t, async fake => {
    const trial = { ...recurringInvoice(), id: 'in_trial', amount_paid: 0 };
    assert.equal((await signedWebhook('evt_trial', 'invoice.paid', trial)).status, 200);
    assert.equal(fake.state.payments.length, 0);
    assert.equal(fake.state.charge.status, 'pending');
    const due = recurringInvoice();
    assert.equal((await signedWebhook('evt_invoice_1', 'invoice.paid', due)).status, 500);
    assert.equal(fake.state.events.includes('evt_invoice_1'), false);
    assert.equal((await signedWebhook('evt_checkout', 'checkout.session.completed', sessionEventObject)).status, 200);
    assert.equal(fake.state.attempt.state, 'completed');
    assert.equal(fake.state.family.stripe_subscription_id, 'sub_test');
    assert.equal((await signedWebhook('evt_invoice_1', 'invoice.paid', due)).status, 200);
    assert.equal(fake.state.charge.status, 'paid');
    assert.equal(fake.state.payments.length, 1);
    assert.equal(fake.state.payments[0].status, 'paid');
    assert.equal((await signedWebhook('evt_invoice_2', 'invoice.paid', due)).status, 200);
    assert.equal(fake.state.payments.length, 1);
    assert.equal(fake.state.payments[0].status, 'paid');
  });
});

test('webhook: si la cuota ya estaba pagada se registra revisión y no otro pago aceptado', async t => {
  await withWebhookMock(t, async fake => {
    await signedWebhook('evt_checkout', 'checkout.session.completed', sessionEventObject);
    fake.state.charge.status = 'paid';
    assert.equal((await signedWebhook('evt_invoice_1', 'invoice.paid', recurringInvoice())).status, 200);
    assert.equal(fake.state.payments.length, 1);
    assert.equal(fake.state.payments[0].status, 'needs_review');
  });
});

test('webhook: una finalización posterior a la expiración queda para revisión', async t => {
  await withWebhookMock(t, async fake => {
    await signedWebhook('evt_expired', 'checkout.session.expired', { ...sessionEventObject, status: 'expired' });
    assert.equal(fake.state.attempt.state, 'expired');
    await signedWebhook('evt_checkout', 'checkout.session.completed', sessionEventObject);
    assert.equal(fake.state.attempt.state, 'needs_review');
    assert.equal((await signedWebhook('evt_invoice', 'invoice.paid', recurringInvoice())).status, 200);
    assert.equal(fake.state.charge.status, 'pending');
    assert.equal(fake.state.payments[0].status, 'needs_review');
  });
});

test('webhook: una baja previa a un checkout tardío no revive la suscripción', async t => {
  await withWebhookMock(t, async fake => {
    await signedWebhook('evt_deleted', 'customer.subscription.deleted', { id: 'sub_test', customer: 'cus_test', metadata: subMetadata });
    assert.equal(fake.state.attempt.state, 'cancelled');
    await signedWebhook('evt_checkout', 'checkout.session.completed', sessionEventObject);
    assert.equal(fake.state.attempt.state, 'cancelled');
    assert.equal(fake.state.family.payment_method, 'manual');
  });
});

test('webhook: factura sin metadata se concilia por suscripción ya autenticada', async t => {
  await withWebhookMock(t, async fake => {
    await signedWebhook('evt_checkout', 'checkout.session.completed', sessionEventObject);
    const item = recurringInvoice();
    delete item.subscription_details;
    assert.equal((await signedWebhook('evt_invoice_without_meta', 'invoice.paid', item)).status, 200);
    assert.equal(fake.state.charge.status, 'paid');
    assert.equal(fake.state.payments.length, 1);
  });
});

test('webhook: crea la cuota del año actual si el programador todavía no lo ha hecho', async t => {
  await withWebhookMock(t, async fake => {
    await signedWebhook('evt_checkout', 'checkout.session.completed', sessionEventObject);
    fake.state.charge = null;
    assert.equal((await signedWebhook('evt_invoice_first', 'invoice.paid', recurringInvoice())).status, 200);
    assert.equal(fake.state.charge.year, 2027);
    assert.equal(fake.state.charge.status, 'paid');
    assert.equal(fake.state.payments[0].status, 'paid');
  });
});

test('una firma de webhook incorrecta se rechaza antes de tocar la base', async t => {
  await withWebhookMock(t, async fake => {
    let status = 200;
    const res = { status(value) { status = value; return this; }, json() { return this; } };
    await webhookHandler({ body: Buffer.from('{}'), get: () => 'invalid' }, res);
    assert.equal(status, 400);
    assert.equal(fake.state.events.length, 0);
    assert.equal(fake.state.payments.length, 0);
  });
});
