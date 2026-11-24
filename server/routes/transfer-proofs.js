import { Router, raw } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import db from '../lib/db.js';
import { requireUser, requireAdmin } from '../lib/auth.js';

export const MAX_PROOF_BYTES = 8 * 1024 * 1024;
export const MAX_CONCURRENT_PROOF_UPLOADS = 4;
export const MAX_FAMILY_PROOFS = 50;
export const MAX_FAMILY_PROOF_BYTES = 100 * 1024 * 1024;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const storedNamePattern = /^[a-f0-9]{64}$/;
const proofIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const extensions = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class ProofStorageError extends Error {
  constructor(message = 'El almacenamiento privado de justificantes no está disponible o no es seguro.') {
    super(message);
    this.code = 'TRANSFER_PROOF_STORAGE';
    this.status = 503;
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Plesk debe crear este directorio con propietario exclusivo del proceso Node,
// modo 0700 y padres no modificables por terceros. No se crean rutas automáticamente.
// El descriptor y /proc/self/fd fijan el directorio aun si se renombra durante una petición.
async function openUploadDirectory() {
  const configured = process.env.UPLOADS_DIR;
  if (!configured || !path.isAbsolute(configured)) {
    throw new ProofStorageError('UPLOADS_DIR es obligatorio y debe ser una ruta absoluta a un directorio privado.');
  }
  const resolved = path.resolve(configured);
  let dir;
  try {
    const canonical = await fs.realpath(resolved);
    const repository = await fs.realpath(projectRoot);
    if (canonical !== resolved || isInside(repository, canonical)) throw new Error('unsafe directory');
    dir = await fs.open(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await dir.stat();
    const anchoredPath = `/proc/self/fd/${dir.fd}`;
    // También comprueba que /proc esté montado y que el directorio abierto sea el esperado.
    if (await fs.realpath(anchoredPath) !== canonical || !stat.isDirectory() ||
        (stat.mode & 0o7777) !== 0o700 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('unsafe directory');
    }
    return { dir, anchoredPath };
  } catch {
    if (dir) await dir.close().catch(() => {});
    throw new ProofStorageError('UPLOADS_DIR debe existir, ser privado (0700), pertenecer al proceso, no contener enlaces simbólicos y estar fuera del proyecto; /proc debe estar disponible.');
  }
}

/** Comprobar la configuración al iniciar, no solo al recibir una subida. */
export async function validateUploadsDirectory() {
  const { dir } = await openUploadDirectory();
  await dir.close();
}

export function detectProofType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// Solo se usa como metadato y nombre de descarga; jamás como ruta del servidor.
export function sanitizeOriginalName(value) {
  const base = String(value).normalize('NFC').replace(/\\/g, '/').split('/').pop();
  const safe = base.replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"|?*]/gu, '_').trim().replace(/^\.+/, '').trim();
  return Array.from(safe).slice(0, 200).join('') || 'justificante';
}
function originalName(req) {
  const encoded = req.get('X-File-Name');
  if (!encoded || encoded.length > 3000) throw new HttpError(400, 'Falta o no es válido X-File-Name.');
  try { return sanitizeOriginalName(decodeURIComponent(encoded)); }
  catch { throw new HttpError(400, 'X-File-Name debe estar codificado con encodeURIComponent.'); }
}
function attachmentName(original, mime) {
  const name = sanitizeOriginalName(original);
  const stem = name.replace(/\.[^.]*$/u, '').trim() || 'justificante';
  return `${stem}${extensions[mime]}`;
}
function proofNotFound() { return new HttpError(404, 'No se encontró el justificante.'); }

function memberFamily(req, res, next) {
  if (req.session.role !== 'member' || !Number.isSafeInteger(req.session.familyId) || req.session.familyId < 1 ||
      !Number.isSafeInteger(req.session.userId) || req.session.userId < 1) {
    return res.status(403).json({ ok: false, error: 'Se requiere una cuenta de socio con familia.' });
  }
  return next();
}

const limiter = (limit, windowMs) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'Demasiados intentos. Vuelve a intentarlo más tarde.' }),
});

// Compartido por todos los routers de este proceso; no se acumulan peticiones en cola.
let activeUploads = 0;
const quarantinedByFamily = new Map();
const parseProofBody = raw({ type: 'application/octet-stream', limit: MAX_PROOF_BYTES, inflate: false });

function rememberQuarantine(familyId, size) {
  const previous = quarantinedByFamily.get(familyId) || { count: 0, bytes: 0 };
  quarantinedByFamily.set(familyId, { count: previous.count + 1, bytes: previous.bytes + size });
}

