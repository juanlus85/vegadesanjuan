import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import db from '../server/lib/db.js';
import { checkOrigin } from '../server/lib/auth.js';
import coreRouter from '../server/routes/core.js';
import eventsRouter from '../server/routes/events.js';
import stripeRouter from '../server/routes/stripe.js';
import { createTransferProofRouter, validateUploadsDirectory, MAX_PROOF_BYTES, MAX_CONCURRENT_PROOF_UPLOADS,
  MAX_FAMILY_PROOFS, MAX_FAMILY_PROOF_BYTES } from '../server/routes/transfer-proofs.js';

const pdf = Buffer.from('%PDF-1.7\nprueba local');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const users = {
  11: { id: 11, family_id: 21, role: 'member', active: 1 },
  12: { id: 12, family_id: null, role: 'admin', active: 1 },
  13: { id: 13, family_id: null, role: 'member', active: 1 },
  14: { id: 14, family_id: 21, role: 'member', active: 0 },
  15: { id: 15, family_id: 21, role: 'admin', active: 1 },
  16: { id: 16, family_id: 22, role: 'member', active: 1 },
};
const origin = 'https://example.org';
const restore = (name, value) => value === undefined ? delete process.env[name] : process.env[name] = value;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let fixtureNumber = 0;

async function fixture(fn) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vega-proof-test-'));
  const uploads = path.join(temporary, 'uploads');
  await fs.mkdir(uploads, { mode: 0o700 });
  const oldUploads = process.env.UPLOADS_DIR, oldOrigin = process.env.APP_ORIGIN, oldExecute = db.execute, oldGetConnection = db.getConnection;
  process.env.UPLOADS_DIR = uploads;
  process.env.APP_ORIGIN = origin;
  // Una familia distinta por fixture evita mezclar la cuarentena en memoria entre pruebas.
  const familyId = 2100 + ++fixtureNumber;
  const fixtureUsers = Object.fromEntries(Object.entries(users).map(([key, user]) => [key, {
    ...user, family_id: user.family_id === 21 ? familyId : user.family_id === 22 ? familyId + 100000 : user.family_id,
  }]));
  const state = { familyId, proofs: [], sql: [], failInsert: false, failInsertAfterWrite: false,
    accountChanged: false, commitBehavior: 'normal', failReconcile: false, connectionRequests: 0 };
  const locks = new Map();
  db.getConnection = async () => {
    state.connectionRequests++;
    if (state.getConnectionGate) {
      if (state.connectionRequests === MAX_CONCURRENT_PROOF_UPLOADS) state.connectionsWaiting?.resolve();
      await state.getConnectionGate.promise;
    }
    let pending = [];
    let unlock;
    let commitPending = false;
    const releaseLock = () => { if (unlock) { unlock(); unlock = undefined; } };
    return {
      async beginTransaction() {},
      async execute(sql, args = []) {
        const query = sql.replace(/\s+/g, ' ').trim();
        state.sql.push(query);
        if (query.startsWith('SELECT id FROM families')) {
          const family = args[0];
          const previous = locks.get(family) || Promise.resolve();
          const gate = deferred();
          locks.set(family, gate.promise);
          await previous;
          unlock = () => { gate.resolve(); if (locks.get(family) === gate.promise) locks.delete(family); };
          return [[{ id: family }]];
        }
        if (query.startsWith('SELECT COUNT(*) AS proof_count')) {
          const rows = state.proofs.filter(proof => proof.family_id === args[0]);
          return [[{ proof_count: rows.length, total_bytes: rows.reduce((sum, proof) => sum + Number(proof.size_bytes), 0) }]];
        }
        if (query.startsWith('INSERT INTO transfer_proofs')) {
          if (state.failInsert) throw new Error('simulated database failure');
          if (state.accountChanged) return [{ affectedRows: 0 }];
          const [id, original_name, stored_name, mime_type, size_bytes, user_id, family_id] = args;
          pending.push({ id, original_name, stored_name, mime_type, size_bytes, user_id, family_id,
            created_at: '2026-11-24 12:00:00', address: 'Calle ficticia', name: 'Persona ficticia' });
          if (state.failInsertAfterWrite) throw new Error('INSERT accepted, response lost');
          return [{ affectedRows: 1 }];
        }
        if (query.startsWith('SELECT id, family_id, user_id, original_name, mime_type, size_bytes FROM transfer_proofs')) {
          state.reconcileReached?.resolve();
          if (state.failReconcile) throw new Error('simulated unavailable reconciliation');
          return [state.proofs.filter(proof => proof.stored_name === args[0])];
        }
        throw new Error(`Consulta transaccional inesperada en prueba: ${query}`);
      },
      async commit() {
        const behavior = state.commitBehavior;
        state.commitBehavior = 'normal';
        if (behavior === 'pending') {
          commitPending = true;
          const rows = pending;
          pending = [];
          state.commitGate.promise.then(() => { state.proofs.push(...rows); releaseLock(); });
          state.commitReached.resolve();
          throw new Error('COMMIT response lost while server is still working');
        }
        if (behavior !== 'rejected') state.proofs.push(...pending);
        pending = [];
        releaseLock();
        if (behavior !== 'normal') throw new Error('COMMIT response lost');
      },
      async rollback() { pending = []; releaseLock(); },
      release() {},
      destroy() { if (!commitPending) { pending = []; releaseLock(); } },
    };
  };
  db.execute = async (sql, args = []) => {
    const query = sql.replace(/\s+/g, ' ').trim();
    state.sql.push(query);
    if (query.startsWith('SELECT id, family_id, role, active FROM users')) return [[fixtureUsers[args[0]]].filter(Boolean)];
    if (query.startsWith('SELECT p.id, p.family_id')) {
      return [state.proofs.map(({ id, family_id, original_name, created_at, address, name }) => ({ id, family_id, original_name, created_at, address, name }))];
    }
    if (query.startsWith('SELECT stored_name, original_name, mime_type, size_bytes')) return [state.proofs.filter(p => p.id === args[0])];
    throw new Error(`Consulta inesperada en prueba: ${query}`);
  };
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  // Solo el entorno de prueba simula sesiones; producción usa express-session y MySQL.
  app.use('/api', (req, _res, next) => {
    const userId = Number(req.get('X-Test-User'));
    req.session = { userId, role: 'admin', familyId: 999, destroy: cb => cb() };
    next();
  });
  app.use('/api', checkOrigin, coreRouter, eventsRouter, stripeRouter, createTransferProofRouter());
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error.status || 500;
    res.status(status).json({ ok: false, error: status >= 500 && error.code !== 'TRANSFER_PROOF_STORAGE' ? 'Error interno.' : error.message });
  });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(`${base}${url}`, options);
  const post = (body = pdf, extraHeaders = {}, user = '11', url = '/api/member/transfer-proof') => request(url, {
    method: 'POST', body, headers: { Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('comprobante.pdf'), 'X-Test-User': user, ...extraHeaders },
  });
  try { await fn({ temporary, uploads, state, request, post, base }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    db.execute = oldExecute;
    db.getConnection = oldGetConnection;
    restore('UPLOADS_DIR', oldUploads); restore('APP_ORIGIN', oldOrigin);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const admin = { 'X-Test-User': '12' };
const member = { 'X-Test-User': '11' };

test('la aplicación no arranca sin UPLOADS_DIR y explica qué falta', () => {
  const env = { ...process.env, APP_ORIGIN: origin, SESSION_SECRET: 'prueba-local-no-real-'.repeat(2),
    DATABASE_URL: 'mysql://fake:fake@127.0.0.1:1/no_real' };
  delete env.UPLOADS_DIR;
  const child = spawnSync(process.execPath, ['server/index.js'], { cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /UPLOADS_DIR es obligatorio/);
  assert.doesNotMatch(child.stdout, /Aplicación lista/);
});

test('el directorio debe existir, ser absoluto y privado, sin symlinks y fuera del proyecto', async () => {
  await fixture(async ({ temporary, uploads }) => {
    await validateUploadsDirectory();
    for (const bad of [undefined, 'relativo', path.join(temporary, 'inexistente'), path.resolve('.')]) {
      restore('UPLOADS_DIR', bad);
      await assert.rejects(validateUploadsDirectory(), error => error.code === 'TRANSFER_PROOF_STORAGE' && /UPLOADS_DIR/.test(error.message));
    }
    process.env.UPLOADS_DIR = uploads;
    await fs.chmod(uploads, 0o755);
    await assert.rejects(validateUploadsDirectory(), /0700/);
    await fs.chmod(uploads, 0o700);
    const link = path.join(temporary, 'link');
    await fs.symlink(uploads, link);
    process.env.UPLOADS_DIR = link;
    await assert.rejects(validateUploadsDirectory(), /enlaces simbólicos/);
    process.env.UPLOADS_DIR = uploads;
    await validateUploadsDirectory();
  });
});

test('subidas PDF, JPEG y PNG usan firma, nombres aleatorios y se descargan solo por admin', async () => {
  await fixture(async ({ uploads, state, post, request }) => {
    for (const [bytes, name, mime, extension] of [
      [pdf, '../../factura\r\n.pdf', 'application/pdf', '.pdf'],
      [jpeg, '..\\carpeta\\foto.exe', 'image/jpeg', '.jpg'],
      [png, 'recibo-ñ.png', 'image/png', '.png'],
    ]) {
      const upload = await post(bytes, { 'X-File-Name': encodeURIComponent(name) });
      assert.equal(upload.status, 201);
      const { id } = await upload.json();
      assert.match(id, /^[0-9a-f-]{36}$/);
      const row = state.proofs.find(p => p.id === id);
      assert.equal(row.mime_type, mime);
      assert.equal(row.family_id, state.familyId);
      assert.equal(row.user_id, 11);
      assert.equal(row.size_bytes, bytes.length);
      assert.match(row.stored_name, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(row.original_name, /[/\\\r\n]/);
      assert.deepEqual(await fs.readFile(path.join(uploads, row.stored_name)), bytes);
      assert.equal((await fs.stat(path.join(uploads, row.stored_name))).mode & 0o777, 0o600);
      assert.equal((await request(`/api/admin/transfer-proofs/${id}/download`, { headers: member })).status, 403);
      const result = await request(`/api/admin/transfer-proofs/${id}/download`, { headers: admin });
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('content-type'), mime);
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.match(result.headers.get('content-disposition'), /^attachment;/);
      assert.ok(result.headers.get('content-disposition').includes(extension));
      assert.doesNotMatch(result.headers.get('content-disposition'), /\.exe/);
      assert.equal(result.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
    }
    assert.equal(new Set(state.proofs.map(p => p.id)).size, 3);
    assert.equal(new Set(state.proofs.map(p => p.stored_name)).size, 3);
    assert.equal((await request('/api/admin/transfer-proofs')).status, 401);
    assert.equal((await request('/api/admin/transfer-proofs', { headers: member })).status, 403);
    const listing = await request('/api/admin/transfer-proofs', { headers: admin });
    const { ok, proofs } = await listing.json();
    assert.equal(ok, true);
    assert.equal(proofs.length, 3);
    assert.deepEqual(Object.keys(proofs[0]).sort(), ['address', 'created_at', 'family_id', 'id', 'name', 'original_name']);
    assert.ok(state.sql.every(q => !/\b(?:charges|payments)\b/i.test(q)));
  });
});

test('se rechazan firmas falsas, nombres mal codificados, compresión y contenido incorrecto', async () => {
  await fixture(async ({ uploads, state, post }) => {
    assert.equal((await post(Buffer.from('no es un PDF'), { 'X-File-Name': 'prueba.pdf' })).status, 415);
    assert.equal((await post(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).status, 415);
    assert.equal((await post(Buffer.alloc(0))).status, 415);
    assert.equal((await post(pdf, { 'X-File-Name': '%XX' })).status, 400);
    assert.equal((await post(pdf, { 'X-File-Name': '' })).status, 400);
    assert.equal((await post(pdf, { 'Content-Encoding': 'gzip' })).status, 415);
    assert.equal((await post('{}', { 'Content-Type': 'application/json' })).status, 415);
    assert.equal(state.proofs.length, 0);
    assert.deepEqual(await fs.readdir(uploads), []);
  });
});

test('la excepción CSRF es exclusiva, exige Origin exacto y XMLHttpRequest', async () => {
  await fixture(async ({ post, request, state }) => {
    assert.equal((await post(pdf, { Origin: '' })).status, 403);
    assert.equal((await post(pdf, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post(pdf, { 'X-Requested-With': '' })).status, 403);
    assert.equal((await post(pdf, { 'X-Requested-With': 'xmlhttprequest' })).status, 403);
    process.env.APP_ORIGIN = `${origin}/`;
    assert.equal((await post()).status, 201);
    assert.equal((await post(pdf, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post(pdf, { 'X-Requested-With': '' })).status, 403);
    process.env.APP_ORIGIN = origin;
    assert.equal((await post(pdf, {}, '11', '/api/member/transfer-proof/')).status, 415);
    assert.equal((await post(pdf, {}, '11', '/api/otro')).status, 415);
    assert.equal((await request('/api/member/transfer-proof', { method: 'PUT', body: pdf, headers: {
      Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/octet-stream', 'X-Test-User': '11',
    } })).status, 415);
    assert.equal((await request('/api/otro', { method: 'POST', body: '{}', headers: {
      Origin: 'https://attacker.example', 'Content-Type': 'application/json',
    } })).status, 403);
    assert.equal(state.proofs.length, 1);
  });
});

test('es necesario usuario activo con rol member y familia; no se confía en el rol de la sesión', async () => {
  await fixture(async ({ post, state }) => {
    assert.equal((await post(pdf, {}, '')).status, 401);
    assert.equal((await post(pdf, {}, '12')).status, 403);
    assert.equal((await post(pdf, {}, '13')).status, 403);
    assert.equal((await post(pdf, {}, '14')).status, 401);
    assert.equal((await post(pdf, {}, '15')).status, 403);
    assert.equal(state.proofs.length, 0);
  });
});

test('el límite real es 8 MiB inclusive y el exceso responde 413', async () => {
  await fixture(async ({ post, state }) => {
    const exact = Buffer.alloc(MAX_PROOF_BYTES, 0x41); pdf.copy(exact);
    assert.equal((await post(exact)).status, 201);
    assert.equal(state.proofs[0].size_bytes, MAX_PROOF_BYTES);
    const oversized = Buffer.alloc(MAX_PROOF_BYTES + 1, 0x41); pdf.copy(oversized);
    assert.equal((await post(oversized)).status, 413);
    assert.equal(state.proofs.length, 1);
  });
});

test('fallos de INSERT y cambios de familia eliminan el archivo solo tras descartar su índice', async () => {
  await fixture(async ({ uploads, state, post }) => {
    state.failInsert = true;
    assert.equal((await post()).status, 500);
    assert.deepEqual(await fs.readdir(uploads), []);
    assert.ok(state.sql.some(q => q.includes('WHERE stored_name = ?')));
    state.failInsert = false; state.failInsertAfterWrite = true;
    assert.equal((await post()).status, 500);
    assert.deepEqual(await fs.readdir(uploads), []);
    assert.equal(state.proofs.length, 0); // el ROLLBACK revierte incluso el INSERT aceptado
    state.failInsertAfterWrite = false; state.accountChanged = true;
    assert.equal((await post()).status, 409);
    assert.deepEqual(await fs.readdir(uploads), []);
    assert.equal(state.proofs.length, 0);
  });
});

test('una respuesta de COMMIT perdida se reconcilia por clave y no deja índices sin archivo', async () => {
  await fixture(async ({ uploads, state, post, request }) => {
    state.commitBehavior = 'accepted';
    const response = await post();
    assert.equal(response.status, 201);
    const { id } = await response.json();
    const row = state.proofs.find(proof => proof.id === id);
    assert.ok(row);
    assert.deepEqual(await fs.readFile(path.join(uploads, row.stored_name)), pdf);
    assert.equal((await request(`/api/admin/transfer-proofs/${id}/download`, { headers: admin })).status, 200);
    assert.ok(state.sql.some(q => q.includes('WHERE stored_name = ?') && q.endsWith('FOR UPDATE')));
    state.commitBehavior = 'rejected';
    assert.equal((await post()).status, 500);
    assert.deepEqual(await fs.readdir(uploads), [row.stored_name]);
    assert.equal(state.proofs.length, 1);
  });
});

test('la reconciliación espera al COMMIT todavía en curso antes de decidir si falta el índice', async () => {
  await fixture(async ({ uploads, state, post }) => {
    state.commitBehavior = 'pending';
    state.commitGate = deferred();
    state.commitReached = deferred();
    const responsePromise = post();
    try {
      await Promise.race([state.commitReached.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('COMMIT no alcanzado')), 3000))]);
      const deadline = Date.now() + 3000;
      while (state.sql.filter(q => q.startsWith('SELECT id FROM families')).length < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(state.sql.filter(q => q.startsWith('SELECT id FROM families')).length, 2);
      assert.equal(state.sql.some(q => q.includes('WHERE stored_name = ?')), false);
      assert.equal((await fs.readdir(uploads)).length, 1);
    } finally { state.commitGate.resolve(); }
    const response = await responsePromise;
    assert.equal(response.status, 201);
    const row = state.proofs[0];
    assert.deepEqual(await fs.readFile(path.join(uploads, row.stored_name)), pdf);
  });
});

test('si no se puede reconciliar se conserva en cuarentena y se cuenta localmente en la cuota', async () => {
  await fixture(async ({ uploads, state, post }) => {
    state.proofs.push(...Array.from({ length: MAX_FAMILY_PROOFS - 1 }, (_, i) => ({
      id: `existente-${i}`, family_id: state.familyId, size_bytes: 1,
    })));
    state.commitBehavior = 'rejected';
    state.failReconcile = true;
    assert.equal((await post()).status, 500);
    const files = await fs.readdir(uploads);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}$/);
    assert.deepEqual(await fs.readFile(path.join(uploads, files[0])), pdf);
    assert.equal((await fs.stat(path.join(uploads, files[0]))).mode & 0o777, 0o600);
    state.failReconcile = false;
    assert.equal((await post()).status, 409);
    assert.deepEqual(await fs.readdir(uploads), files);
  });
});

test('si se pierde COMMIT y también falla la consulta, conserva el archivo incluso si ya hay índice', async () => {
  await fixture(async ({ uploads, state, post, request }) => {
    state.commitBehavior = 'accepted';
    state.failReconcile = true;
    assert.equal((await post()).status, 500);
    const row = state.proofs[0];
    assert.ok(row);
    assert.deepEqual(await fs.readFile(path.join(uploads, row.stored_name)), pdf);
    const download = await request(`/api/admin/transfer-proofs/${row.id}/download`, { headers: admin });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  });
});

test('un fallo de borrado deja el archivo privado identificado y lo cuenta en la cuota local', async () => {
  await fixture(async ({ uploads, state, post }) => {
    state.proofs.push(...Array.from({ length: MAX_FAMILY_PROOFS - 1 }, (_, i) => ({
      id: `existente-${i}`, family_id: state.familyId, size_bytes: 1,
    })));
    const unlink = fs.unlink;
    fs.unlink = async filename => {
      if (String(filename).startsWith('/proc/self/fd/')) throw new Error('simulated filesystem failure');
      return unlink(filename);
    };
    try {
      state.accountChanged = true;
      assert.equal((await post()).status, 409);
    } finally { fs.unlink = unlink; }
    const files = await fs.readdir(uploads);
    assert.equal(files.length, 1);
    assert.deepEqual(await fs.readFile(path.join(uploads, files[0])), pdf);
    state.accountChanged = false;
    assert.equal((await post()).status, 409);
  });
});

test('la cuota por familia se verifica bajo bloqueo entre subidas simultáneas y no afecta a otra familia', async () => {
  await fixture(async ({ uploads, state, post }) => {
    state.proofs.push(...Array.from({ length: MAX_FAMILY_PROOFS - 1 }, (_, i) => ({
      id: `existente-${i}`, family_id: state.familyId, size_bytes: 1,
    })));
    const responses = await Promise.all([post(), post()]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    assert.equal(state.proofs.filter(proof => proof.family_id === state.familyId).length, MAX_FAMILY_PROOFS);
    assert.equal((await fs.readdir(uploads)).length, 1);
    assert.equal((await post(pdf, {}, '16')).status, 201);
    assert.equal((await fs.readdir(uploads)).length, 2);
    assert.ok(state.sql.some(q => q === 'SELECT id FROM families WHERE id = ? FOR UPDATE'));
  });
});

test('la cuota por bytes permite el límite exacto y rechaza la siguiente subida antes de escribir', async () => {
  await fixture(async ({ uploads, state, post }) => {
    state.proofs.push({ id: 'existente', family_id: state.familyId, size_bytes: MAX_FAMILY_PROOF_BYTES - pdf.length });
    assert.equal((await post()).status, 201);
    assert.equal((await fs.readdir(uploads)).length, 1);
    assert.equal((await post()).status, 409);
    assert.equal((await fs.readdir(uploads)).length, 1);
  });
});

test('el límite por proceso no encola subidas y libera los huecos al terminar', async () => {
  await fixture(async ({ state, post }) => {
    state.getConnectionGate = deferred();
    state.connectionsWaiting = deferred();
    const uploads = Array.from({ length: MAX_CONCURRENT_PROOF_UPLOADS }, () => post());
    try {
      await Promise.race([state.connectionsWaiting.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('subidas no alcanzaron la base')), 3000))]);
      const refused = await post();
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('retry-after'), '30');
    } finally { state.getConnectionGate.resolve(); }
    assert.deepEqual((await Promise.all(uploads)).map(response => response.status), Array(MAX_CONCURRENT_PROOF_UPLOADS).fill(201));
    assert.equal((await post()).status, 201);
  });
});

