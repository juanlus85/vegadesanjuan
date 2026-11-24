import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import db from '../lib/db.js';
import { checkOrigin, requireUser, requireAdmin } from '../lib/auth.js';
import { madridYear } from '../lib/annual.js';
import { EDITABLE_SETTINGS, PUBLIC_SETTINGS, getSettings, validateSetting, isEmail, mailConfigured, sendMail } from '../lib/mail.js';

const router = Router();
router.use(checkOrigin);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const limiter = (max, windowMs = 15 * 60 * 1000) => rateLimit({
  windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'Demasiados intentos. Vuelve a intentarlo más tarde.' }),
});
const loginLimit = limiter(12);
const registerLimit = limiter(6, 60 * 60 * 1000);
const contactLimit = limiter(8, 60 * 60 * 1000);
const resetLimit = limiter(6, 60 * 60 * 1000);
const dummyHash = bcrypt.hashSync('comparacion-sin-usuario-para-igualar-coste', 12);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new HttpError(400, message); };
const idOf = value => {
  if (!/^[1-9]\d*$/.test(String(value))) bad('Identificador no válido.');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) bad('Identificador no válido.');
  return id;
};
function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) bad('El cuerpo de la solicitud debe ser un objeto JSON.');
  return req.body;
}
function text(value, label, max, { required = true, multiline = false } = {}) {
  if (typeof value !== 'string') bad(`${label} no es válido.`);
  const result = value.trim();
  const forbidden = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
  if ((required && !result) || result.length > max || forbidden.test(result)) bad(`${label} no es válido.`);
  return result;
}
function emailOf(value) {
  const email = text(value, 'El correo', 254).toLowerCase();
  if (!isEmail(email)) bad('El correo no es válido.');
  return email;
}
function passwordOf(value) {
  if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 72 || /[\x00-\x1f\x7f]/.test(value)) bad('La contraseña debe tener al menos 8 caracteres y como máximo 72 bytes.');
  return value;
}
function centsOf(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100000000) bad('El importe debe indicarse en céntimos enteros positivos.');
  return value;
}
function dateOf(value, label = 'La fecha') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(`${label} no es válida.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '1000-01-01' || value > '9999-12-31') bad(`${label} no es válida.`);
  return value;
}
const familyRequired = req => {
  if (!req.session.familyId) throw new HttpError(403, 'Tu cuenta no tiene una familia asociada.');
  return idOf(req.session.familyId);
};
async function transaction(fn) {
  const conn = await db.getConnection();
  try { await conn.beginTransaction(); const value = await fn(conn); await conn.commit(); return value; }
  catch (error) { try { await conn.rollback(); } catch {} throw error; }
  finally { conn.release(); }
}
async function audit(conn, userId, action, type, id, details = null) {
  await conn.execute('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    [userId, action, type, String(id), details == null ? null : JSON.stringify(details)]);
}
function madridNow() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
}
async function createAnnualCharges(year, executor = db) {
  const currentYear = madridYear();
  if (!Number.isInteger(year) || year !== currentYear || year < 2026 || year > 9998) throw new HttpError(400, 'Solo pueden generarse cuotas del año en curso (desde 2026). Los años anteriores requieren revisión histórica.');
  const exempt = year === 2026;
  const [result] = await executor.execute(
    `INSERT IGNORE INTO charges (family_id, kind, year, description, amount_cents, due_date, status)
     SELECT f.id, 'annual', ?, ?, ?, ?, ? FROM families f
     WHERE f.status = 'active' AND f.created_at < ?`,
    [year, exempt ? 'Cuota anual 2026: exenta' : `Cuota anual ${year}`, exempt ? 0 : 2000,
      `${year}-01-01`, exempt ? 'exempt' : 'pending', `${year + 1}-01-01`]);
  return result.affectedRows;
}

// Caller holds the family row lock (or has just inserted that family).
// An inconsistent or missing current-year row must never look like being up to date.
async function ensureCurrentAnnualCharge(conn, familyId) {
  const year = madridYear();
  if (year < 2026) return;
  const exempt = year === 2026;
  await conn.execute(`INSERT INTO charges (family_id, kind, year, description, amount_cents, due_date, status)
    VALUES (?, 'annual', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
  [familyId, year, exempt ? 'Cuota anual 2026: exenta' : `Cuota anual ${year}`,
    exempt ? 0 : 2000, `${year}-01-01`, exempt ? 'exempt' : 'pending']);
  const [annual] = await conn.execute('SELECT kind, status, amount_cents FROM charges WHERE family_id = ? AND year = ? FOR UPDATE', [familyId, year]);
  const charge = annual[0];
  if (!charge || charge.kind !== 'annual' || (exempt
    ? charge.status !== 'exempt' || Number(charge.amount_cents) !== 0
    : !['pending', 'paid'].includes(charge.status) || Number(charge.amount_cents) !== 2000)) {
    throw new HttpError(409, 'No se puede confirmar la cuota actual; administración debe revisar el registro.');
  }
}

async function startSession(req, user) {
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = Number(user.id);
  req.session.familyId = user.family_id == null ? null : Number(user.family_id);
  req.session.role = user.role;
  await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}
