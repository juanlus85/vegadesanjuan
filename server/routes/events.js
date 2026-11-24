import { Router } from 'express';
import db from '../lib/db.js';
import { requireUser, requireAdmin } from '../lib/auth.js';
import { HttpError, bool, integer, madridDateTime, parseEventDate, positiveId, route, stripeConfig, text, transaction } from '../lib/stripe.js';

const router = Router();
// El límite es el máximo representable por las columnas INT UNSIGNED, no un
// límite de invitados por familia. El aforo y Stripe pueden acotar la operación.
const MAX_QUANTITY = 4294967295;
const MAX_STRIPE_AMOUNT = 99999999;

function familyId(req) {
  if (!req.session.familyId) throw new HttpError(403, 'No tienes una unidad familiar asociada.');
  return positiveId(req.session.familyId);
}

async function lockFamily(conn, id) {
  const [rows] = await conn.execute('SELECT id, status FROM families WHERE id = ? FOR UPDATE', [id]);
  if (!rows[0]) throw new HttpError(403, 'La unidad familiar no existe.');
  if (rows[0].status !== 'active') throw new HttpError(403, 'La unidad familiar debe estar activa.');
}

async function lockEvent(conn, id, requireAvailable = true) {
  const [rows] = await conn.execute('SELECT *, (starts_at > ?) AS upcoming FROM events WHERE id = ? FOR UPDATE', [madridDateTime(), id]);
  const event = rows[0];
  if (!event || (requireAvailable && !event.published)) throw new HttpError(404, 'Evento no encontrado.');
  if (requireAvailable && !event.upcoming) throw new HttpError(409, 'El evento ya ha comenzado.');
  return event;
}

function eventFields(body, creating) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Datos del evento no válidos.');
  const fields = {};
  const has = key => Object.hasOwn(body, key);
  if (creating || has('title')) fields.title = text(body.title, 'El título', 255, true);
  if (creating || has('description')) fields.description = text(body.description ?? '', 'La descripción', 65535);
  if (creating || has('startsAt')) fields.starts_at = parseEventDate(body.startsAt);
  if (creating || has('location')) fields.location = text(body.location ?? '', 'El lugar', 255);
  if (creating || has('published')) fields.published = bool(body.published ?? false, 'published') ? 1 : 0;
  if (creating || has('ticketsEnabled')) fields.tickets_enabled = bool(body.ticketsEnabled ?? false, 'ticketsEnabled') ? 1 : 0;
  if (creating || has('memberPriceCents')) fields.member_price_cents = integer(body.memberPriceCents ?? 250, 'El precio de socio', 0, MAX_STRIPE_AMOUNT);
  if (creating || has('guestPriceCents')) fields.guest_price_cents = integer(body.guestPriceCents ?? 400, 'El precio de invitado', 0, MAX_STRIPE_AMOUNT);
  if (creating || has('priceConfirmed')) fields.price_confirmed = bool(body.priceConfirmed ?? false, 'priceConfirmed') ? 1 : 0;
  if (has('capacity')) fields.capacity = body.capacity === null ? null : integer(body.capacity, 'El aforo', 1, MAX_QUANTITY);
  if (!creating && (has('memberPriceCents') || has('guestPriceCents')) && !has('priceConfirmed')) fields.price_confirmed = 0;
  return fields;
}

router.get('/member/events', requireUser, route(async (req, res) => {
  const family = familyId(req);
  const [families] = await db.execute('SELECT status FROM families WHERE id = ?', [family]);
  if (!families[0]) throw new HttpError(403, 'La unidad familiar no existe.');
  const [rows] = await db.execute(`
    SELECT e.*, DATE_FORMAT(e.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at, COALESCE(r.attending, 0) AS rsvp,
      (SELECT COUNT(*) FROM family_members fm WHERE fm.family_id = ?) AS memberLimit,
      COALESCE((SELECT SUM(t.member_qty) FROM ticket_orders t WHERE t.event_id = e.id AND t.family_id = ?
        AND (t.status = 'paid' OR (t.status = 'pending' AND (t.expires_at IS NULL OR t.expires_at > UTC_TIMESTAMP())))), 0) AS memberBooked
    FROM events e LEFT JOIN event_rsvps r ON r.event_id = e.id AND r.family_id = ?
    WHERE e.published = 1 ORDER BY e.starts_at ASC, e.id ASC`, [family, family, family]);
  const events = rows.map(e => ({ ...e, rsvp: Boolean(e.rsvp), memberLimit: Number(e.memberLimit), memberBooked: Number(e.memberBooked) }));
  res.json({ ok: true, events });
}));