test('un cliente desconectado no libera el hueco si su operación de base sigue en curso', async () => {
  await fixture(async ({ state, post, request }) => {
    state.getConnectionGate = deferred();
    state.connectionsWaiting = deferred();
    const controller = new AbortController();
    const disconnected = request('/api/member/transfer-proof', {
      method: 'POST', body: pdf, signal: controller.signal, headers: {
        Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/octet-stream',
        'X-File-Name': 'prueba.pdf', 'X-Test-User': '11',
      },
    }).catch(error => error);
    const rest = Array.from({ length: MAX_CONCURRENT_PROOF_UPLOADS - 1 }, () => post());
    try {
      await Promise.race([state.connectionsWaiting.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('subidas no alcanzaron la base')), 3000))]);
      controller.abort();
      assert.equal((await disconnected).name, 'AbortError');
      assert.equal((await post()).status, 503);
    } finally { state.getConnectionGate.resolve(); }
    assert.deepEqual((await Promise.all(rest)).map(response => response.status), Array(MAX_CONCURRENT_PROOF_UPLOADS - 1).fill(201));
    assert.equal((await post()).status, 201);
  });
});

test('los cuerpos interrumpidos liberan los huecos de subida', async () => {
  await fixture(async ({ base, post }) => {
    const partial = Array.from({ length: MAX_CONCURRENT_PROOF_UPLOADS }, () => {
      const req = http.request(`${base}/api/member/transfer-proof`, { method: 'POST', headers: {
        Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/octet-stream',
        'X-File-Name': 'prueba.pdf', 'X-Test-User': '11', 'Content-Length': String(MAX_PROOF_BYTES),
      } });
      req.on('error', () => {});
      req.write(pdf);
      return req;
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal((await post()).status, 503);
    } finally { partial.forEach(req => req.destroy()); }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await post()).status, 201);
  });
});

