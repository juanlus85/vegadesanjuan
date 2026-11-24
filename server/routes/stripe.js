import { Router } from 'express';
import db from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { HttpError, madridDateTime, positiveId, route, sendError, stripeConfig, stripeId, transaction } from '../lib/stripe.js';
import { SUBSCRIPTION_CONSENT_TEXT, SUBSCRIPTION_CONSENT_VERSION, nextTrialEnd, subscriptionCheckoutParams, annualInvoiceYear } from '../lib/subscriptions.js';

const router = Router();
const MAX_STRIPE_AMOUNT = 99999999;
// No retirar hasta integrar el bloqueo familiar en el registro de pago manual,
// desplegar la migración y probar TODOS los casos de concurrencia y webhooks.
const SUBSCRIPTIONS_READY = false;

function familyId(req) {
  if (!req.session.familyId) throw new HttpError(403, 'No tienes una unidad familiar asociada.');
  return positiveId(req.session.familyId);
}

async function familyLock(conn, family) {
  const [rows] = await conn.execute('SELECT * FROM families WHERE id = ? FOR UPDATE', [family]);
  if (!rows[0]) throw new HttpError(404, 'La unidad familiar no existe.');
  return rows[0];
}

async function chargeLock(conn, id) {
  const [rows] = await conn.execute("SELECT *, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date_iso FROM charges WHERE id = ? FOR UPDATE", [id]);
  return rows[0];
}

function validCharge(charge, timestamp = Date.now()) {
  if (charge.kind !== 'annual') return charge.kind === 'extra';
  const year = Number(charge.year);
  return Number.isInteger(year) && year >= 2027 && Number(charge.amount_cents) === 2000 &&
    charge.due_date_iso === `${year}-01-01` && madridDateTime(new Date(timestamp)).slice(0, 10) >= charge.due_date_iso;
}

function exactAnnualInvoice(invoice, charge) {
  const subscription = stripeId(invoice.subscription) || stripeId(invoice.parent?.subscription_details?.subscription);
  return annualInvoiceYear(invoice, subscription) === Number(charge.year);
}

export function validateSubscriptionConsent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.consent !== true) {
    throw new HttpError(400, 'Debes autorizar expresamente el cobro anual mediante la casilla de consentimiento.');
  }
  if (body.consentVersion !== SUBSCRIPTION_CONSENT_VERSION) {
    throw new HttpError(400, 'El texto de consentimiento ha cambiado. Revísalo y vuelve a aceptarlo.');
  }
}