async function sessionProfile(userId) {
  const [users] = await db.execute('SELECT id, name, email, role, family_id FROM users WHERE id = ? AND active = TRUE', [userId]);
  if (!users.length) return { user: null, family: null };
  const u = users[0];
  let family = null;
  if (u.family_id != null) {
    const [rows] = await db.execute('SELECT id, address, phone, status, payment_method, created_at, updated_at FROM families WHERE id = ?', [u.family_id]);
    family = rows[0] || null;
  }
  return { user: { id: Number(u.id), name: u.name, email: u.email, role: u.role, familyId: u.family_id == null ? null : Number(u.family_id) }, family };
}

router.post('/auth/register', registerLimit, wrap(async (req, res) => {
  const data = body(req);
  if (data.privacyAccepted !== true) bad('Debes aceptar expresamente la política de privacidad.');
  const name = text(data.name, 'El nombre', 160), email = emailOf(data.email), password = passwordOf(data.password);
  const address = text(data.address, 'La dirección', 255), phone = text(data.phone ?? '', 'El teléfono', 40, { required: false });
  if (data.members != null && (!Array.isArray(data.members) || data.members.length > 99)) bad('La lista de familiares no es válida.');
  const members = (data.members || []).map(member => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) bad('Los datos de un familiar no son válidos.');
    return { name: text(member.name, 'El nombre del familiar', 160), relationship: text(member.relationship ?? '', 'El parentesco', 80, { required: false }) };
  });
  const hash = await bcrypt.hash(password, 12);
  const user = await transaction(async conn => {
    const [f] = await conn.execute("INSERT INTO families (address, phone, status, created_at) VALUES (?, ?, 'pending', ?)", [address, phone, madridNow()]);
    const [u] = await conn.execute("INSERT INTO users (family_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'member')", [f.insertId, name, email, hash]);
    await conn.execute("INSERT INTO family_members (family_id, name, relationship) VALUES (?, ?, 'Titular')", [f.insertId, name]);
    for (const member of members) await conn.execute('INSERT INTO family_members (family_id, name, relationship) VALUES (?, ?, ?)', [f.insertId, member.name, member.relationship]);
    await audit(conn, u.insertId, 'privacy_consent', 'user', u.insertId, { accepted: true, source: 'registration' });
    await audit(conn, u.insertId, 'register', 'family', f.insertId);
    return { id: u.insertId, family_id: f.insertId, role: 'member' };
  });
  await startSession(req, user);
  return res.status(201).json({ ok: true, ...await sessionProfile(user.id) });
}));

router.post('/auth/login', loginLimit, wrap(async (req, res) => {
  const data = body(req), email = emailOf(data.email);
  if (typeof data.password !== 'string' || Buffer.byteLength(data.password) > 72) bad('Las credenciales no son válidas.');
  const [rows] = await db.execute('SELECT id, family_id, password_hash, role, active FROM users WHERE email = ? LIMIT 1', [email]);
  const user = rows[0];
  const matches = await bcrypt.compare(data.password, user?.password_hash || dummyHash);
  if (!user || !matches || !user.active) return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos.' });
  await startSession(req, user);
  return res.json({ ok: true, ...await sessionProfile(user.id) });
}));
router.post('/auth/logout', wrap(async (req, res) => {
  if (req.session) await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  res.clearCookie('vega.sid', { path: '/', httpOnly: true, secure: (process.env.APP_ORIGIN || '').startsWith('https:'), sameSite: (process.env.APP_ORIGIN || '').startsWith('https:') ? 'none' : 'lax' });
  res.json({ ok: true });
}));
router.get('/auth/me', wrap(async (req, res) => {
  if (!req.session?.userId) return res.json({ ok: true, user: null, family: null });
  const profile = await sessionProfile(req.session.userId);
  if (!profile.user) { req.session.destroy(() => {}); return res.json({ ok: true, user: null, family: null }); }
  req.session.role = profile.user.role; req.session.familyId = profile.user.familyId;
  res.json({ ok: true, ...profile });
}));