router.post('/member/events/:id/rsvp', requireUser, route(async (req, res) => {
  const id = positiveId(req.params.id);
  const family = familyId(req);
  const attending = bool(req.body?.attending, 'attending');
  await transaction(db, async conn => {
    await lockEvent(conn, id);
    await lockFamily(conn, family);
    await conn.execute(`INSERT INTO event_rsvps (event_id, family_id, attending) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE attending = VALUES(attending)`, [id, family, attending ? 1 : 0]);
  });
  res.json({ ok: true });
}));

router.post('/member/events/:id/checkout', requireUser, route(async (req, res) => {
  const id = positiveId(req.params.id);
  const family = familyId(req);
  const memberQty = integer(req.body?.memberQty, 'La cantidad de socios', 0, MAX_QUANTITY);
  const guestQty = integer(req.body?.guestQty, 'La cantidad de invitados', 0, MAX_QUANTITY);
  if (memberQty + guestQty === 0) throw new HttpError(400, 'Selecciona al menos una entrada.');
  const { stripe, origin } = stripeConfig();
  // Tiempo suficiente para cumplir el mínimo de Checkout de 30 minutos incluso con pequeña latencia.
  const expiry = Math.floor(Date.now() / 1000) + 35 * 60;
  const expiryUtc = new Date(expiry * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const order = await transaction(db, async conn => {
    // Todas las compras de un evento se serializan también por aforo.
    const event = await lockEvent(conn, id);
    await lockFamily(conn, family);
    if (!event.tickets_enabled) throw new HttpError(409, 'Este evento no tiene venta de entradas habilitada.');
    if (!event.price_confirmed) throw new HttpError(409, 'Los precios son provisionales y todavía no han sido confirmados por administración.');
    const [limits] = await conn.execute('SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?', [family]);
    const [familyOrders] = await conn.execute(`SELECT COALESCE(SUM(member_qty), 0) AS n FROM ticket_orders
      WHERE event_id = ? AND family_id = ? AND (status = 'paid' OR (status = 'pending' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())))`, [id, family]);
    if (memberQty > 0 && Number(familyOrders[0].n) + memberQty > Number(limits[0].n)) {
      throw new HttpError(409, 'Superas el número de entradas de socio disponibles para tu unidad familiar.');
    }
    if (event.capacity != null) {
      const [occupied] = await conn.execute(`SELECT COALESCE(SUM(member_qty + guest_qty), 0) AS n FROM ticket_orders
        WHERE event_id = ? AND (status = 'paid' OR (status = 'pending' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())))`, [id]);
      if (Number(occupied[0].n) + memberQty + guestQty > Number(event.capacity)) throw new HttpError(409, 'No quedan suficientes plazas.');
    }
    const amount = memberQty * Number(event.member_price_cents) + guestQty * Number(event.guest_price_cents);
    if (!Number.isSafeInteger(amount) || amount < 50 || amount > MAX_STRIPE_AMOUNT) {
      throw new HttpError(400, 'El importe no permite un pago con tarjeta; consulta con administración.');
    }
    const [result] = await conn.execute(`INSERT INTO ticket_orders
      (event_id, family_id, member_qty, guest_qty, amount_cents, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`, [id, family, memberQty, guestQty, amount, expiryUtc]);
    return { id: Number(result.insertId), amount, title: event.title };
  });
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment', payment_method_types: ['card'], expires_at: expiry,
      client_reference_id: `ticket:${order.id}`,
      metadata: { kind: 'ticket', order_id: String(order.id), event_id: String(id), family_id: String(family) },
      payment_intent_data: { metadata: { kind: 'ticket', order_id: String(order.id), event_id: String(id), family_id: String(family) } },
      line_items: [{ price_data: { currency: 'eur', unit_amount: order.amount, product_data: { name: `Entradas: ${order.title}`.slice(0, 120) } }, quantity: 1 }],
      success_url: `${origin}/socios/eventos?checkout=return`, cancel_url: `${origin}/socios/eventos?checkout=cancel`,
    }, { idempotencyKey: `ticket-order-${order.id}` });
  } catch (error) {
    // Si Stripe recibió la petición antes del fallo de red, puede llegar un webhook.
    // No liberamos la reserva anticipadamente ni afirmamos que no existió la sesión.
    console.error('No se pudo iniciar Stripe Checkout:', error?.type || error?.code || 'desconocido');
    throw new HttpError(502, 'No se pudo iniciar el pago. La reserva permanecerá bloqueada hasta su caducidad.');
  }
  if (!session?.id || !session.url) throw new HttpError(502, 'Stripe no devolvió una sesión de pago válida; la reserva caducará automáticamente.');
  await db.execute(`UPDATE ticket_orders SET stripe_session_id = COALESCE(stripe_session_id, ?) WHERE id = ? AND (stripe_session_id IS NULL OR stripe_session_id = ?)`, [session.id, order.id, session.id]);
  res.json({ ok: true, url: session.url });
}));

