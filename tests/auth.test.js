import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/lib/db.js';
import { requireAdmin } from '../server/lib/auth.js';

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('un fallo de MySQL se propaga y no autoriza por el rol guardado en sesión', async () => {
  const original = db.execute;
  const failure = new Error('Base de datos no disponible');
  db.execute = async () => { throw failure; };
  try {
    const req = { session: { userId: 42, role: 'admin' } };
    const res = response();
    const calls = [];
    await requireAdmin(req, res, error => calls.push(error));
    assert.deepEqual(calls, [failure]);
  } finally { db.execute = original; }
});

test('una revocación de administrador surte efecto en la siguiente solicitud', async () => {
  const original = db.execute;
  db.execute = async () => [[{ id: 42, family_id: 7, role: 'member', active: 1 }]];
  try {
    const req = { session: { userId: 42, role: 'admin' } };
    const res = response();
    let called = false;
    await requireAdmin(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(req.session.role, 'member');
  } finally { db.execute = original; }
});

test.after(async () => { await db.end(); });