// La fila de familia es una barrera: el SELECT espera a que termine la transacción
// original, incluso si se perdió la respuesta de COMMIT. Usar el mismo primario
// InnoDB y que todas las subidas respeten este bloqueo es imprescindible.
async function reconcileProof(familyId, expected) {
  let connection;
  let started = false;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    started = true;
    const [families] = await connection.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (families.length !== 1) return 'unknown';
    const [rows] = await connection.execute(`SELECT id, family_id, user_id, original_name, mime_type, size_bytes
      FROM transfer_proofs WHERE stored_name = ? LIMIT 1 FOR UPDATE`, [expected.storedName]);
    if (rows.length === 0) return 'absent';
    const row = rows[0];
    if (rows.length === 1 && row.id === expected.id && Number(row.family_id) === familyId &&
        Number(row.user_id) === expected.userId && row.original_name === expected.name &&
        row.mime_type === expected.mime && Number(row.size_bytes) === expected.size) return 'present';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (connection) {
      if (started) {
        try { await connection.rollback(); connection.release(); }
        catch { connection.destroy(); }
      } else connection.destroy();
    }
  }
}

async function storeProof(req, res) {
  const name = originalName(req);
  const mime = detectProofType(req.body);
  if (!mime) throw new HttpError(415, 'Solo se admiten archivos PDF, JPEG o PNG con una firma válida.');
  const size = req.body.length;
  if (size > MAX_PROOF_BYTES) throw new HttpError(413, 'El justificante supera los 8 MiB.');
  const { dir, anchoredPath } = await openUploadDirectory();
  const id = randomUUID();
  const storedName = randomBytes(32).toString('hex');
  const filePath = `${anchoredPath}/${storedName}`;
  const familyId = req.session.familyId;
  let connection;
  let started = false;
  let insertAttempted = false;
  let commitAttempted = false;
  let committed = false;
  let file;
  let created = false;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    started = true;
    const [families] = await connection.execute('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId]);
    if (families.length !== 1) throw new HttpError(409, 'La cuenta o su familia han cambiado; vuelve a iniciar sesión.');
    // Es la primera lectura consistente tras adquirir el bloqueo de la familia.
    const [totals] = await connection.execute(`SELECT COUNT(*) AS proof_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM transfer_proofs WHERE family_id = ?`, [familyId]);
    const count = Number(totals[0]?.proof_count);
    const bytes = Number(totals[0]?.total_bytes);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('No se pudo comprobar la cuota de justificantes.');
    }
    // El recuento local de cuarentena es adicional y conservador: puede duplicar
    // índices ya confirmados y no sobrevive a reinicios ni cubre otros procesos.
    const quarantine = quarantinedByFamily.get(familyId) || { count: 0, bytes: 0 };
    if (count + quarantine.count >= MAX_FAMILY_PROOFS || bytes + quarantine.bytes + size > MAX_FAMILY_PROOF_BYTES) {
      throw new HttpError(409, 'La familia ha alcanzado la cuota de justificantes.');
    }
    try {
      file = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await file.writeFile(req.body);
      await file.sync();
      await file.close();
      file = undefined;
    } catch {
      throw new ProofStorageError();
    }
    // La relación se vuelve a comprobar en la misma sentencia que inserta el índice.
    // No se toca ninguna tabla de cobros, pagos ni el estado de la familia.
    insertAttempted = true;
    const [result] = await connection.execute(`INSERT INTO transfer_proofs
      (id, family_id, user_id, original_name, stored_name, mime_type, size_bytes)
      SELECT ?, u.family_id, u.id, ?, ?, ?, ? FROM users u
      WHERE u.id = ? AND u.family_id = ? AND u.role = 'member' AND u.active = TRUE`,
    [id, name, storedName, mime, size, req.session.userId, familyId]);
    if (result.affectedRows === 0) {
      insertAttempted = false;
      throw new HttpError(409, 'La cuenta o su familia han cambiado; vuelve a iniciar sesión.');
    }
    if (result.affectedRows !== 1) throw new Error('Resultado de inserción no reconocido.');
    commitAttempted = true;
    await connection.commit();
    committed = true;
    connection.release();
    connection = undefined;
    return res.status(201).json({ ok: true, id });
  } catch (error) {
    if (file) await file.close().catch(() => {});
    if (connection) {
      // Un ROLLBACK tras un COMMIT incierto podría ser un no-op y no lo aclara.
      if (commitAttempted || !started) connection.destroy();
      else {
        try { await connection.rollback(); connection.release(); }
        catch { connection.destroy(); }
      }
      connection = undefined;
    }
    if (created && !committed) {
      let outcome = 'absent';
      if (insertAttempted) {
        outcome = await reconcileProof(familyId, { id, storedName, userId: req.session.userId, name, mime, size });
      }
      if (outcome === 'present') return res.status(201).json({ ok: true, id });
      if (outcome === 'absent') {
        try { await fs.unlink(filePath); }
        catch {
          rememberQuarantine(familyId, size);
          console.error(`No se pudo eliminar un justificante; revisar familia ${familyId}, id ${id}, stored_name ${storedName}.`);
        }
      } else {
        // No moverlo: un COMMIT todavía podría confirmarse y la descarga necesita
        // esta ruta. Queda privado y solo es accesible si hay índice autorizado.
        rememberQuarantine(familyId, size);
        console.error(`Justificante en cuarentena pendiente de reconciliar: familia ${familyId}, id ${id}, stored_name ${storedName}.`);
      }
    }
    throw error;
  } finally {
    await dir.close().catch(() => {});
  }
}