router.get('/admin/events', requireAdmin, route(async (_req, res) => {
  const [events] = await db.execute("SELECT e.*, DATE_FORMAT(e.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at FROM events e ORDER BY e.starts_at DESC, e.id DESC");
  res.json({ ok: true, events });
}));

router.post('/admin/events', requireAdmin, route(async (req, res) => {
  const fields = eventFields(req.body, true);
  const keys = Object.keys(fields);
  const [result] = await db.execute(`INSERT INTO events (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, Object.values(fields));
  res.status(201).json({ ok: true, id: Number(result.insertId) });
}));

router.put('/admin/events/:id', requireAdmin, route(async (req, res) => {
  const id = positiveId(req.params.id);
  const fields = eventFields(req.body, false);
  const keys = Object.keys(fields);
  if (!keys.length) throw new HttpError(400, 'No hay campos del evento para actualizar.');
  await transaction(db, async conn => {
    await lockEvent(conn, id, false);
    if (fields.capacity != null) {
      const [occupied] = await conn.execute(`SELECT COALESCE(SUM(member_qty + guest_qty), 0) AS n FROM ticket_orders
        WHERE event_id = ? AND (status = 'paid' OR (status = 'pending' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())))`, [id]);
      if (Number(occupied[0].n) > fields.capacity) throw new HttpError(409, 'El aforo es inferior a las plazas pagadas o reservadas.');
    }
    await conn.execute(`UPDATE events SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
  });
  res.json({ ok: true });
}));

router.get('/admin/events/:id/attendees', requireAdmin, route(async (req, res) => {
  const id = positiveId(req.params.id);
  const [events] = await db.execute('SELECT id FROM events WHERE id = ?', [id]);
  if (!events[0]) throw new HttpError(404, 'Evento no encontrado.');
  const [rsvps] = await db.execute(`SELECT r.*, f.address, f.phone,
    (SELECT GROUP_CONCAT(u.name SEPARATOR ', ') FROM users u WHERE u.family_id = f.id) AS family_users
    FROM event_rsvps r JOIN families f ON f.id = r.family_id WHERE r.event_id = ? ORDER BY r.created_at DESC`, [id]);
  const [orders] = await db.execute(`SELECT t.*, f.address, f.phone,
    (SELECT GROUP_CONCAT(u.name SEPARATOR ', ') FROM users u WHERE u.family_id = f.id) AS family_users
    FROM ticket_orders t JOIN families f ON f.id = t.family_id WHERE t.event_id = ? ORDER BY t.created_at DESC`, [id]);
  res.json({ ok: true, rsvps, orders });
}));

export default router;