router.post('/auth/forgot-password', resetLimit, wrap(async (req, res) => {
  const email = emailOf(body(req).email);
  const settings = await getSettings();
  if (!mailConfigured(settings, false)) throw new HttpError(503, 'El correo de recuperación no está configurado.');
  const [rows] = await db.execute('SELECT id FROM users WHERE email = ? AND active = TRUE', [email]);
  if (rows.length) {
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    await transaction(async conn => {
      await conn.execute('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [rows[0].id]);
      await conn.execute('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))', [rows[0].id, hash]);
    });
    const link = new URL('/acceso', process.env.APP_ORIGIN);
    link.searchParams.set('reset', token);
    try { await sendMail({ to: email, subject: 'Recuperación de contraseña', text: `Para crear una contraseña nueva, abre este enlace durante los próximos 30 minutos:\n\n${link.href}\n\nSi no has solicitado este cambio, ignora este mensaje.`, settings }); }
    catch {
      await db.execute('UPDATE password_resets SET used_at = NOW() WHERE token_hash = ?', [hash]);
      // Avoid revealing which addresses exist while not reporting that an email was delivered.
      return res.status(202).json({ ok: true, message: 'Si la cuenta existe y el servicio de correo está disponible, se enviarán instrucciones.' });
    }
  }
  res.status(202).json({ ok: true, message: 'Si la cuenta existe y el servicio de correo está disponible, se enviarán instrucciones.' });
}));
router.post('/auth/reset-password', resetLimit, wrap(async (req, res) => {
  const data = body(req), password = passwordOf(data.password);
  if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) bad('Enlace de recuperación no válido o caducado.');
  const tokenHash = createHash('sha256').update(data.token).digest('hex');
  const passwordHash = await bcrypt.hash(password, 12);
  await transaction(async conn => {
    const [rows] = await conn.execute('SELECT r.id, r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW() AND u.active = TRUE FOR UPDATE', [tokenHash]);
    if (!rows.length) throw new HttpError(400, 'Enlace de recuperación no válido o caducado.');
    await conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, rows[0].user_id]);
    await conn.execute('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [rows[0].user_id]);
    // express-mysql-session persists serialized JSON. Revoke every prior session.
    await conn.execute("DELETE FROM sessions WHERE JSON_VALID(data) AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) AS UNSIGNED) = ?", [rows[0].user_id]);
    await audit(conn, rows[0].user_id, 'password_reset', 'user', rows[0].user_id);
  });
  res.json({ ok: true, message: 'Contraseña actualizada. Inicia sesión de nuevo.' });
}));

router.get('/public/config', wrap(async (_req, res) => {
  const all = await getSettings(), settings = {};
  for (const key of PUBLIC_SETTINGS) if (all[key] != null) settings[key] = all[key];
  const [upcomingEvents] = await db.execute('SELECT id, title, description, starts_at, location, tickets_enabled, member_price_cents, guest_price_cents, price_confirmed FROM events WHERE published = TRUE AND starts_at >= ? ORDER BY starts_at ASC LIMIT 10', [madridNow()]);
  res.json({ ok: true, settings, upcomingEvents });
}));
router.post('/contact', contactLimit, wrap(async (req, res) => {
  const data = body(req), name = text(data.name, 'El nombre', 160), email = emailOf(data.email), message = text(data.message, 'El mensaje', 10000, { multiline: true });
  const [insert] = await db.execute("INSERT INTO contacts (name, email, message, delivery_status) VALUES (?, ?, ?, 'pending')", [name, email, message]);
  const settings = await getSettings();
  if (!mailConfigured(settings, true)) {
    await db.execute("UPDATE contacts SET delivery_status = 'failed' WHERE id = ?", [insert.insertId]);
    return res.status(503).json({ ok: false, error: 'El correo de contacto no está configurado; el mensaje ha quedado registrado, pero no se ha enviado.' });
  }
  const recipients = settings.contactRecipients.split(',').map(x => x.trim());
  // Persist the intended recipients before sending; missing migration fails before SMTP.
  await transaction(async conn => {
    for (const recipient of recipients) await conn.execute('INSERT INTO contact_deliveries (contact_id, recipient) VALUES (?, ?)', [insert.insertId, recipient]);
  });
  let deliveries;
  try {
    ({ deliveries } = await sendMail({ to: recipients, replyTo: email, subject: 'Nuevo mensaje de contacto', text: `Nombre: ${name}\nCorreo: ${email}\n\n${message}`, settings }));
  } catch (error) {
    deliveries = error.deliveries || recipients.map(recipient => ({ recipient, status: 'unknown' }));
  }
  const acceptedCount = deliveries.filter(item => item.status === 'accepted').length;
  const rejectedCount = deliveries.filter(item => item.status === 'rejected').length;
  const unknownCount = deliveries.filter(item => item.status === 'unknown').length;
  const deliveryStatus = acceptedCount === recipients.length ? 'sent' : acceptedCount ? 'partial' : unknownCount ? 'unknown' : 'failed';
  let recorded = true;
  try {
    await transaction(async conn => {
      for (const item of deliveries) await conn.execute('UPDATE contact_deliveries SET status = ?, recorded_at = CURRENT_TIMESTAMP WHERE contact_id = ? AND recipient = ?', [item.status, insert.insertId, item.recipient]);
      // The base schema has no partial state: sent means at least one accepted;
      // per-recipient rows are authoritative for the complete outcome.
      const baseStatus = acceptedCount ? 'sent' : unknownCount ? 'pending' : 'failed';
      await conn.execute('UPDATE contacts SET delivery_status = ? WHERE id = ?', [baseStatus, insert.insertId]);
    });
  } catch {
    recorded = false;
    console.error('No se pudo registrar el resultado SMTP del contacto; no se reenviará automáticamente.');
  }
  const counts = { deliveryStatus, acceptedCount, rejectedCount, unknownCount, recorded };
  if (acceptedCount) {
    const message = deliveryStatus === 'sent'
      ? 'El servidor SMTP ha aceptado el mensaje para todos los destinatarios; esto no confirma su entrega final.'
      : `El servidor SMTP ha aceptado el mensaje para ${acceptedCount} destinatario(s); ${rejectedCount} rechazado(s) y ${unknownCount} sin confirmar. No se reenviará automáticamente.`;
    return res.json({ ok: true, ...counts, message: recorded ? message : `${message} No se pudo registrar el resultado detallado.` });
  }
  return res.status(503).json({ ok: false, ...counts, error: unknownCount
    ? 'No se pudo confirmar la entrega a todos los destinatarios. El resultado es incierto; no reenvíes sin comprobarlo.'
    : 'El servidor SMTP rechazó a todos los destinatarios; no se ha enviado el mensaje.' });
}));

