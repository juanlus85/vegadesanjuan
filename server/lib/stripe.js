import Stripe from 'stripe';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// No se toman URLs de redirección de Host ni de cabeceras suministradas por el cliente.
export function stripeConfig() {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawOrigin = process.env.APP_ORIGIN;
  if (secret && (!/^(?:sk|rk)_test_.+/.test(secret) || /\s/.test(secret))) {
    throw new HttpError(503, 'Los cobros reales están deshabilitados hasta completar la conciliación de reembolsos, disputas y pagos pendientes; solo se permiten claves Stripe de pruebas sk_test_ o rk_test_.');
  }
  if (!secret || !webhookSecret || !rawOrigin) {
    throw new HttpError(503, 'Stripe no está configurado; no se puede iniciar el pago.');
  }
  let url;
  try { url = new URL(rawOrigin); } catch { throw new HttpError(503, 'APP_ORIGIN no es válido.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin === 'null') {
    throw new HttpError(503, 'APP_ORIGIN debe ser un origen HTTPS explícito sin ruta.');
  }
  return { stripe: new Stripe(secret), webhookSecret, origin: url.origin };
}

export function positiveId(value) {
  const s = String(value ?? '');
  if (!/^[1-9]\d*$/.test(s)) throw new HttpError(400, 'Identificador no válido.');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, 'Identificador no válido.');
  return n;
}

export function integer(value, field, min = 0, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${field} no es válido.`);
  }
  return value;
}

export function bool(value, field) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} debe ser verdadero o falso.`);
  return value;
}

export function text(value, field, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new HttpError(400, `${field} no es válido.`);
  }
  return value.trim();
}

export function madridDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

export function madridDateTime(date = new Date()) {
  const p = madridDateParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function parseEventDate(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'La fecha del evento no es válida.');
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const [, y, m, d, h, min, s = '00'] = local;
    const test = new Date(`${y}-${m}-${d}T${h}:${min}:${s}Z`);
    if (!Number.isFinite(test.getTime()) || test.toISOString().slice(0, 19) !== `${y}-${m}-${d}T${h}:${min}:${s}`) {
      throw new HttpError(400, 'La fecha del evento no es válida.');
    }
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new HttpError(400, 'La fecha del evento no es válida.');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, 'La fecha del evento no es válida.');
  return madridDateTime(date);
}

export async function transaction(pool, fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* conservar el error original */ }
    throw error;
  } finally { connection.release(); }
}

export function sendError(res, error) {
  if (error instanceof HttpError) return res.status(error.status).json({ ok: false, error: error.message });
  // Evitar incluir secretos, payloads de Stripe o datos personales en los logs.
  console.error('Error de pagos/eventos:', error?.code || error?.type || error?.name || 'desconocido');
  return res.status(500).json({ ok: false, error: 'No se pudo completar la operación.' });
}

export function route(handler) {
  return async (req, res) => {
    try { await handler(req, res); } catch (error) { sendError(res, error); }
  };
}

export function stripeId(value) {
  return typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : null);
}
