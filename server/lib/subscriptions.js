// Helpers puros. No contienen credenciales ni efectúan llamadas a Stripe.
export const SUBSCRIPTION_CONSENT_VERSION = 'annual-card-v1';
export const SUBSCRIPTION_CONSENT_TEXT = 'Autorizo el cobro automático con tarjeta de 20 € por familia cada año, aproximadamente el 1 de enero a las 09:00 en horario de Madrid, hasta su cancelación. El año 2026 está exento. La cuota pendiente del año en curso debe abonarse antes de activar el cobro automático. Para cancelar, contactar con administración.';

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function localParts(date) {
  return Object.fromEntries(clock.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

// Busca la hora de Madrid sin depender de la zona horaria del servidor.
export function januaryAnchor(year) {
  if (!Number.isInteger(year) || year < 2027 || year > 9998) throw new RangeError('Año de suscripción no válido');
  const wall = Date.UTC(year, 0, 1, 9, 0, 0);
  let candidate = wall;
  for (let n = 0; n < 3; n++) {
    const p = localParts(new Date(candidate));
    candidate += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const p = localParts(new Date(candidate));
  if (p.year !== year || p.month !== 1 || p.day !== 1 || p.hour !== 9 || p.minute !== 0 || p.second !== 0) {
    throw new RangeError('No se puede determinar la hora de Madrid');
  }
  return candidate / 1000;
}

export function nextTrialEnd(now = new Date()) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('Fecha no válida');
  const year = localParts(now).year;
  let nextYear = Math.max(2027, year);
  let trialEnd = januaryAnchor(nextYear);
  if (trialEnd * 1000 <= nowMs) trialEnd = januaryAnchor(++nextYear);
  // Estrictamente más de 72 h: aun con un Checkout abierto se conserva margen sobre las 48 h exigidas por Stripe.
  if (trialEnd * 1000 - nowMs <= 72 * 60 * 60 * 1000) return null;
  return trialEnd;
}

export function subscriptionCheckoutParams({ attemptId, familyId, trialEnd, expiresAt, origin }) {
  if (![attemptId, familyId, trialEnd, expiresAt].every(Number.isSafeInteger) ||
      attemptId < 1 || familyId < 1 || trialEnd < 1 || expiresAt < 1) throw new RangeError('Intento no válido');
  const metadata = { kind: 'annual_subscription', attempt_id: String(attemptId), family_id: String(familyId) };
  return {
    mode: 'subscription', payment_method_types: ['card'], payment_method_collection: 'always',
    expires_at: expiresAt, client_reference_id: `subscription-attempt:${attemptId}`, metadata,
    subscription_data: { trial_end: trialEnd, metadata, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } },
    line_items: [{ price_data: { currency: 'eur', unit_amount: 2000, recurring: { interval: 'year', interval_count: 1 },
      product_data: { name: 'Cuota anual por familia' } }, quantity: 1 }],
    success_url: `${origin}/socios/cuotas?subscription=return`, cancel_url: `${origin}/socios/cuotas?subscription=cancel`,
  };
}

// Solo la estructura de la API Stripe 2025-01-27.acacia (stripe-node 17.6.0).
// Las versiones desconocidas, líneas truncadas, importes diferentes o prorrateos se revisan manualmente.
export function annualInvoiceYear(invoice, subscriptionId) {
  if (!invoice || invoice.status !== 'paid' || invoice.currency !== 'eur' || invoice.amount_paid !== 2000 ||
      invoice.amount_due !== 2000 || invoice.amount_remaining !== 0 || invoice.subtotal !== 2000 || invoice.total !== 2000 ||
      invoice.paid_out_of_band !== false || invoice.starting_balance !== 0 || invoice.ending_balance !== 0 ||
      !(typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id) ||
      !['subscription_cycle', 'subscription_create'].includes(invoice.billing_reason) ||
      !invoice.lines || invoice.lines.has_more !== false || !Array.isArray(invoice.lines.data) || invoice.lines.data.length !== 1) return null;
  const line = invoice.lines.data[0];
  const sub = typeof line?.subscription === 'string' ? line.subscription : line?.subscription?.id;
  const price = line?.price;
  if (!subscriptionId || sub !== subscriptionId || line.type !== 'subscription' || line.proration !== false || line.quantity !== 1 ||
      line.amount !== 2000 || line.currency !== 'eur' || price?.currency !== 'eur' || price.unit_amount !== 2000 ||
      price.recurring?.interval !== 'year' || price.recurring.interval_count !== 1 ||
      !Number.isSafeInteger(line.period?.start) || !Number.isSafeInteger(line.period?.end)) return null;
  const year = localParts(new Date(line.period.start * 1000)).year;
  if (year < 2027 || year > 9997) return null;
  if (line.period.start !== januaryAnchor(year) || line.period.end !== januaryAnchor(year + 1)) return null;
  return year;
}
