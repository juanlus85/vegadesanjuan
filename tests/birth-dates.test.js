import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import db from '../server/lib/db.js';
import router, { birthDateOf } from '../server/routes/core.js';

const origin = 'http://localhost:3333';
const testDate = '2000-02-29';

test('fechas reales, formato estricto y día actual en Europa/Madrid', () => {
  const winter = new Date('2026-02-28T23:30:00Z'); // En Madrid ya es 1 de marzo.
  assert.equal(birthDateOf('2026-03-01', { now: winter }), '2026-03-01');
  assert.throws(() => birthDateOf('2026-03-02', { now: winter }), /futuro/);
  const summer = new Date('2026-07-01T22:30:00Z'); // En Madrid ya es 2 de julio.
  assert.equal(birthDateOf('2026-07-02', { now: summer }), '2026-07-02');
  assert.throws(() => birthDateOf('2026-07-03', { now: summer }), /futuro/);
  assert.equal(birthDateOf('2000-02-29', { now: winter }), '2000-02-29');
  assert.equal(birthDateOf('1000-01-01', { now: winter }), '1000-01-01');
  for (const value of [undefined, null, '', ' ', ' 2000-02-29', '2000-2-29', '2000-02-29T00:00:00Z', '1900-02-29', '2024-02-30', '2024-04-31', '0000-01-01', '0999-12-31', '9999-01-01', 123, {}, []]) {
    assert.throws(() => birthDateOf(value, { now: winter }));
  }
  for (const value of [undefined, null, '']) assert.equal(birthDateOf(value, { optional: true, now: winter }), null);
  assert.throws(() => birthDateOf(' ', { optional: true, now: winter }));
});

test('las migraciones son aditivas, idempotentes y no rellenan datos anteriores', async () => {
  const births = await readFile(new URL('../database/birth_dates.sql', import.meta.url), 'utf8');
  const payments = await readFile(new URL('../database/payment_preferences.sql', import.meta.url), 'utf8');
  for (const sql of [births, payments]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS/i);
    assert.match(sql, /PRIMARY KEY/i);
    assert.match(sql, /FOREIGN KEY/i);
    assert.match(sql, /ON DELETE CASCADE/i);
    assert.doesNotMatch(sql, /\b(ALTER|DROP|INSERT|UPDATE|DELETE FROM)\b/i);
  }
  assert.match(births, /member_id BIGINT UNSIGNED NOT NULL PRIMARY KEY/i);
  assert.match(births, /birth_date DATE NOT NULL/i);
  assert.match(payments, /family_id BIGINT UNSIGNED NOT NULL PRIMARY KEY/i);
  assert.match(payments, /KEY idx_family_payment_preference \(payment_preference\)/i);
});