router.post('/member/charges/:id/checkout', requireUser, route(async (req, res) => {
  const id = positiveId(req.params.id);
  const family = familyId(req);
  const { stripe, origin } = stripeConfig();
  const state = await transaction(db, async conn => {
    const f = await familyLock(conn, family);
    if (f.status !== 'active') throw new HttpError(403, 'La unidad familiar debe estar activa.');
    const charge = await chargeLock(conn, id);
    if (!charge || Number(charge.family_id) !== family) throw new HttpError(404, 'Cuota o cargo no encontrado.');
    if (charge.kind === 'annual' && f.stripe_subscription_id) throw new HttpError(409, 'Esta familia tiene una suscripción Stripe asociada; consulta con administración antes de pagar otra vez.');
    if (charge.kind === 'annual') {
      // La tabla puede no existir antes de aplicar la migración adicional; en tal
      // caso no puede haber intentos de este sistema. Cualquier otro error falla cerrado.
      let attempts;
      try { [attempts] = await conn.execute('SELECT id FROM subscription_attempts WHERE family_id = ? FOR UPDATE', [family]); }
      catch (error) { if (error?.code !== 'ER_NO_SUCH_TABLE' || SUBSCRIPTIONS_READY) throw error; attempts = []; }
      if (attempts.length) throw new HttpError(409, 'Existe un intento de suscripción que debe revisar administración antes de pagar otra cuota anual.');
    }
    if (charge.status !== 'pending') throw new HttpError(409, 'Este cargo no está pendiente de pago.');
    if (!validCharge(charge)) throw new HttpError(409, 'Esta cuota anual no puede cobrarse: revisa su año, fecha o importe con administración.');
    const amount = Number(charge.amount_cents);
    if (!Number.isSafeInteger(amount) || amount < 50 || amount > MAX_STRIPE_AMOUNT) throw new HttpError(400, 'El importe no permite un pago con tarjeta.');
    const [pending] = await conn.execute("SELECT id, stripe_session_id, status FROM payments WHERE charge_id = ? AND provider = 'stripe' AND status IN ('pending', 'paid', 'needs_review') ORDER BY (status = 'needs_review') DESC, (status = 'paid') DESC, id DESC FOR UPDATE", [id]);
    if (pending.some(p => p.status !== 'pending')) throw new HttpError(409, 'Existe un pago que debe conciliar administración antes de volver a cobrar este cargo.');
    if (pending.length) return { existing: pending[0] };
    const [result] = await conn.execute("INSERT INTO payments (family_id, charge_id, amount_cents, provider, status) VALUES (?, ?, ?, 'stripe', 'pending')", [family, id, amount]);
    return { paymentId: Number(result.insertId), amount, description: charge.description };
  });
  if (state.existing) {
    if (!state.existing.stripe_session_id) throw new HttpError(409, 'Hay un intento de pago sin confirmar; administración debe conciliarlo antes de iniciar otro.');
    let existing;
    try { existing = await stripe.checkout.sessions.retrieve(state.existing.stripe_session_id); }
    catch { throw new HttpError(502, 'No se pudo comprobar el intento de pago anterior.'); }
    if (existing.status === 'open' && existing.url) return res.json({ ok: true, url: existing.url });
    throw new HttpError(409, 'Hay un intento pendiente de confirmación. Espera al webhook o consulta con administración.');
  }
  const meta = { kind: 'charge', payment_id: String(state.paymentId), charge_id: String(id), family_id: String(family) };
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment', payment_method_types: ['card'], expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
      client_reference_id: `charge-payment:${state.paymentId}`, metadata: meta, payment_intent_data: { metadata: meta },
      line_items: [{ price_data: { currency: 'eur', unit_amount: state.amount, product_data: { name: String(state.description).slice(0, 120) || 'Cuota de la asociación' } }, quantity: 1 }],
      success_url: `${origin}/socios/cuotas?checkout=return`, cancel_url: `${origin}/socios/cuotas?checkout=cancel`,
    }, { idempotencyKey: `charge-payment-${state.paymentId}` });
  } catch (error) {
    // No liberar una operación incierta: Stripe podría haberla recibido y enviará el webhook.
    console.error('No se pudo iniciar el pago de cuota:', error?.type || error?.code || 'desconocido');
    throw new HttpError(502, 'No se pudo iniciar el pago. Si no se confirma, administración deberá conciliar el intento antes de repetirlo.');
  }
  if (!session?.id || !session.url) throw new HttpError(502, 'Stripe no devolvió una sesión válida; administración debe conciliar el intento.');
  await db.execute('UPDATE payments SET stripe_session_id = COALESCE(stripe_session_id, ?) WHERE id = ? AND (stripe_session_id IS NULL OR stripe_session_id = ?)', [session.id, state.paymentId, session.id]);
  res.json({ ok: true, url: session.url });
}));

router.get('/member/card/status', requireUser, (_req, res) => {
  // No anunciar disponibilidad hasta aislar los datos de prueba: el webhook de
  // suscripción puede marcar cuotas y métodos de pago en la base operativa.
  // La bandera STRIPE_ENABLE_TEST_SUBSCRIPTIONS por sí sola no resuelve esto.
  res.set('Cache-Control', 'private, no-store');
  res.json({ ok: true, enabledTest: false, consentText: SUBSCRIPTION_CONSENT_TEXT, consentVersion: SUBSCRIPTION_CONSENT_VERSION });
});