router.get('/member/summary', requireUser, wrap(async (req, res) => {
  const familyId = familyRequired(req);
  const summary = await transaction(async conn => {
    const [families] = await conn.execute('SELECT id, address, phone, status, payment_method, created_at, updated_at FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (!families.length) throw new HttpError(404, 'No se encontró la familia.');
    const [accounts] = await conn.execute('SELECT id FROM users WHERE id = ? AND family_id = ? AND active = TRUE FOR UPDATE', [req.session.userId, familyId]);
    if (!accounts.length) throw new HttpError(409, 'La familia de tu cuenta ha cambiado; actualiza la página.');
    if (families[0].status === 'active') await ensureCurrentAnnualCharge(conn, familyId);
    const [members] = await conn.execute('SELECT id, family_id, name, relationship, created_at FROM family_members WHERE family_id = ? ORDER BY id', [familyId]);
    const [charges] = await conn.execute('SELECT id, family_id, kind, year, description, amount_cents, due_date, status, paid_at, paid_reference, created_at FROM charges WHERE family_id = ? ORDER BY due_date DESC, id DESC', [familyId]);
    const [payments] = await conn.execute('SELECT id, family_id, charge_id, ticket_order_id, amount_cents, provider, status, reference, paid_at, created_at FROM payments WHERE family_id = ? ORDER BY created_at DESC, id DESC', [familyId]);
    const [historicalStanding] = await conn.execute('SELECT year, status, source, recorded_by AS recordedBy, recorded_at AS recordedAt FROM historical_standing WHERE family_id = ? ORDER BY year DESC', [familyId]);
    return { family: families[0], members, charges, payments, historicalStanding };
  });
  res.json({ ok: true, ...summary });
}));
router.put('/member/profile', requireUser, wrap(async (req, res) => {
  const data = body(req), familyId = familyRequired(req);
  const name = text(data.name, 'El nombre', 160), email = emailOf(data.email);
  const phone = text(data.phone ?? '', 'El teléfono', 40, { required: false }), address = text(data.address, 'La dirección', 255);
  await transaction(async conn => {
    const [user] = await conn.execute('SELECT name FROM users WHERE id = ? AND family_id = ? FOR UPDATE', [req.session.userId, familyId]);
    if (!user.length) throw new HttpError(404, 'No se encontró la cuenta.');
    await conn.execute('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, req.session.userId]);
    await conn.execute('UPDATE families SET phone = ?, address = ? WHERE id = ?', [phone, address, familyId]);
    // The registration-generated titular should track the account name, when unambiguous.
    await conn.execute("UPDATE family_members SET name = ? WHERE family_id = ? AND relationship = 'Titular' AND name = ?", [name, familyId, user[0].name]);
    await audit(conn, req.session.userId, 'profile_update', 'family', familyId);
  });
  res.json({ ok: true, ...await sessionProfile(req.session.userId) });
}));
router.post('/member/members', requireUser, wrap(async (req, res) => {
  const familyId = familyRequired(req), data = body(req);
  const name = text(data.name, 'El nombre', 160), relationship = text(data.relationship ?? '', 'El parentesco', 80, { required: false });
  const member = await transaction(async conn => {
    const [family] = await conn.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (!family.length) throw new HttpError(404, 'No se encontró la familia.');
    const [count] = await conn.execute('SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?', [familyId]);
    if (Number(count[0].n) >= 100) throw new HttpError(409, 'La familia ya ha alcanzado el máximo de personas.');
    const [insert] = await conn.execute('INSERT INTO family_members (family_id, name, relationship) VALUES (?, ?, ?)', [familyId, name, relationship]);
    await audit(conn, req.session.userId, 'member_add', 'family_member', insert.insertId, { familyId });
    return { id: insert.insertId, family_id: familyId, name, relationship };
  });
  res.status(201).json({ ok: true, member });
}));
router.delete('/member/members/:id', requireUser, wrap(async (req, res) => {
  const familyId = familyRequired(req), memberId = idOf(req.params.id);
  await transaction(async conn => {
    const [families] = await conn.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (!families.length) throw new HttpError(404, 'No se encontró la familia.');
    const [members] = await conn.execute('SELECT id, relationship FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE', [memberId, familyId]);
    if (!members.length) throw new HttpError(404, 'No se encontró ese familiar.');
    if (members[0].relationship === 'Titular') throw new HttpError(409, 'No se puede eliminar el titular desde esta pantalla.');
    const [counts] = await conn.execute('SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?', [familyId]);
    const remaining = Number(counts[0].n) - 1;
    if (remaining < 1) throw new HttpError(409, 'La familia debe conservar al menos una persona.');
    // The event service takes the family row lock too. Do not invalidate paid/reserved allocations.
    const [booked] = await conn.execute("SELECT event_id, SUM(member_qty) AS n FROM ticket_orders WHERE family_id = ? AND (status = 'paid' OR (status = 'pending' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP()))) GROUP BY event_id", [familyId]);
    if (booked.some(row => Number(row.n) > remaining)) throw new HttpError(409, 'No se puede eliminar: la familia tiene más entradas o reservas activas que personas restantes.');
    await conn.execute('DELETE FROM family_members WHERE id = ? AND family_id = ?', [memberId, familyId]);
    await audit(conn, req.session.userId, 'member_remove', 'family_member', memberId, { familyId });
  });
  res.json({ ok: true });
}));

router.get('/admin/overview', requireAdmin, wrap(async (_req, res) => {
  const [rows] = await db.query(`SELECT
    (SELECT COUNT(*) FROM families) AS families,
    (SELECT COUNT(*) FROM families WHERE status = 'pending') AS pendingFamilies,
    (SELECT COUNT(*) FROM families WHERE status = 'active') AS activeFamilies,
    (SELECT COUNT(*) FROM family_members) AS members,
    (SELECT COUNT(*) FROM charges WHERE status = 'pending') AS pendingCharges,
    (SELECT COALESCE(SUM(amount_cents), 0) FROM charges WHERE status = 'pending') AS pendingAmountCents,
    (SELECT COUNT(*) FROM events WHERE published = TRUE AND starts_at >= NOW()) AS upcomingEvents`);
  res.json({ ok: true, counts: rows[0] });
}));
router.get('/admin/families', requireAdmin, wrap(async (_req, res) => {
  const [families] = await db.query(`SELECT f.id, f.address, f.phone, f.status, f.payment_method, f.created_at, f.updated_at,
    u.id AS user_id, COALESCE(u.name, (SELECT fm2.name FROM family_members fm2 WHERE fm2.family_id = f.id ORDER BY fm2.id LIMIT 1)) AS name, u.email AS email,
    (SELECT COUNT(*) FROM family_members fm WHERE fm.family_id = f.id) AS member_count
    FROM families f LEFT JOIN users u ON u.id = (SELECT MIN(u2.id) FROM users u2 WHERE u2.family_id = f.id)
    ORDER BY f.created_at DESC, f.id DESC`);
  res.json({ ok: true, families });
}));
router.get('/admin/link-candidates', requireAdmin, wrap(async (_req, res) => {
  const [candidates] = await db.execute(`SELECT u.id AS userId, u.name AS userName, u.email, f.id AS familyId, f.address
    FROM users u JOIN families f ON f.id = u.family_id
    WHERE u.role = 'member' AND u.active = TRUE AND f.status = 'pending'
    ORDER BY f.id, u.id`);
  res.json({ ok: true, candidates });
}));

// Approval is the explicit POST itself. Addresses are never used to link accounts.
router.post('/admin/families/:id/link-user', requireAdmin, wrap(async (req, res) => {
  const destinationId = idOf(req.params.id), userId = idOf(body(req).userId);
  const result = await transaction(async conn => {
    // The initial lookup only discovers the order in which family rows must be locked.
    const [lookup] = await conn.execute('SELECT family_id FROM users WHERE id = ?', [userId]);
    if (!lookup.length || lookup[0].family_id == null) throw new HttpError(404, 'No se encontró una cuenta de socio con familia.');
    const sourceId = idOf(lookup[0].family_id);
    if (sourceId === destinationId) throw new HttpError(409, 'La cuenta ya pertenece a la familia de destino.');
    const locked = new Map();
    for (const id of [sourceId, destinationId].sort((a, b) => a - b)) {
      const [rows] = await conn.execute('SELECT id, status, stripe_customer_id, stripe_subscription_id FROM families WHERE id = ? FOR UPDATE', [id]);
      if (!rows.length) throw new HttpError(404, 'No se encontró una de las familias.');
      locked.set(id, rows[0]);
    }
    const [accounts] = await conn.execute('SELECT id, family_id, role, active FROM users WHERE id = ? FOR UPDATE', [userId]);
    const account = accounts[0];
    if (!account || !account.active || account.role !== 'member') throw new HttpError(409, 'Solo se pueden vincular cuentas activas de socio; las cuentas de administrador no se modifican.');
    if (Number(account.family_id) !== sourceId) throw new HttpError(409, 'La familia de origen ha cambiado; vuelve a revisar los candidatos.');
    const source = locked.get(sourceId);
    if (source.status !== 'pending') throw new HttpError(409, 'La familia de origen ya no está pendiente.');
    if (source.stripe_customer_id || source.stripe_subscription_id) throw new HttpError(409, 'La familia de origen tiene datos de tarjeta o suscripción; requiere revisión manual.');
    const [otherUsers] = await conn.execute('SELECT id FROM users WHERE family_id = ? AND id <> ? LIMIT 1 FOR UPDATE', [sourceId, userId]);
    if (otherUsers.length) throw new HttpError(409, 'La familia de origen tiene otras cuentas; requiere revisión manual antes de inactivarla.');
    for (const table of ['charges', 'payments', 'event_rsvps', 'ticket_orders']) {
      const [rows] = await conn.execute(`SELECT id FROM ${table} WHERE family_id = ? LIMIT 1 FOR UPDATE`, [sourceId]);
      if (rows.length) throw new HttpError(409, 'La familia de origen tiene movimientos financieros o inscripciones; requiere revisión manual.');
    }
    // Subscription support is an optional separately deployed migration.
    try {
      const [attempts] = await conn.execute('SELECT id FROM subscription_attempts WHERE family_id = ? LIMIT 1 FOR UPDATE', [sourceId]);
      if (attempts.length) throw new HttpError(409, 'La familia de origen tiene intentos de suscripción; requiere revisión manual.');
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }
    await conn.execute("UPDATE families SET status = 'inactive' WHERE id = ?", [sourceId]);
    const [updated] = await conn.execute("UPDATE users SET family_id = ? WHERE id = ? AND family_id = ? AND role = 'member' AND active = TRUE", [destinationId, userId, sourceId]);
    if (updated.affectedRows !== 1) throw new HttpError(409, 'La cuenta ha cambiado; vuelve a revisar los candidatos.');
    const details = { userId, sourceFamilyId: sourceId, destinationFamilyId: destinationId };
    await audit(conn, req.session.userId, 'user_unlinked_from_pending_family', 'family', sourceId, details);
    await audit(conn, req.session.userId, 'user_linked_to_family', 'family', destinationId, details);
    return details;
  });
  res.json({ ok: true, ...result, message: 'Cuenta vinculada; la familia anterior se ha conservado inactiva.' });
}));
// For an existing household whose records are being entered manually. This is not
// an account and conveys no login access or consent on behalf of the household.
router.post('/admin/families', requireAdmin, wrap(async (req, res) => {
  const data = body(req), name = text(data.name, 'El nombre', 160);
  const address = text(data.address, 'La dirección', 255);
  const phone = text(data.phone ?? '', 'El teléfono', 40, { required: false });
  const source = text(data.source, 'La fuente del registro', 255);
  const status = data.status ?? 'pending';
  if (!['pending', 'active', 'inactive'].includes(status)) bad('Estado no válido.');
  if (data.existingBefore2026 !== undefined && typeof data.existingBefore2026 !== 'boolean') bad('Indica si la familia es anterior a 2026.');
  if (data.members != null && (!Array.isArray(data.members) || data.members.length > 99)) bad('La lista de familiares no es válida.');
  const members = (data.members || []).map(member => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) bad('Los datos de un familiar no son válidos.');
    return { name: text(member.name, 'El nombre del familiar', 160), relationship: text(member.relationship ?? '', 'El parentesco', 80, { required: false }) };
  });
  const id = await transaction(async conn => {
    const [family] = await conn.execute('INSERT INTO families (address, phone, status, created_at) VALUES (?, ?, ?, ?)', [address, phone, status, madridNow()]);
    await conn.execute("INSERT INTO family_members (family_id, name, relationship) VALUES (?, ?, 'Titular')", [family.insertId, name]);
    for (const member of members) await conn.execute('INSERT INTO family_members (family_id, name, relationship) VALUES (?, ?, ?)', [family.insertId, member.name, member.relationship]);
    if (data.existingBefore2026 === true) {
      await conn.execute("INSERT INTO historical_standing (family_id, year, status, source, recorded_by) VALUES (?, 2025, 'current', ?, ?)", [family.insertId, source, req.session.userId]);
      await conn.execute("INSERT INTO charges (family_id, kind, year, description, amount_cents, due_date, status) VALUES (?, 'annual', 2026, 'Cuota anual 2026: exenta', 0, '2026-01-01', 'exempt')", [family.insertId]);
      await audit(conn, req.session.userId, 'historical_exemption_recorded', 'family', family.insertId, { year: 2026, source });
    }
    if (status === 'active') await ensureCurrentAnnualCharge(conn, family.insertId);
    await audit(conn, req.session.userId, 'historical_family_create', 'family', family.insertId, { source, existingBefore2026: data.existingBefore2026 === true });
    return family.insertId;
  });
  res.status(201).json({ ok: true, id });
}));
router.patch('/admin/families/:id', requireAdmin, wrap(async (req, res) => {
  const familyId = idOf(req.params.id), data = body(req), allowed = ['status', 'address', 'phone'];
  if (!Object.keys(data).length || Object.keys(data).some(key => !allowed.includes(key))) bad('Datos de familia no válidos.');
  const fields = [], values = [];
  if (data.status !== undefined) {
    if (!['pending', 'active', 'inactive'].includes(data.status)) bad('Estado no válido.');
    fields.push('status = ?'); values.push(data.status);
  }
  if (data.address !== undefined) { fields.push('address = ?'); values.push(text(data.address, 'La dirección', 255)); }
  if (data.phone !== undefined) { fields.push('phone = ?'); values.push(text(data.phone, 'El teléfono', 40, { required: false })); }
  const family = await transaction(async conn => {
    const [rows] = await conn.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (!rows.length) throw new HttpError(404, 'No se encontró la familia.');
    await conn.execute(`UPDATE families SET ${fields.join(', ')} WHERE id = ?`, [...values, familyId]);
    if (data.status === 'active') await ensureCurrentAnnualCharge(conn, familyId);
    await audit(conn, req.session.userId, 'family_update', 'family', familyId, { fields: Object.keys(data) });
    const [updated] = await conn.execute('SELECT id, address, phone, status, payment_method, created_at, updated_at FROM families WHERE id = ?', [familyId]);
    return updated[0];
  });
  res.json({ ok: true, family });
}));
router.get('/admin/charges', requireAdmin, wrap(async (_req, res) => {
  const [charges] = await db.query(`SELECT c.*, f.address, f.status AS family_status,
    u.name AS family_name, u.email AS family_email
    FROM charges c JOIN families f ON f.id = c.family_id
    LEFT JOIN users u ON u.id = (SELECT MIN(u2.id) FROM users u2 WHERE u2.family_id = f.id)
    ORDER BY c.due_date DESC, c.id DESC`);
  res.json({ ok: true, charges });
}));
router.post('/admin/charges/generate', requireAdmin, wrap(async (req, res) => {
  const year = body(req).year;
  if (!Number.isInteger(year)) bad('Indica el año como número entero.');
  const generated = await transaction(async conn => {
    const result = await createAnnualCharges(year, conn);
    await audit(conn, req.session.userId, 'annual_generate', 'charges', year, { generated: result });
    return result;
  });
  res.json({ ok: true, generated, year });
}));
router.post('/admin/charges/extra', requireAdmin, wrap(async (req, res) => {
  const data = body(req), familyId = idOf(data.familyId), description = text(data.description, 'La descripción', 255);
  const amount = centsOf(data.amountCents), dueDate = dateOf(data.dueDate);
  const id = await transaction(async conn => {
    const [families] = await conn.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (!families.length) throw new HttpError(404, 'No se encontró la familia.');
    const [result] = await conn.execute("INSERT INTO charges (family_id, kind, year, description, amount_cents, due_date, status) VALUES (?, 'extra', NULL, ?, ?, ?, 'pending')", [familyId, description, amount, dueDate]);
    await audit(conn, req.session.userId, 'extra_charge_create', 'charge', result.insertId, { familyId, amountCents: amount });
    return result.insertId;
  });
  res.status(201).json({ ok: true, id });
}));
router.post('/admin/charges/:id/mark-paid', requireAdmin, wrap(async (req, res) => {
  const chargeId = idOf(req.params.id), reference = text(body(req).reference, 'La referencia del pago', 255);
  await transaction(async conn => {
    const [lookup] = await conn.execute('SELECT family_id FROM charges WHERE id = ?', [chargeId]);
    if (!lookup.length) throw new HttpError(404, 'No se encontró el cargo.');
    // Use the same lock order as Stripe checkout: family, charge, subscription attempts, payments.
    const [families] = await conn.execute('SELECT id, stripe_subscription_id FROM families WHERE id = ? FOR UPDATE', [lookup[0].family_id]);
    if (!families.length) throw new HttpError(404, 'No se encontró la familia.');
    const [rows] = await conn.execute('SELECT id, family_id, kind, status, amount_cents FROM charges WHERE id = ? FOR UPDATE', [chargeId]);
    if (!rows.length) throw new HttpError(404, 'No se encontró el cargo.');
    const charge = rows[0];
    if (Number(charge.family_id) !== Number(lookup[0].family_id)) throw new HttpError(409, 'La familia del cargo ha cambiado; vuelve a consultar los datos.');
    if (charge.status !== 'pending' || Number(charge.amount_cents) < 1) throw new HttpError(409, 'El cargo no está pendiente de pago o es una exención.');
    if (charge.kind === 'annual' && families[0].stripe_subscription_id) throw new HttpError(409, 'Hay una suscripción de tarjeta asociada; concíliala o cancélala antes de registrar otro pago anual.');
    if (charge.kind === 'annual') {
      const [subscriptionAttempts] = await conn.execute('SELECT id FROM subscription_attempts WHERE family_id = ? LIMIT 1 FOR UPDATE', [charge.family_id]);
      if (subscriptionAttempts.length) throw new HttpError(409, 'Hay un intento de suscripción asociado a la familia; concílialo antes de registrar otro pago anual.');
    }
    const [attempts] = await conn.execute("SELECT id FROM payments WHERE charge_id = ? AND provider = 'stripe' AND status IN ('pending','paid','needs_review') LIMIT 1 FOR UPDATE", [chargeId]);
    if (attempts.length) throw new HttpError(409, 'Hay un pago con tarjeta en curso o pendiente de conciliación; revisa su estado antes de registrar otro pago.');
    await conn.execute("UPDATE charges SET status = 'paid', paid_at = NOW(), paid_reference = ?, marked_by = ? WHERE id = ?", [reference, req.session.userId, chargeId]);
    await conn.execute("INSERT INTO payments (family_id, charge_id, amount_cents, provider, status, reference, paid_at) VALUES (?, ?, ?, 'manual', 'paid', ?, NOW())", [charge.family_id, chargeId, charge.amount_cents, reference]);
    await audit(conn, req.session.userId, 'manual_payment', 'charge', chargeId, { reference });
  });
  res.json({ ok: true });
}));
// Historical entry requires explicit source data; it never fabricates dates or amounts.
router.post('/admin/charges/historical', requireAdmin, wrap(async (req, res) => {
  const data = body(req), familyId = idOf(data.familyId), year = data.year;
  if (!Number.isInteger(year) || year < 1900 || year > 2025) bad('El año histórico debe ser 2025 o anterior.');
  const amount = centsOf(data.amountCents), reference = text(data.reference, 'La referencia o fuente', 255);
  const dueDate = dateOf(data.dueDate, 'La fecha de vencimiento');
  if (Number(dueDate.slice(0, 4)) !== year) bad('La fecha de vencimiento debe corresponder al año histórico.');
  const paidAt = data.paidAt == null || data.paidAt === '' ? null : dateOf(data.paidAt, 'La fecha de pago');
  if (paidAt && paidAt > new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())) bad('La fecha de pago no puede estar en el futuro.');
  const id = await transaction(async conn => {
    const [families] = await conn.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (!families.length) throw new HttpError(404, 'No se encontró la familia.');
    const [result] = await conn.execute("INSERT INTO charges (family_id, kind, year, description, amount_cents, due_date, status, paid_at, paid_reference, marked_by) VALUES (?, 'annual', ?, ?, ?, ?, 'paid', ?, ?, ?)", [familyId, year, `Cuota anual ${year} (registro histórico)`, amount, dueDate, paidAt, reference, req.session.userId]);
    await conn.execute("INSERT INTO payments (family_id, charge_id, amount_cents, provider, status, reference, paid_at) VALUES (?, ?, ?, 'manual', 'paid', ?, ?)", [familyId, result.insertId, amount, reference, paidAt]);
    await audit(conn, req.session.userId, 'historical_payment_recorded', 'charge', result.insertId, { familyId, year, reference, paidAt });
    return result.insertId;
  });
  res.status(201).json({ ok: true, id });
}));