function fakeDatabase() {
  let state = {
    families: [
      { id: 1, address: 'Domicilio sintético', phone: '', status: 'pending', payment_method: 'manual', created_at: '2020-01-01 00:00:00', updated_at: '2020-01-01 00:00:00' },
      { id: 2, address: 'Otro domicilio sintético', phone: '', status: 'pending', payment_method: 'manual', created_at: '2020-01-01 00:00:00', updated_at: '2020-01-01 00:00:00' },
    ],
    users: [
      { id: 1, family_id: 1, name: 'Titular uno', email: 'uno@example.invalid', role: 'member', active: 1 },
      { id: 2, family_id: 2, name: 'Titular dos', email: 'dos@example.invalid', role: 'member', active: 1 },
      { id: 3, family_id: null, name: 'Admin', email: 'admin@example.invalid', role: 'admin', active: 1 },
    ],
    members: [
      { id: 10, family_id: 1, name: 'Titular uno', relationship: 'Titular', created_at: '2020-01-01 00:00:00' },
      { id: 11, family_id: 1, name: '@Fórmula', relationship: 'Familiar', created_at: '2020-01-01 00:00:00' },
      { id: 20, family_id: 2, name: 'Titular dos', relationship: 'Titular', created_at: '2020-01-01 00:00:00' },
    ],
    dates: [{ member_id: 10, birth_date: '1980-05-15' }],
    preferences: [], audits: [],
  };
  let before;
  const fake = { failOn: null, stale: false, beforeBegin: null, booked: [], statements: [], calls: [], queries: [], get state() { return state; } };
  const conn = {
    async beginTransaction() {
      const hook = fake.beforeBegin; fake.beforeBegin = null;
      if (hook) hook(state);
      before = structuredClone(state);
    },
    async commit() { before = undefined; },
    async rollback() { state = before; before = undefined; },
    release() {},
    async execute(sql, args = []) { return execute(sql, args); },
  };
  async function execute(sql, args = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    fake.statements.push(s);
    fake.calls.push({ sql: s, args: [...args] });
    if (fake.failOn && s.includes(fake.failOn)) { fake.failOn = null; const error = new Error('synthetic failure'); error.code = 'TEST_FAILURE'; throw error; }
    const family = id => state.families.find(row => row.id === Number(id));
    const user = id => state.users.find(row => row.id === Number(id));
    if (s.startsWith('SELECT id, family_id, role, active FROM users')) {
      const u = user(args[0]); return [[...(u ? [{ id: u.id, family_id: u.family_id, role: u.role, active: u.active }] : [])]];
    }
    if (s.startsWith('SELECT id, name, email, role, family_id FROM users')) {
      const u = user(args[0]); return [[...(u?.active ? [{ id: u.id, name: u.name, email: u.email, role: u.role, family_id: u.family_id }] : [])]];
    }
    if (s.startsWith('SELECT id, address, phone, status, payment_method, created_at, updated_at FROM families WHERE id = ?')) {
      const f = family(args[0]); return [[...(f ? [structuredClone(f)] : [])]];
    }
    if (s.startsWith('SELECT id FROM families WHERE id = ?')) {
      const f = family(args[0]); return [[...(f ? [{ id: f.id }] : [])]];
    }
    if (s.startsWith('SELECT id FROM users WHERE id = ? AND family_id = ? AND active = TRUE FOR UPDATE')) {
      const u = user(args[0]); return [[...(u?.active && u.family_id === Number(args[1]) && !fake.stale ? [{ id: u.id }] : [])]];
    }
    if (s.startsWith('SELECT payment_preference FROM family_payment_preferences')) {
      const p = state.preferences.find(row => row.family_id === Number(args[0])); return [[...(p ? [{ payment_preference: p.payment_preference }] : [])]];
    }
    if (s.startsWith('SELECT COUNT(*) AS n FROM family_members')) return [[{ n: state.members.filter(m => m.family_id === Number(args[0])).length }]];
    if (s.startsWith('SELECT id FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE')) {
      const m = state.members.find(row => row.id === Number(args[0]) && row.family_id === Number(args[1]));
      return [[...(m ? [{ id: m.id }] : [])]];
    }
    if (s.startsWith('SELECT id, relationship FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE')) {
      const m = state.members.find(row => row.id === Number(args[0]) && row.family_id === Number(args[1]));
      return [[...(m ? [{ id: m.id, relationship: m.relationship }] : [])]];
    }
    if (s.startsWith('SELECT event_id, SUM(member_qty) AS n FROM ticket_orders')) return [structuredClone(fake.booked)];
    if (s.includes('FROM family_members fm LEFT JOIN member_birth_dates bd')) {
      const rows = state.members.filter(m => m.family_id === Number(args[0])).map(m => {
        const birth_date = state.dates.find(d => d.member_id === m.id)?.birth_date ?? null;
        if (s.startsWith('SELECT fm.id, fm.family_id')) return { ...m, birth_date };
        return { id: m.id, name: m.name, relationship: m.relationship, birth_date };
      });
      return [rows];
    }
    if (s.startsWith('SELECT id, family_id, kind, year') || s.startsWith('SELECT id, family_id, charge_id') || s.startsWith('SELECT year, status, source')) return [[]];
    if (s.startsWith('INSERT INTO families')) {
      const id = Math.max(...state.families.map(f => f.id), 0) + 1;
      state.families.push({ id, address: args[0], phone: args[1], status: 'pending', payment_method: 'manual', created_at: args[2], updated_at: args[2] });
      return [{ insertId: id }];
    }
    if (s.startsWith('INSERT INTO family_payment_preferences')) { state.preferences.push({ family_id: args[0], payment_preference: args[1] }); return [{ affectedRows: 1 }]; }
    if (s.startsWith('INSERT INTO users')) {
      const id = Math.max(...state.users.map(u => u.id), 0) + 1;
      state.users.push({ id, family_id: args[0], name: args[1], email: args[2], role: 'member', active: 1 });
      return [{ insertId: id }];
    }
    if (s.startsWith('INSERT INTO family_members')) {
      const id = Math.max(...state.members.map(m => m.id), 0) + 1;
      state.members.push({ id, family_id: args[0], name: args[1], relationship: s.includes("'Titular'") ? 'Titular' : args[2], created_at: '2026-01-01 00:00:00' });
      return [{ insertId: id }];
    }
    if (s.startsWith('INSERT INTO member_birth_dates')) {
      const found = state.dates.find(row => row.member_id === args[0]);
      if (found) found.birth_date = args[1]; else state.dates.push({ member_id: args[0], birth_date: args[1] });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('DELETE FROM family_members WHERE id = ? AND family_id = ?')) {
      const member = state.members.find(row => row.id === Number(args[0]) && row.family_id === Number(args[1]));
      if (member) {
        state.members = state.members.filter(row => row !== member);
        state.dates = state.dates.filter(row => row.member_id !== member.id);
      }
      return [{ affectedRows: member ? 1 : 0 }];
    }
    if (s.startsWith('DELETE FROM member_birth_dates')) { state.dates = state.dates.filter(row => row.member_id !== args[0]); return [{ affectedRows: 1 }]; }
    if (s.startsWith('INSERT INTO audit_log')) { state.audits.push({ user_id: args[0], action: args[1], entity_type: args[2], entity_id: args[3], details: args[4] }); return [{ insertId: state.audits.length }]; }
    throw new Error('Consulta de prueba inesperada');
  }
  async function query(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    fake.statements.push(s);
    fake.queries.push(s);
    if (s.includes('FROM family_members fm LEFT JOIN member_birth_dates bd')) {
      return [state.members.map(m => ({ ...m, birth_date: state.dates.find(d => d.member_id === m.id)?.birth_date ?? null }))];
    }
    if (s.includes('FROM families f') && s.includes('u.name AS account_name')) {
      return [state.families.map(f => {
        const account = state.users.filter(u => u.family_id === f.id).sort((a, b) => a.id - b.id)[0];
        return { ...f, account_name: account?.name ?? null, account_email: account?.email ?? null,
          payment_preference: state.preferences.find(p => p.family_id === f.id)?.payment_preference ?? null };
      })];
    }
    if (s.includes('FROM families f') && s.includes('LEFT JOIN family_payment_preferences pref')) {
      return [state.families.map(f => {
        const users = state.users.filter(u => u.family_id === f.id).sort((a, b) => a.id - b.id);
        const members = state.members.filter(m => m.family_id === f.id).sort((a, b) => a.id - b.id);
        return { ...f, user_id: users[0]?.id ?? null, name: users[0]?.name ?? members[0]?.name ?? null,
          email: users[0]?.email ?? null, member_count: members.length,
          payment_preference: state.preferences.find(p => p.family_id === f.id)?.payment_preference ?? null };
      })];
    }
    throw new Error('Consulta de prueba inesperada');
  }
  return Object.assign(fake, { conn, execute, query });
}

