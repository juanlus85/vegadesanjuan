import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/lib/db.js';
import { madridYear, synchronizeAnnualCharges } from '../server/lib/annual.js';

test('el año cambia al comenzar el 1 de enero en Madrid', () => {
  assert.equal(madridYear(new Date('2026-12-31T22:59:59Z')), 2026);
  assert.equal(madridYear(new Date('2026-12-31T23:00:00Z')), 2027);
});

test('2026 solo contempla la exención, nunca una cuota de 2027', async () => {
  const original = db.execute;
  const calls = [];
  db.execute = async (...args) => { calls.push(args); return [[], []]; };
  try {
    await synchronizeAnnualCharges(new Date('2026-12-31T22:59:59Z'));
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /exempt/);
    assert.equal(calls[0][1], undefined);
  } finally { db.execute = original; }
});

test('desde 2027 se crea una cuota anual de 20 € mediante inserción idempotente', async () => {
  const original = db.execute;
  const calls = [];
  db.execute = async (...args) => { calls.push(args); return [[], []]; };
  try {
    await synchronizeAnnualCharges(new Date('2026-12-31T23:00:00Z'));
    assert.equal(calls.length, 2);
    assert.match(calls[1][0], /INSERT IGNORE/);
    assert.match(calls[1][0], /2000/);
    assert.deepEqual(calls[1][1], [2027, 'Cuota anual 2027', '2027-01-01', 2027]);
  } finally { db.execute = original; }
});

test('no se inventan cuotas de años anteriores en una reactivación', async () => {
  const original = db.execute;
  const calls = [];
  db.execute = async (...args) => { calls.push(args); return [[], []]; };
  try {
    await synchronizeAnnualCharges(new Date('2029-02-01T12:00:00Z'));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1][1], [2029, 'Cuota anual 2029', '2029-01-01', 2029]);
  } finally { db.execute = original; }
});

test.after(async () => { await db.end(); });