router.post('/member/card/setup', requireUser, route(async (req, res) => {
  if (!SUBSCRIPTIONS_READY || process.env.STRIPE_ENABLE_TEST_SUBSCRIPTIONS !== 'true') {
    throw new HttpError(503, 'El cobro periódico con tarjeta aún no está disponible. No se ha registrado consentimiento ni se ha configurado ningún cobro.');
  }
  validateSubscriptionConsent(req.body);
  // El prefijo valida el formato, no demuestra que el endpoint sea de pruebas;
  // la comprobación livemode=false del webhook sigue siendo obligatoria.
  if (!/^whsec_[^\s]+$/.test(process.env.STRIPE_WEBHOOK_SECRET || '')) {
    throw new HttpError(503, 'El webhook de Stripe no está configurado correctamente.');
  }
  const family = familyId(req);
  const user = positiveId(req.session.userId);
  const { stripe, origin } = stripeConfig();
  const now = new Date();
  const trialEnd = nextTrialEnd(now);
  if (trialEnd == null) throw new HttpError(409, 'Faltan 72 horas o menos para el siguiente cobro. Espera a enero para activar la suscripción.');
  const currentYear = Number(madridDateTime(now).slice(0, 4));
  const expiresAt = Math.floor(now.getTime() / 1000) + 60 * 60;
  const state = await transaction(db, async conn => {
    const f = await familyLock(conn, family);
    if (f.status !== 'active') throw new HttpError(403, 'La unidad familiar debe estar activa.');
    const [users] = await conn.execute('SELECT id FROM users WHERE id = ? AND family_id = ? AND active = TRUE FOR UPDATE', [user, family]);
    if (!users.length) throw new HttpError(403, 'La cuenta no pertenece a esta familia.');
    const [attempts] = await conn.execute('SELECT * FROM subscription_attempts WHERE family_id = ? FOR UPDATE', [family]);
    if (attempts.length) return { existing: attempts[0] };
    if (f.stripe_subscription_id || f.stripe_customer_id) throw new HttpError(409, 'Hay datos de Stripe existentes; administración debe revisarlos antes de continuar.');
    if (currentYear >= 2027) {
      const [charges] = await conn.execute("SELECT *, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date_iso FROM charges WHERE family_id = ? AND year = ? FOR UPDATE", [family, currentYear]);
      const charge = charges[0];
      if (!charge || charge.kind !== 'annual' || charge.status !== 'paid' || !validCharge(charge, now.getTime())) {
        throw new HttpError(409, 'Antes de activar el cobro automático, debe estar abonada y registrada la cuota anual del año en curso.');
      }
      const [payments] = await conn.execute("SELECT id FROM payments WHERE charge_id = ? AND provider = 'stripe' AND status IN ('pending', 'needs_review') FOR UPDATE", [charge.id]);
      if (payments.length) throw new HttpError(409, 'Hay un intento de pago que administración debe conciliar antes de continuar.');
    }
    const [result] = await conn.execute(`INSERT INTO subscription_attempts
      (family_id, user_id, consent_version, consent_text, consented_at_utc, trial_end, session_expires_at, state, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, 'created', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [family, user, SUBSCRIPTION_CONSENT_VERSION, SUBSCRIPTION_CONSENT_TEXT, trialEnd, expiresAt]);
    return { id: Number(result.insertId) };
  });
  if (state.existing) {
    const a = state.existing;
    if (a.state !== 'open' || !a.stripe_session_id || Number(a.session_expires_at) <= Math.floor(Date.now() / 1000)) {
      throw new HttpError(409, 'Ya existe un intento o suscripción; administración debe revisar su estado antes de continuar.');
    }
    let existing;
    try { existing = await stripe.checkout.sessions.retrieve(a.stripe_session_id); }
    catch { throw new HttpError(502, 'No se pudo comprobar el intento existente; administración debe revisarlo.'); }
    if (existing.id === a.stripe_session_id && existing.mode === 'subscription' && existing.status === 'open' && existing.url &&
        existing.metadata?.attempt_id === String(a.id) && existing.metadata?.family_id === String(family) && existing.expires_at > Math.floor(Date.now() / 1000)) {
      return res.json({ ok: true, url: existing.url });
    }
    throw new HttpError(409, 'La sesión ya no está abierta; espera el webhook o consulta con administración.');
  }
  let session;
  try {
    session = await stripe.checkout.sessions.create(subscriptionCheckoutParams({ attemptId: state.id, familyId: family, trialEnd, expiresAt, origin }),
      { idempotencyKey: `annual-subscription-attempt-${state.id}`, maxNetworkRetries: 0 });
  } catch (error) {
    // No volver a llamar a create, tampoco pasadas 24 h; el resultado puede ser incierto.
    console.error('No se pudo iniciar la suscripción:', error?.type || error?.code || 'desconocido');
    throw new HttpError(502, 'El resultado del intento es incierto. Administración debe revisarlo; no inicies otra sesión.');
  }
  if (!session?.id || !session.url || session.mode !== 'subscription' || session.status !== 'open') {
    throw new HttpError(502, 'La sesión no pudo verificarse. Administración debe revisar el intento.');
  }
  // La respuesta de creación nunca asigna customer ni subscription a la familia.
  const [saved] = await db.execute(`UPDATE subscription_attempts SET stripe_session_id = ?, state = 'open', updated_at_utc = UTC_TIMESTAMP()
    WHERE id = ? AND state = 'created' AND (stripe_session_id IS NULL OR stripe_session_id = ?)`, [session.id, state.id, session.id]);
  if (saved.affectedRows !== 1) throw new HttpError(409, 'La sesión está en conciliación; espera al webhook o contacta con administración.');
  res.json({ ok: true, url: session.url });
}));

// Un único pago puede aparecer en eventos diferentes: sesión, PaymentIntent y factura.
// Las tres claves únicas del esquema, además del bloqueo de la familia, evitan duplicados.
async function paymentRow(conn, { id = null, session = null, intent = null, invoice = null }) {
  const conditions = [];
  const args = [];
  for (const [column, value] of [['id', id], ['stripe_session_id', session], ['stripe_payment_intent_id', intent], ['stripe_invoice_id', invoice]]) {
    if (value != null) { conditions.push(`${column} = ?`); args.push(value); }
  }
  if (!conditions.length) throw new Error('Pago sin identificador de conciliación');
  const [rows] = await conn.execute(`SELECT * FROM payments WHERE ${conditions.join(' OR ')} FOR UPDATE`, args);
  if (rows.length > 1) throw new Error('Identificadores Stripe asociados a pagos distintos');
  return rows[0] || null;
}

async function savePayment(conn, data) {
  const old = await paymentRow(conn, data);
  if (old && (old.provider !== 'stripe' || Number(old.family_id) !== data.family ||
    (data.order != null && old.ticket_order_id != null && Number(old.ticket_order_id) !== data.order) ||
    (data.charge != null && old.charge_id != null && Number(old.charge_id) !== data.charge) ||
    (data.order != null && old.charge_id != null) || (data.charge != null && old.ticket_order_id != null))) {
    throw new Error('Los identificadores del pago no coinciden');
  }
  if (old) {
    if ((old.stripe_session_id && data.session && old.stripe_session_id !== data.session) ||
        (old.stripe_payment_intent_id && data.intent && old.stripe_payment_intent_id !== data.intent) ||
        (old.stripe_invoice_id && data.invoice && old.stripe_invoice_id !== data.invoice)) {
      throw new Error('Conflicto de identificadores Stripe');
    }
    // Nunca rebajar un pago ya conciliado, y no resolver automáticamente un caso de revisión.
    const status = old.status === 'paid' ? 'paid' : old.status === 'needs_review' ? 'needs_review' : data.status;
    const storedAmount = old.status === 'paid' ? Number(old.amount_cents) : data.amount;
    const storedReference = old.status === 'paid' ? old.reference : data.reference;
    await conn.execute(`UPDATE payments SET stripe_session_id = COALESCE(stripe_session_id, ?),
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), stripe_invoice_id = COALESCE(stripe_invoice_id, ?),
      charge_id = COALESCE(charge_id, ?), ticket_order_id = COALESCE(ticket_order_id, ?),
      amount_cents = ?, status = ?, reference = ?, paid_at = CASE WHEN ? THEN COALESCE(paid_at, UTC_TIMESTAMP()) ELSE paid_at END
      WHERE id = ?`, [data.session, data.intent, data.invoice, data.charge, data.order, storedAmount, status,
      storedReference, data.received ? 1 : 0, old.id]);
    return { id: Number(old.id), status, existed: true, wasPaid: old.status === 'paid' };
  }
  const [result] = await conn.execute(`INSERT INTO payments
    (family_id, charge_id, ticket_order_id, amount_cents, provider, status, stripe_session_id, stripe_payment_intent_id, stripe_invoice_id, reference, paid_at)
    VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, CASE WHEN ? THEN UTC_TIMESTAMP() ELSE NULL END)`,
    [data.family, data.charge, data.order, data.amount, data.status, data.session, data.intent, data.invoice, data.reference, data.received ? 1 : 0]);
  return { id: Number(result.insertId), status: data.status, existed: false, wasPaid: false };
}

function amount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) throw new Error('Importe Stripe no representable');
  return value;
}
function metadataId(value) {
  try { return positiveId(value); } catch { throw new Error('Metadatos Stripe no válidos'); }
}
function chargeData(s) {
  return { family: metadataId(s.metadata?.family_id), charge: metadataId(s.metadata?.charge_id), payment: metadataId(s.metadata?.payment_id) };
}

function validateOneTimeCheckout(s, type, reference) {
  // También en los fallos y expiraciones la sesión debe corresponder al intento:
  // de lo contrario se podría liberar por error una reserva o un pago pendiente.
  if (typeof s.id !== 'string' || !s.id || s.mode !== 'payment' || s.client_reference_id !== reference) {
    throw new Error('La sesión de pago no corresponde al intento');
  }
  const unsuccessful = type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed';
  if (!unsuccessful && s.status !== 'complete') throw new Error('La sesión de pago no está completa');
  if (unsuccessful && s.payment_status === 'paid') throw new Error('El resultado del pago es contradictorio');
}

async function ticketCheckout(conn, s, type) {
  const orderId = metadataId(s.metadata?.order_id);
  const family = metadataId(s.metadata?.family_id);
  const eventId = metadataId(s.metadata?.event_id);
  validateOneTimeCheckout(s, type, `ticket:${orderId}`);
  // Mismo orden de bloqueos que la reserva: evento, familia, pedido.
  const [events] = await conn.execute('SELECT * FROM events WHERE id = ? FOR UPDATE', [eventId]);
  if (!events[0]) throw new Error('Evento de Stripe inexistente');
  const f = await familyLock(conn, family);
  const [orders] = await conn.execute('SELECT *, (expires_at > UTC_TIMESTAMP()) AS live_reservation FROM ticket_orders WHERE id = ? FOR UPDATE', [orderId]);
  const order = orders[0];
  if (!order || Number(order.family_id) !== family || Number(order.event_id) !== eventId || (order.stripe_session_id && order.stripe_session_id !== s.id)) {
    throw new Error('La sesión no corresponde al pedido');
  }
  await conn.execute('UPDATE ticket_orders SET stripe_session_id = COALESCE(stripe_session_id, ?) WHERE id = ?', [s.id, orderId]);
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    if (order.status === 'pending') await conn.execute("UPDATE ticket_orders SET status = ? WHERE id = ?", [type.endsWith('expired') ? 'expired' : 'cancelled', orderId]);
    return;
  }
  if (s.payment_status !== 'paid') return; // Una visita o un pago aún pendiente no acredita entradas.
  const intent = stripeId(s.payment_intent);
  if (!intent) throw new Error('La sesión pagada no tiene PaymentIntent');
  const paidAmount = amount(s.amount_total);
  const duplicate = await paymentRow(conn, { session: s.id, intent });
  let safe = order.status === 'pending' && Boolean(order.live_reservation) && f.status === 'active' &&
    s.currency === 'eur' && paidAmount === Number(order.amount_cents);
  if (safe) {
    const [limits] = await conn.execute('SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?', [family]);
    const [booked] = await conn.execute(`SELECT COALESCE(SUM(member_qty), 0) AS n FROM ticket_orders WHERE event_id = ? AND family_id = ?
      AND (status = 'paid' OR (status = 'pending' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())))`, [eventId, family]);
    if (Number(booked[0].n) > Number(limits[0].n)) safe = false;
  }
  const alreadySame = duplicate?.status === 'paid' && Number(duplicate.ticket_order_id) === orderId && order.status === 'paid';
  const record = await savePayment(conn, { family, charge: null, order: orderId, id: null, session: s.id, intent, invoice: null,
    amount: paidAmount, status: safe || alreadySame ? 'paid' : 'needs_review',
    reference: s.currency === 'eur' ? `Checkout ${s.id}` : `Revisar moneda ${s.currency || 'desconocida'}: ${s.id}`, received: true });
  if (!alreadySame) await conn.execute('UPDATE ticket_orders SET status = ? WHERE id = ?', [safe && record.status === 'paid' ? 'paid' : 'needs_review', orderId]);
}

async function chargeCheckout(conn, s, type) {
  const { family, charge: chargeId, payment } = chargeData(s);
  validateOneTimeCheckout(s, type, `charge-payment:${payment}`);
  const f = await familyLock(conn, family);
  const charge = await chargeLock(conn, chargeId);
  if (!charge || Number(charge.family_id) !== family) throw new Error('La sesión no corresponde al cargo');
  const existing = await paymentRow(conn, { id: payment, session: s.id });
  if (!existing || Number(existing.id) !== payment || Number(existing.family_id) !== family || Number(existing.charge_id) !== chargeId || existing.provider !== 'stripe' ||
      (existing.stripe_session_id && existing.stripe_session_id !== s.id)) throw new Error('La sesión no corresponde al intento de pago');
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    if (existing.status === 'pending') await conn.execute("UPDATE payments SET status = 'failed', stripe_session_id = COALESCE(stripe_session_id, ?) WHERE id = ?", [s.id, payment]);
    return;
  }
  if (s.payment_status !== 'paid') return;
  const intent = stripeId(s.payment_intent);
  if (!intent) throw new Error('La sesión pagada no tiene PaymentIntent');
  const paidAmount = amount(s.amount_total);
  const safe = charge.status === 'pending' && f.status === 'active' && s.currency === 'eur' &&
    paidAmount === Number(charge.amount_cents) && validCharge(charge, Number(s.created) * 1000);
  const same = existing.status === 'paid' && charge.status === 'paid';
  const record = await savePayment(conn, { family, charge: chargeId, order: null, id: payment, session: s.id, intent, invoice: null,
    amount: paidAmount, status: safe || same ? 'paid' : 'needs_review',
    reference: s.currency === 'eur' ? `Checkout ${s.id}` : `Revisar moneda ${s.currency || 'desconocida'}: ${s.id}`, received: true });
  if (safe && record.status === 'paid') await conn.execute("UPDATE charges SET status = 'paid', paid_at = UTC_TIMESTAMP(), paid_reference = ? WHERE id = ? AND status = 'pending'", [intent, chargeId]);
}

async function subscriptionAttemptLock(conn, family, attemptId) {
  const f = await familyLock(conn, family);
  const [rows] = await conn.execute('SELECT * FROM subscription_attempts WHERE id = ? AND family_id = ? FOR UPDATE', [attemptId, family]);
  if (!rows[0]) throw new Error('Intento de suscripción inexistente');
  return { f, a: rows[0] };
}

async function bindSubscription(conn, f, a, customer, subscription) {
  if (!customer || !subscription || (f.stripe_customer_id && f.stripe_customer_id !== customer) ||
      (f.stripe_subscription_id && f.stripe_subscription_id !== subscription) ||
      (a.stripe_customer_id && a.stripe_customer_id !== customer) ||
      (a.stripe_subscription_id && a.stripe_subscription_id !== subscription)) throw new Error('Identificadores de suscripción en conflicto');
  // Solo se llama desde handlers cuyo cuerpo fue autenticado mediante firma de Stripe.
  await conn.execute('UPDATE subscription_attempts SET stripe_customer_id = ?, stripe_subscription_id = ?, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?', [customer, subscription, a.id]);
  await conn.execute('UPDATE families SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?', [customer, subscription, f.id]);
}

async function subscriptionCheckout(conn, s, type) {
  const family = metadataId(s.metadata?.family_id), id = metadataId(s.metadata?.attempt_id);
  const { f, a } = await subscriptionAttemptLock(conn, family, id);
  if (s.mode !== 'subscription' || s.client_reference_id !== `subscription-attempt:${id}` || !s.id ||
      (a.stripe_session_id && a.stripe_session_id !== s.id)) throw new Error('Sesión de suscripción no corresponde al intento');
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    // Un evento tardío de expiración no puede deshacer una alta ya recibida.
    await conn.execute(`UPDATE subscription_attempts SET stripe_session_id = COALESCE(stripe_session_id, ?),
      state = CASE WHEN state IN ('created','open') THEN 'expired' ELSE state END, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?`, [s.id, id]);
    return;
  }
  if (s.status !== 'complete' || s.payment_method_collection !== 'always') throw new Error('Alta de suscripción incompleta');
  const customer = stripeId(s.customer), subscription = stripeId(s.subscription);
  await bindSubscription(conn, f, a, customer, subscription);
  const next = a.state === 'cancelled' ? 'cancelled' : (f.status !== 'active' || ['expired', 'needs_review'].includes(a.state)) ? 'needs_review' : 'completed';
  await conn.execute('UPDATE subscription_attempts SET stripe_session_id = COALESCE(stripe_session_id, ?), state = ?, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?', [s.id, next, id]);
  if (next === 'completed' && f.status === 'active') await conn.execute("UPDATE families SET payment_method = 'card' WHERE id = ?", [family]);
}

async function subscriptionInvoice(conn, invoice, type, metadata) {
  if (type === 'invoice.paid' && invoice.amount_paid === 0) return; // factura de prueba: nunca ingreso
  const family = metadataId(metadata.family_id), id = metadataId(metadata.attempt_id);
  const { f, a } = await subscriptionAttemptLock(conn, family, id);
  const customer = stripeId(invoice.customer);
  const subscription = stripeId(invoice.subscription) || stripeId(invoice.parent?.subscription_details?.subscription);
  // Si la factura llega antes del checkout, devolver error hace que Stripe la reenvíe.
  // No reconocer éxito hasta que la asociación provenga del webhook de Checkout.
  if (!customer || !subscription || !a.stripe_customer_id || !a.stripe_subscription_id ||
      a.stripe_customer_id !== customer || a.stripe_subscription_id !== subscription ||
      f.stripe_customer_id !== customer || f.stripe_subscription_id !== subscription) throw new Error('Factura aún sin asociación de suscripción verificada');
  const invoiceId = stripeId(invoice);
  if (!invoiceId) throw new Error('Factura Stripe sin identificador');
  const paid = type === 'invoice.paid';
  const paidAmount = amount(paid ? invoice.amount_paid : invoice.amount_due);
  const intent = paid ? stripeId(invoice.payment_intent) : null;
  const year = paid ? annualInvoiceYear(invoice, subscription) : null;
  const currentYear = Number(madridDateTime(new Date()).slice(0, 4));
  let charge = null;
  if (year && year <= currentYear) {
    const [rows] = await conn.execute("SELECT *, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date_iso FROM charges WHERE family_id = ? AND year = ? FOR UPDATE", [family, year]);
    charge = rows[0] || null;
    // El programador anual puede no haber arrancado aún cuando llega el webhook.
    // Solo crear el año presente, tras validar la factura completa; nunca inventar años históricos.
    if (!charge && year === currentYear && f.status === 'active' && a.state === 'completed' &&
        Number(a.trial_end) <= Number(invoice.lines.data[0].period.start) && Date.now() >= invoice.lines.data[0].period.start * 1000) {
      await conn.execute(`INSERT IGNORE INTO charges (family_id, kind, year, description, amount_cents, due_date, status)
        VALUES (?, 'annual', ?, ?, 2000, ?, 'pending')`, [family, year, `Cuota anual ${year}`, `${year}-01-01`]);
      const [created] = await conn.execute("SELECT *, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date_iso FROM charges WHERE family_id = ? AND year = ? FOR UPDATE", [family, year]);
      charge = created[0] || null;
    }
  }
  const previous = await paymentRow(conn, { invoice: invoiceId, intent });
  const same = previous?.status === 'paid' && previous.stripe_invoice_id === invoiceId && charge &&
    Number(previous.family_id) === family && Number(previous.charge_id) === Number(charge.id) && charge.status === 'paid';
  const safe = paid && year && charge && charge.status === 'pending' && f.status === 'active' && a.state === 'completed' &&
    Number(a.trial_end) <= Number(invoice.lines.data[0].period.start) && charge.kind === 'annual' &&
    validCharge(charge, Date.now()) && Number(charge.amount_cents) === 2000;
  const record = await savePayment(conn, { family, charge: charge ? Number(charge.id) : null, order: null, id: null, session: null,
    intent, invoice: invoiceId, amount: paidAmount, status: paid ? (safe || same ? 'paid' : 'needs_review') : 'failed',
    reference: `${paid && !safe && !same ? 'Revisar factura' : 'Factura'} ${invoiceId}; moneda ${invoice.currency || 'desconocida'}`, received: paid });
  if (safe && record.status === 'paid') await conn.execute("UPDATE charges SET status = 'paid', paid_at = UTC_TIMESTAMP(), paid_reference = ? WHERE id = ? AND status = 'pending'", [invoiceId, charge.id]);
}

async function invoiceEvent(conn, invoice, type, eventCreated) {
  const subscriptionMeta = invoice.parent?.subscription_details?.metadata || invoice.subscription_details?.metadata || {};
  if (subscriptionMeta.kind === 'annual_subscription') return subscriptionInvoice(conn, invoice, type, subscriptionMeta);
  const customer = stripeId(invoice.customer);
  const subscription = stripeId(invoice.subscription) || stripeId(invoice.parent?.subscription_details?.subscription);
  if (!customer && !subscription) return;
  // La factura de inicio de una prueba puede ser de cero euros y no es un ingreso
  // ni una cuota pagada, tampoco cuando Stripe emite invoice.paid para ella.
  if (type === 'invoice.paid' && invoice.amount_paid === 0) return;
  const [families] = await conn.execute(`SELECT * FROM families WHERE (stripe_customer_id = ? AND ? IS NOT NULL)
    OR (stripe_subscription_id = ? AND ? IS NOT NULL) FOR UPDATE`, [customer, customer, subscription, subscription]);
  if (families.length > 1) throw new Error('Cliente o suscripción Stripe asignado a varias familias');
  if (!families[0]) return; // Puede ser un cliente ajeno a esta aplicación.
  const f = families[0];
  const family = Number(f.id);
  // Si la versión del evento no trae el snapshot de metadata pero la familia ya
  // tiene la suscripción autenticada, conciliar por el intento persistente.
  // Sin asociación conocida no se adivina a qué familia corresponde.
  if (subscription) {
    let attempts;
    try { [attempts] = await conn.execute('SELECT * FROM subscription_attempts WHERE family_id = ? AND stripe_subscription_id = ? FOR UPDATE', [family, subscription]); }
    catch (error) { if (error?.code !== 'ER_NO_SUCH_TABLE' || SUBSCRIPTIONS_READY) throw error; attempts = []; }
    if (attempts.length) return subscriptionInvoice(conn, invoice, type,
      { kind: 'annual_subscription', family_id: String(family), attempt_id: String(attempts[0].id) });
  }
  const meta = invoice.metadata || {};
  const chargeValue = meta.charge_id || subscriptionMeta.charge_id;
  let charge = null;
  if (chargeValue) {
    charge = await chargeLock(conn, metadataId(chargeValue));
    if (!charge || Number(charge.family_id) !== family) throw new Error('Factura asociada a cargo de otra familia');
  }
  const paid = type === 'invoice.paid';
  const invoiceId = stripeId(invoice);
  if (!invoiceId) throw new Error('Factura Stripe sin identificador');
  // Cada reintento fallido de una factura puede tener otro PaymentIntent. Se
  // conserva solo el del pago final; la factura es la clave del intento fallido.
  const intent = paid ? stripeId(invoice.payment_intent) : null;
  const paidAmount = amount(paid ? invoice.amount_paid : invoice.amount_due);
  const paidAt = Number(invoice.status_transitions?.paid_at || eventCreated) * 1000;
  const safe = paid && charge && charge.kind === 'annual' && charge.status === 'pending' && f.status === 'active' &&
    subscription && f.stripe_subscription_id === subscription && f.stripe_customer_id === customer &&
    invoice.currency === 'eur' && paidAmount === Number(charge.amount_cents) && validCharge(charge, paidAt) &&
    exactAnnualInvoice(invoice, charge);
  const record = await savePayment(conn, { family, charge: charge ? Number(charge.id) : null, order: null, id: null, session: null,
    intent, invoice: invoiceId, amount: paidAmount, status: paid ? (safe ? 'paid' : 'needs_review') : 'failed',
    reference: `${paid && !safe ? 'Revisar factura' : 'Factura'} ${invoiceId}; moneda ${invoice.currency || 'desconocida'}`, received: paid });
  if (safe && record.status === 'paid') await conn.execute("UPDATE charges SET status = 'paid', paid_at = UTC_TIMESTAMP(), paid_reference = ? WHERE id = ? AND status = 'pending'", [invoiceId, charge.id]);
}

async function subscriptionDeleted(conn, subscription) {
  const id = stripeId(subscription);
  if (!id) return;
  if (subscription.metadata?.kind === 'annual_subscription') {
    const family = metadataId(subscription.metadata.family_id), attemptId = metadataId(subscription.metadata.attempt_id);
    const { f, a } = await subscriptionAttemptLock(conn, family, attemptId);
    await bindSubscription(conn, f, a, stripeId(subscription.customer), id);
    // Tombstone durable: un checkout.completed tardío no debe revivir la suscripción.
    await conn.execute("UPDATE subscription_attempts SET state = 'cancelled', updated_at_utc = UTC_TIMESTAMP() WHERE id = ?", [attemptId]);
    return;
  }
  const [families] = await conn.execute('SELECT * FROM families WHERE stripe_subscription_id = ? FOR UPDATE', [id]);
  if (families.length > 1) throw new Error('Suscripción asignada a varias familias');
  if (families[0]) await conn.execute("UPDATE families SET stripe_subscription_id = NULL, payment_method = 'manual' WHERE id = ? AND stripe_subscription_id = ?", [families[0].id, id]);
}

/** Montar con express.raw({type:'application/json'}) ANTES de express.json y antes del control de origen de la aplicación. */
export async function webhookHandler(req, res) {
  try {
    const { stripe, webhookSecret } = stripeConfig();
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'El webhook requiere el cuerpo original sin procesar.');
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret); }
    catch { throw new HttpError(400, 'Firma del webhook Stripe no válida.'); }
    if (!event?.id || !event.type || !event.data?.object) throw new HttpError(400, 'Evento Stripe no válido.');
    if (event.livemode !== false) throw new HttpError(503, 'Solo se admiten webhooks Stripe del entorno de pruebas.');
    await transaction(db, async conn => {
      try { await conn.execute('INSERT INTO stripe_events (event_id, event_type) VALUES (?, ?)', [event.id, event.type]); }
      catch (error) { if (error?.code === 'ER_DUP_ENTRY') return; throw error; }
      const s = event.data.object;
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) {
        if (s.metadata?.kind === 'ticket') await ticketCheckout(conn, s, event.type);
        else if (s.metadata?.kind === 'charge') await chargeCheckout(conn, s, event.type);
        else if (s.metadata?.kind === 'annual_subscription') await subscriptionCheckout(conn, s, event.type);
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
        await invoiceEvent(conn, s, event.type, event.created);
      } else if (event.type === 'customer.subscription.deleted') {
        await subscriptionDeleted(conn, s);
      }
    });
    res.json({ ok: true, received: true });
  } catch (error) { sendError(res, error); }
}

export default router;