async function withApp(fn) {
  const old = { execute: db.execute, query: db.query, getConnection: db.getConnection, origin: process.env.APP_ORIGIN };
  const fake = fakeDatabase();
  db.execute = fake.execute;
  db.query = fake.query;
  db.getConnection = async () => fake.conn;
  process.env.APP_ORIGIN = origin;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('X-Test-User')) || undefined;
    req.session = { userId: id, regenerate(callback) { callback(); }, save(callback) { callback(); }, destroy(callback) { callback(); } };
    next();
  });
  app.use('/api', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let requestNumber = 0;
  async function request(path, { method = 'GET', data, user = 0 } = {}) {
    const headers = { Origin: origin, 'X-Test-User': String(user), 'X-Forwarded-For': `192.0.2.${++requestNumber}` };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  }
  try { await fn(fake, request); }
  finally {
    await new Promise(resolve => server.close(resolve));
    db.execute = old.execute; db.query = old.query; db.getConnection = old.getConnection;
    if (old.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = old.origin;
  }
}

const registration = {
  name: 'Persona sintética', email: 'registro@example.invalid', password: 'Contrasena-123', address: 'Domicilio sintético',
  phone: '', birthDate: '1985-01-01', privacyAccepted: true,
  members: [{ name: 'Familiar sintético', relationship: 'Hijo', birthDate: testDate }, { name: 'Sin fecha', relationship: '', birthDate: '' }, { name: 'Fecha desconocida', relationship: '', birthDate: null }, { name: 'Sin dato', relationship: '' }],
};

test('el alta valida y guarda fechas y preferencia en una sola transacción', async t => {
  await withApp(async (fake, request) => {
    const initial = structuredClone(fake.state);
    for (const [birthDate, members, paymentPreference] of [
      [undefined, [], undefined], [null, [], undefined], ['', [], undefined], ['2024-02-30', [], undefined],
      ['9999-01-01', [], undefined], ['1985-01-01', [{ name: 'Inválido', birthDate: '2023-02-29' }], undefined],
      ['1985-01-01', [], 'card'], ['1985-01-01', [], null],
    ]) {
      const result = await request('/auth/register', { method: 'POST', data: { ...registration, birthDate, members, paymentPreference } });
      assert.equal(result.status, 400);
      assert.deepEqual(fake.state, initial);
    }
    t.mock.method(console, 'error', () => {});
    fake.failOn = 'INSERT INTO member_birth_dates';
    assert.equal((await request('/auth/register', { method: 'POST', data: registration })).status, 500);
    assert.deepEqual(fake.state, initial, 'Un error revierte alta y preferencia');
    const created = await request('/auth/register', { method: 'POST', data: { ...registration, paymentPreference: 'single_card' } });
    assert.equal(created.status, 201);
    const familyId = created.json.family.id;
    assert.equal(created.json.family.status, 'pending');
    assert.equal(created.json.family.payment_method, 'manual');
    assert.equal(fake.state.preferences.find(p => p.family_id === familyId).payment_preference, 'single_card');
    const userId = created.json.user.id;
    const summary = await request('/member/summary', { user: userId });
    assert.equal(summary.status, 200);
    assert.equal(summary.json.family.payment_preference, 'single_card');
    assert.deepEqual(summary.json.members.map(m => m.birth_date), ['1985-01-01', testDate, null, null, null]);
    assert.equal(fake.state.dates.filter(d => summary.json.members.some(m => m.id === d.member_id)).length, 2);
    const manual = await request('/auth/register', { method: 'POST', data: { ...registration, email: 'manual@example.invalid', members: [] } });
    assert.equal(manual.status, 201);
    assert.equal(fake.state.preferences.find(p => p.family_id === manual.json.family.id).payment_preference, 'manual');
    const subscription = await request('/auth/register', { method: 'POST', data: { ...registration, email: 'suscripcion@example.invalid', members: [], paymentPreference: 'subscription' } });
    assert.equal(subscription.status, 201);
    assert.equal(fake.state.preferences.find(p => p.family_id === subscription.json.family.id).payment_preference, 'subscription');
    assert.equal(subscription.json.family.payment_method, 'manual');
    assert.equal(JSON.stringify(fake.state.audits).includes(testDate), false, 'La auditoría no registra la fecha');
  });
});

test('actualización propia, aislamiento, validación, reversión y bloqueos', async t => {
  await withApp(async (fake, request) => {
    const before = structuredClone(fake.state);
    assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', data: { birthDate: testDate } })).status, 401);
    for (const data of [{}, { birthDate: '' }, { birthDate: '2023-02-29' }, { birthDate: '9999-01-01' }, { birthDate: testDate, name: 'Cambio no autorizado' }, { birthDate: 42 }]) {
      assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', user: 1, data })).status, 400);
      assert.deepEqual(fake.state, before);
    }
    assert.equal((await request('/member/members/20/birth-date', { method: 'PUT', user: 1, data: { birthDate: testDate } })).status, 404);
    assert.deepEqual(fake.state, before);
    fake.stale = true;
    assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', user: 1, data: { birthDate: testDate } })).status, 409);
    assert.deepEqual(fake.state, before);
    fake.stale = false;
    t.mock.method(console, 'error', () => {});
    fake.failOn = 'INSERT INTO audit_log';
    assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', user: 1, data: { birthDate: testDate } })).status, 500);
    assert.deepEqual(fake.state, before, 'Si falla la auditoría, se revierte la fecha');
    fake.statements.length = 0;
    assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', user: 1, data: { birthDate: testDate } })).status, 200);
    assert.ok(fake.statements.some(s => s.includes('FROM families WHERE id = ? FOR UPDATE')));
    assert.ok(fake.statements.some(s => s.includes('FROM users WHERE id = ? AND family_id = ? AND active = TRUE FOR UPDATE')));
    assert.ok(fake.statements.some(s => s.includes('FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE')));
    assert.equal(fake.state.dates.find(d => d.member_id === 11).birth_date, testDate);
    assert.deepEqual(fake.state.members, before.members, 'No se cambian nombre ni parentesco');
    assert.equal(JSON.stringify(fake.state.audits).includes(testDate), false);
    assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', user: 1, data: { birthDate: null } })).status, 200);
    assert.equal((await request('/member/members/11/birth-date', { method: 'PUT', user: 1, data: { birthDate: null } })).status, 200);
    assert.equal(fake.state.dates.some(d => d.member_id === 11), false);
    assert.equal(fake.state.dates.find(d => d.member_id === 10).birth_date, '1980-05-15');
  });
});

test('alta de familiar, lectura admin y CSV respetan permisos y ausencias', async () => {
  await withApp(async (fake, request) => {
    const legacy = await request('/member/summary', { user: 1 });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.json.family.payment_preference, null);
    assert.deepEqual(legacy.json.members.map(m => m.birth_date), ['1980-05-15', null]);
    for (const birthDate of [undefined, null, '', testDate]) {
      const added = await request('/member/members', { method: 'POST', user: 1, data: { name: 'Familiar sintético', relationship: 'Hijo', birthDate } });
      assert.equal(added.status, 201);
      assert.equal(added.json.member.birth_date, birthDate || null);
    }
    const prior = structuredClone(fake.state);
    assert.equal((await request('/member/members', { method: 'POST', user: 1, data: { name: 'Inválido', birthDate: '2025-02-29' } })).status, 400);
    assert.deepEqual(fake.state, prior);
    assert.equal((await request('/admin/families/1/members')).status, 401);
    assert.equal((await request('/admin/families/1/members', { user: 1 })).status, 403);
    assert.equal((await request('/admin/families/0/members', { user: 3 })).status, 400);
    assert.equal((await request('/admin/families/999/members', { user: 3 })).status, 404);
    const admin = await request('/admin/families/1/members', { user: 3 });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(admin.json.members[0]), ['id', 'name', 'relationship', 'birth_date']);
    assert.equal(admin.json.members[1].birth_date, null);
    assert.ok(admin.json.members.some(m => m.birth_date === testDate));
    assert.equal((await request('/admin/export/members', { user: 1 })).status, 403);
    const csv = await request('/admin/export/members', { user: 3 });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('cache-control'), 'no-store');
    assert.match(csv.text, /"birth_date"/);
    assert.match(csv.text, /"2000-02-29"/);
    assert.ok(csv.text.includes('"\'@Fórmula"'), 'Se conserva la protección contra fórmulas');
    const families = await request('/admin/families', { user: 3 });
    assert.equal(families.status, 200);
    assert.equal(families.json.families[0].payment_preference, null);
    assert.equal(families.json.families[0].name, 'Titular uno');
    assert.equal(families.json.families[0].member_count, 6);
  });
});

