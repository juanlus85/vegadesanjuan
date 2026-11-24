// Test de desarrollo: crea y elimina exclusivamente sus propios registros temporales.
// No debe ejecutarse contra una base de datos de producción.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../server/lib/db.js';

if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SMOKE_TEST !== '1') {
  console.error('Solo para una base de desarrollo: configura ALLOW_SMOKE_TEST=1.');
  process.exit(1);
}
const origin = process.env.SMOKE_ORIGIN;
if (!origin) { console.error('Falta SMOKE_ORIGIN de la vista previa.'); process.exit(1); }
const base = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const nonce = crypto.randomBytes(8).toString('hex');
const familyIds = [], userIds = [], emails = [];
const pass = `Prueba-${crypto.randomBytes(12).toString('hex')}`;
async function request(path, {method = 'GET', data, cookie, customOrigin = origin} = {}) {
  const headers = { Origin: customOrigin, 'X-Forwarded-Proto': 'https' };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(base + path, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function register(n) {
  const email = `test-${nonce}-${n}@example.invalid`; emails.push(email);
  const result = await request('/api/auth/register', { method: 'POST', data: { name: `Socio de prueba ${n}`, email, password: pass, address: `Domicilio de prueba ${nonce}`, phone: '', members: [{name: `Familiar prueba ${n}`, relationship: 'Familiar'}], privacyAccepted: true } });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.ok(result.cookie, 'Debe establecer sesión segura');
  assert.equal(result.json.family.status, 'pending');
  familyIds.push(result.json.family.id); userIds.push(result.json.user.id);
  return result;
}
try {
  const a = await register(1), b = await register(2);
  const own = await request('/api/member/summary', {cookie:a.cookie});
  assert.equal(own.status, 200); assert.equal(own.json.members.length, 2);
  const other = await request('/api/member/summary', {cookie:b.cookie});
  const crossDelete = await request(`/api/member/members/${own.json.members[1].id}`, {method:'DELETE',cookie:b.cookie});
  assert.equal(crossDelete.status, 404, 'Una familia no puede modificar miembros de otra');
  assert.equal((await request('/api/admin/families',{cookie:a.cookie})).status,403);
  assert.equal((await request('/api/auth/login',{method:'POST',data:{email:emails[0],password:pass},customOrigin:'https://no-autorizado.invalid'})).status,403);
  const adminEmail = `admin-${nonce}@example.invalid`; emails.push(adminEmail);
  const [insert] = await db.execute("INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,'admin',1)", ['Admin de prueba', adminEmail, await bcrypt.hash(pass,12)]); userIds.push(insert.insertId);
  const admin = await request('/api/auth/login',{method:'POST',data:{email:adminEmail,password:pass}});
  assert.equal(admin.status,200,JSON.stringify(admin.json)); assert.ok(admin.cookie);
  const activate = await request(`/api/admin/families/${a.json.family.id}`,{method:'PATCH',cookie:admin.cookie,data:{status:'active'}});
  assert.equal(activate.status,200,JSON.stringify(activate.json));
  const updated = await request('/api/member/summary',{cookie:a.cookie});
  assert.equal(updated.status,200,JSON.stringify(updated.json));
  const year = Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',year:'numeric'}).format(new Date()));
  if (year === 2026) { const exempt = updated.json.charges.find(c => c.year === 2026); assert.ok(exempt); assert.equal(exempt.status,'exempt'); assert.equal(exempt.amount_cents,0); }
  const historic = await request('/api/admin/families',{method:'POST',cookie:admin.cookie,data:{name:'Familia histórica temporal',address:`Histórico ${nonce}`,phone:'',status:'active',source:'Prueba temporal automatizada',existingBefore2026:true}});
  assert.equal(historic.status,201,JSON.stringify(historic.json)); familyIds.push(historic.json.id);
  const [standing] = await db.execute('SELECT year,status FROM historical_standing WHERE family_id = ?',[historic.json.id]);
  assert.equal(standing.length,1); assert.equal(Number(standing[0].year),2025); assert.equal(standing[0].status,'current');
  const [historicPayments] = await db.execute('SELECT id FROM payments WHERE family_id = ?',[historic.json.id]);
  assert.equal(historicPayments.length,0,'La acreditación histórica no inventa ingresos');
  const linked = await request(`/api/admin/families/${historic.json.id}/link-user`,{method:'POST',cookie:admin.cookie,data:{userId:b.json.user.id}});
  assert.equal(linked.status,200,JSON.stringify(linked.json));
  const linkedSummary = await request('/api/member/summary',{cookie:b.cookie});
  assert.equal(linkedSummary.status,200,JSON.stringify(linkedSummary.json));
  assert.equal(Number(linkedSummary.json.family.id),Number(historic.json.id));
  assert.ok(linkedSummary.json.historicalStanding.some(s => Number(s.year) === 2025 && s.status === 'current'));
  const [oldFamily] = await db.execute('SELECT status FROM families WHERE id = ?',[b.json.family.id]);
  const [oldMembers] = await db.execute('SELECT id FROM family_members WHERE family_id = ?',[b.json.family.id]);
  assert.equal(oldFamily[0].status,'inactive'); assert.ok(oldMembers.length > 0,'Se conservan los datos previos');
  const events = await request('/api/admin/events',{cookie:admin.cookie}); assert.equal(events.status,200);
  assert.ok(events.json.events.some(e => e.title === 'Cartero Real' && !e.published && !e.price_confirmed));
  const [mailSettings] = await db.query("SELECT setting_key FROM settings WHERE setting_key LIKE 'smtp%' OR setting_key='contactRecipients' LIMIT 1");
  if (!mailSettings.length) {
    const message = await request('/api/contact',{method:'POST',data:{name:'Prueba temporal',email:emails[0],message:'Prueba de integración, no es un mensaje real.'}});
    assert.equal(message.status, 503, 'Sin configuración SMTP no se debe informar de envío correcto');
  }
  console.log('Correcto: registro, sesión, aislamiento, CSRF, permisos, activación, exención, histórico, vinculación y borrador de evento.');
} finally {
  if (emails.length) {
    const [created] = await db.query(`SELECT id,family_id FROM users WHERE email IN (${emails.map(()=>'?').join(',')})`, emails);
    for (const row of created) { if (!userIds.includes(row.id)) userIds.push(row.id); if (row.family_id && !familyIds.includes(row.family_id)) familyIds.push(row.family_id); }
  }
  if (familyIds.length) {
    const mark = familyIds.map(() => '?').join(',');
    await db.query(`DELETE FROM sessions WHERE JSON_VALID(data) AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) AS UNSIGNED) IN (${userIds.map(()=>'?').join(',')})`,userIds);
    await db.query(`DELETE FROM audit_log WHERE user_id IN (${userIds.map(()=>'?').join(',')})`,userIds);
    await db.query(`DELETE FROM payments WHERE family_id IN (${mark})`,familyIds);
    await db.query(`DELETE FROM event_rsvps WHERE family_id IN (${mark})`,familyIds);
    await db.query(`DELETE FROM ticket_orders WHERE family_id IN (${mark})`,familyIds);
    await db.query(`DELETE FROM charges WHERE family_id IN (${mark})`,familyIds);
    await db.query(`DELETE FROM historical_standing WHERE family_id IN (${mark})`,familyIds);
    await db.query(`DELETE FROM family_members WHERE family_id IN (${mark})`,familyIds);
    await db.query(`DELETE FROM users WHERE id IN (${userIds.map(()=>'?').join(',')})`,userIds);
    await db.query(`DELETE FROM families WHERE id IN (${mark})`,familyIds);
  }
  if (emails.length) await db.query(`DELETE FROM contacts WHERE email IN (${emails.map(()=>'?').join(',')})`,emails);
  await db.end();
}