router.get('/admin/settings', requireAdmin, wrap(async (_req, res) => {
  const settings = await getSettings();
  res.json({ ok: true, settings, smtpConfigured: mailConfigured(settings, true) });
}));
router.put('/admin/settings', requireAdmin, wrap(async (req, res) => {
  const data = body(req), supplied = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings : data;
  const entries = Object.entries(supplied);
  if (!entries.length || entries.some(([key]) => !Object.hasOwn(EDITABLE_SETTINGS, key))) bad('Se han recibido ajustes no permitidos. Las claves y contraseñas solo se configuran en el entorno.');
  let validated;
  try { validated = entries.map(([key, value]) => [key, validateSetting(key, value)]); }
  catch (error) { bad(error.message); }
  await transaction(async conn => {
    for (const [key, value] of validated) await conn.execute('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value]);
    await audit(conn, req.session.userId, 'settings_update', 'settings', 'configuration', { fields: validated.map(([key]) => key) });
  });
  const settings = await getSettings();
  res.json({ ok: true, settings, smtpConfigured: mailConfigured(settings, true) });
}));

const exports = {
  families: ['SELECT f.id, f.address, f.phone, f.status, f.payment_method, f.created_at, u.name AS account_name, u.email AS account_email FROM families f LEFT JOIN users u ON u.id = (SELECT MIN(u2.id) FROM users u2 WHERE u2.family_id = f.id) ORDER BY f.id', ['id','address','phone','status','payment_method','created_at','account_name','account_email']],
  members: ['SELECT id, family_id, name, relationship, created_at FROM family_members ORDER BY family_id, id', ['id','family_id','name','relationship','created_at']],
  charges: ['SELECT id, family_id, kind, year, description, amount_cents, due_date, status, paid_at, paid_reference, marked_by, created_at FROM charges ORDER BY family_id, id', ['id','family_id','kind','year','description','amount_cents','due_date','status','paid_at','paid_reference','marked_by','created_at']],
  payments: ['SELECT id, family_id, charge_id, ticket_order_id, amount_cents, provider, status, reference, paid_at, created_at FROM payments ORDER BY family_id, id', ['id','family_id','charge_id','ticket_order_id','amount_cents','provider','status','reference','paid_at','created_at']],
};
function csvCell(value) {
  let str = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  // Excel/LibreOffice formula injection prevention, including leading whitespace/control chars.
  if (/^[\s\x00-\x1f]*[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}
router.get('/admin/export/:type', requireAdmin, wrap(async (req, res) => {
  const spec = Object.hasOwn(exports, req.params.type) ? exports[req.params.type] : null;
  if (!spec) throw new HttpError(404, 'Tipo de exportación no válido.');
  const [rows] = await db.query(spec[0]), columns = spec[1];
  const csv = '\ufeff' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\r\n') + '\r\n';
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.params.type}.csv"`);
  res.send(csv);
}));

router.use((error, _req, res, _next) => {
  if (error instanceof HttpError) return res.status(error.status).json({ ok: false, error: error.message });
  if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'El correo o registro ya existe.' });
  console.error('Error al procesar una solicitud de la API:', error?.code || error?.name || 'error');
  return res.status(500).json({ ok: false, error: 'No se pudo completar la operación.' });
});

export { createAnnualCharges };
export default router;