test('el borrado revalida bajo bloqueo cuenta, rol y familia tras la autenticación', async () => {
  await withApp(async (fake, request) => {
    const originalUsers = structuredClone(fake.state.users);
    const changes = [
      ['otra familia', state => { state.users[0].family_id = 2; }],
      ['sin familia', state => { state.users[0].family_id = null; }],
      ['cuenta inactiva', state => { state.users[0].active = 0; }],
      ['cambio de rol', state => { state.users[0].role = 'admin'; }],
      ['cuenta eliminada', state => { state.users = state.users.filter(user => user.id !== 1); }],
    ];
    for (const [description, change] of changes) {
      fake.state.users = structuredClone(originalUsers);
      let afterConcurrentChange;
      // El middleware ya ha leído la cuenta: el cambio externo precede a la transacción.
      fake.beforeBegin = state => { change(state); afterConcurrentChange = structuredClone(state); };
      fake.calls.length = 0;
      const result = await request('/member/members/11', { method: 'DELETE', user: 1 });
      assert.equal(result.status, 409, description);
      assert.deepEqual(fake.state, afterConcurrentChange, `Sin borrado ni auditoría: ${description}`);
      const familyLock = fake.calls.findIndex(call => call.sql === 'SELECT id FROM families WHERE id = ? FOR UPDATE');
      const userLock = fake.calls.findIndex(call => call.sql === 'SELECT id, family_id, role, active FROM users WHERE id = ? FOR UPDATE');
      assert.ok(familyLock >= 0 && userLock > familyLock, `Orden familia → usuario: ${description}`);
      assert.deepEqual(fake.calls[familyLock].args, [1]);
      assert.deepEqual(fake.calls[userLock].args, [1]);
      assert.ok(!fake.calls.some(call => call.sql.includes('FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE')));
      assert.ok(!fake.calls.some(call => call.sql.startsWith('DELETE FROM family_members') || call.sql.startsWith('INSERT INTO audit_log')));
    }
    fake.state.users = structuredClone(originalUsers);
    fake.state.users.find(user => user.id === 3).family_id = 1;
    const before = structuredClone(fake.state);
    assert.equal((await request('/member/members/11', { method: 'DELETE', user: 3 })).status, 409);
    assert.deepEqual(fake.state, before, 'Una cuenta admin con familia tampoco puede borrar');
  });
});