function boundedUpload(req, res, next) {
  if (activeUploads >= MAX_CONCURRENT_PROOF_UPLOADS) {
    res.set('Retry-After', '30');
    return res.status(503).json({ ok: false, error: 'Hay demasiadas subidas simultáneas. Inténtalo de nuevo.' });
  }
  activeUploads++;
  let released = false;
  const release = () => { if (!released) { released = true; activeUploads--; } };
  // Evita que una petición que nunca termine de enviar el cuerpo retenga un hueco indefinidamente.
  const timer = setTimeout(() => req.destroy(), 120_000);
  timer.unref();
  try {
    parseProofBody(req, res, error => {
      clearTimeout(timer);
      if (error) { release(); return next(error); }
      return Promise.resolve().then(() => storeProof(req, res)).then(release, failure => { release(); next(failure); });
    });
  } catch (error) {
    clearTimeout(timer);
    release();
    return next(error);
  }
}

export function createTransferProofRouter() {
  const router = Router();
  const uploadLimit = limiter(12, 60 * 60 * 1000);
  const downloadLimit = limiter(120, 15 * 60 * 1000);
  router.post('/member/transfer-proof', uploadLimit, requireUser, memberFamily, (req, res, next) => {
    if ((req.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
      return res.status(415).json({ ok: false, error: 'Se requiere application/octet-stream.' });
    }
    return next();
  }, boundedUpload);

  router.get('/admin/transfer-proofs', requireAdmin, wrap(async (_req, res) => {
    const [proofs] = await db.execute(`SELECT p.id, p.family_id, p.original_name, p.created_at, f.address, u.name
      FROM transfer_proofs p JOIN families f ON f.id = p.family_id JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC, p.id DESC`);
    res.set('Cache-Control', 'private, no-store');
    return res.json({ ok: true, proofs });
  }));

  router.get('/admin/transfer-proofs/:id/download', downloadLimit, requireAdmin, wrap(async (req, res) => {
    if (!proofIdPattern.test(req.params.id)) throw proofNotFound();
    const [rows] = await db.execute('SELECT stored_name, original_name, mime_type, size_bytes FROM transfer_proofs WHERE id = ? LIMIT 1', [req.params.id]);
    const proof = rows[0];
    if (!proof || !storedNamePattern.test(proof.stored_name) || !Object.hasOwn(extensions, proof.mime_type) ||
        !Number.isSafeInteger(Number(proof.size_bytes)) || Number(proof.size_bytes) < 1 || Number(proof.size_bytes) > MAX_PROOF_BYTES) throw proofNotFound();
    const { dir, anchoredPath } = await openUploadDirectory();
    let file;
    try {
      try {
        file = await fs.open(`${anchoredPath}/${proof.stored_name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw proofNotFound();
        throw new ProofStorageError();
      }
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size !== Number(proof.size_bytes)) throw proofNotFound();
      const header = Buffer.alloc(Math.min(8, stat.size));
      await file.read(header, 0, header.length, 0);
      if (detectProofType(header) !== proof.mime_type) throw proofNotFound();
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.attachment(attachmentName(proof.original_name, proof.mime_type));
      res.type(proof.mime_type);
      res.set('Content-Length', String(stat.size));
      await pipeline(file.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }), res);
    } finally {
      if (file) await file.close().catch(() => {});
      await dir.close().catch(() => {});
    }
  }));
  return router;
}

export default createTransferProofRouter();