test('la descarga rechaza rutas manipuladas, enlaces, archivos alterados e id inválido', async () => {
  await fixture(async ({ temporary, uploads, state, request, post }) => {
    const response = await post();
    const { id } = await response.json();
    const row = state.proofs[0], realName = row.stored_name;
    const get = proofId => request(`/api/admin/transfer-proofs/${proofId}/download`, { headers: admin });
    assert.equal((await get('1')).status, 404);
    row.stored_name = '../fuera';
    assert.equal((await get(id)).status, 404);
    const outside = path.join(temporary, 'fuera');
    await fs.writeFile(outside, pdf, { mode: 0o600 });
    const linkName = 'a'.repeat(64);
    await fs.symlink(outside, path.join(uploads, linkName));
    row.stored_name = linkName;
    assert.equal((await get(id)).status, 404);
    await fs.unlink(path.join(uploads, linkName));
    await fs.link(outside, path.join(uploads, linkName));
    assert.equal((await get(id)).status, 404);
    await fs.unlink(path.join(uploads, linkName));
    row.stored_name = realName;
    await fs.writeFile(path.join(uploads, realName), Buffer.alloc(pdf.length, 0x61));
    assert.equal((await get(id)).status, 404);
    assert.deepEqual(await fs.readFile(outside), pdf);
  });
});

test('la frecuencia de subida está limitada por IP', async () => {
  await fixture(async ({ post }) => {
    for (let i = 0; i < 12; i++) assert.equal((await post(Buffer.from('incorrecto'))).status, 415);
    assert.equal((await post()).status, 429);
  });
});

test.after(async () => { await db.end(); });