test('el borrado legítimo conserva las protecciones, el orden de bloqueo y la atomicidad', async t => {
  await withApp(async (fake, request) => {
    fake.state.dates.push({ member_id: 11, birth_date: testDate });
    const initial = structuredClone(fake.state);
    assert.equal((await request('/member/members/11', { method: 'DELETE' })).status, 401);
    assert.equal((await request('/member/members/0', { method: 'DELETE', user: 1 })).status, 400);
    assert.equal((await request('/member/members/20', { method: 'DELETE', user: 1 })).status, 404);
    assert.equal((await request('/member/members/10', { method: 'DELETE', user: 1 })).status, 409);
    assert.deepEqual(fake.state, initial);
    fake.booked = [{ event_id: 1, n: 2 }];
    assert.equal((await request('/member/members/11', { method: 'DELETE', user: 1 })).status, 409);
    assert.deepEqual(fake.state, initial, 'Las reservas activas impiden reducir la familia');
    fake.booked = [];
    t.mock.method(console, 'error', () => {});
    fake.failOn = 'INSERT INTO audit_log';
    assert.equal((await request('/member/members/11', { method: 'DELETE', user: 1 })).status, 500);
    assert.deepEqual(fake.state, initial, 'Un fallo de auditoría revierte el borrado y su cascada');
    fake.calls.length = 0;
    assert.equal((await request('/member/members/11', { method: 'DELETE', user: 1 })).status, 200);
    const familyLock = fake.calls.findIndex(call => call.sql === 'SELECT id FROM families WHERE id = ? FOR UPDATE');
    const userLock = fake.calls.findIndex(call => call.sql === 'SELECT id, family_id, role, active FROM users WHERE id = ? FOR UPDATE');
    const memberLock = fake.calls.findIndex(call => call.sql === 'SELECT id, relationship FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE');
    const deletion = fake.calls.findIndex(call => call.sql.startsWith('DELETE FROM family_members'));
    assert.ok(familyLock >= 0 && familyLock < userLock && userLock < memberLock && memberLock < deletion);
    assert.deepEqual(fake.calls[memberLock].args, [11, 1]);
    assert.deepEqual(fake.calls[deletion].args, [11, 1]);
    assert.equal(fake.state.members.some(member => member.id === 11), false);
    assert.equal(fake.state.members.some(member => member.id === 10), true);
    assert.equal(fake.state.members.some(member => member.id === 20), true);
    assert.equal(fake.state.dates.some(date => date.member_id === 11), false);
    assert.deepEqual(fake.state.audits.map(audit => audit.action), ['member_remove']);
  });
});

test('Titular está reservado para el miembro generado, en todas las altas', async () => {
  await withApp(async (fake, request) => {
    const adminFamily = { name: 'Titular manual', address: 'Domicilio manual', source: 'Documento', members: [] };
    const initial = structuredClone(fake.state);
    for (const relationship of ['Titular', 'titular', 'TITULAR', '  tItUlAr  ', '\u00a0TITULAR\u00a0']) {
      const extra = { name: 'Otra persona', relationship };
      const requests = [
        ['/auth/register', { ...registration, members: [{ name: 'Válido', relationship: 'Hijo' }, extra] }, 0],
        ['/admin/families', { ...adminFamily, members: [{ name: 'Válido', relationship: 'Hijo' }, extra] }, 3],
        ['/member/members', extra, 1],
      ];
      for (const [path, data, user] of requests) {
        const result = await request(path, { method: 'POST', data, user });
        assert.equal(result.status, 400, `${path}: ${JSON.stringify(relationship)}`);
        assert.deepEqual(fake.state, initial, `Sin escritura parcial: ${path}`);
      }
    }
    const added = await request('/member/members', { method: 'POST', user: 1, data: { name: 'Permitido', relationship: '  Titularidad  ' } });
    assert.equal(added.status, 201);
    assert.equal(added.json.member.relationship, 'Titularidad');
    const registered = await request('/auth/register', { method: 'POST', data: { ...registration, members: [{ name: 'Hijo', relationship: '  Hijo  ' }] } });
    assert.equal(registered.status, 201);
    assert.deepEqual(fake.state.members.filter(member => member.family_id === registered.json.family.id).map(member => member.relationship), ['Titular', 'Hijo']);
    const manual = await request('/admin/families', { method: 'POST', user: 3, data: { ...adminFamily, members: [{ name: 'Otro', relationship: '  Familiar  ' }] } });
    assert.equal(manual.status, 201);
    assert.deepEqual(fake.state.members.filter(member => member.family_id === manual.json.id).map(member => member.relationship), ['Titular', 'Familiar']);
  });
});

test('el CSV de familias incluye preferencia, ausencias y primera cuenta mediante JOIN compatible', async () => {
  await withApp(async (fake, request) => {
    fake.state.preferences.push({ family_id: 1, payment_preference: 'single_card' });
    fake.state.users.push({ id: 8, family_id: 1, name: 'Otra cuenta', email: 'otra@example.invalid', role: 'member', active: 1 });
    fake.state.families.push({ id: 3, address: 'Familia sin cuenta', phone: '', status: 'pending', payment_method: 'manual', created_at: '2020-01-01 00:00:00' });
    assert.equal((await request('/admin/export/families', { user: 1 })).status, 403);
    const csv = await request('/admin/export/families', { user: 3 });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('cache-control'), 'no-store');
    const lines = csv.text.replace(/^\ufeff/, '').trimEnd().split('\r\n').map(line => line.split(',').map(cell => cell.slice(1, -1)));
    const [columns, ...rows] = lines;
    assert.ok(columns.includes('payment_preference'));
    const values = rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
    assert.equal(values.length, 3);
    assert.equal(values[0].payment_preference, 'single_card');
    assert.equal(values[0].account_name, 'Titular uno');
    assert.equal(values[0].account_email, 'uno@example.invalid');
    assert.equal(values[1].payment_preference, '');
    assert.equal(values[2].account_name, '');
    assert.equal(values[2].account_email, '');
    assert.equal(values[2].payment_preference, '');
    const sql = fake.queries.at(-1);
    assert.match(sql, /LEFT JOIN \(SELECT family_id, MIN\(id\) AS first_user_id FROM users WHERE family_id IS NOT NULL GROUP BY family_id\) fu ON fu\.family_id = f\.id/);
    assert.match(sql, /LEFT JOIN users u ON u\.id = fu\.first_user_id/);
    assert.match(sql, /LEFT JOIN family_payment_preferences pref ON pref\.family_id = f\.id/);
    assert.doesNotMatch(sql, /ON u\.id = \(SELECT/i);
  });
});

test.after(async () => { await db.end(); });
