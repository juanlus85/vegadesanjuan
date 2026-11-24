import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import db from './db.js';

const MySQLStore = MySQLStoreFactory(session);
const sessionAge = 1000 * 60 * 60 * 12;

function applicationOrigin() {
  const value = process.env.APP_ORIGIN;
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value.replace(/\/$/, '') || !['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return null;
    return parsed.origin;
  } catch { return null; }
}

/** Mount once, after setting trust proxy correctly, before all API routes. */
export function createSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  const origin = applicationOrigin();
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('SESSION_SECRET debe tener al menos 32 bytes.');
  if (!origin) throw new Error('APP_ORIGIN debe ser un origen HTTPS explícito o localhost HTTP.');
  const secure = origin.startsWith('https:');
  const store = new MySQLStore({
    createDatabaseTable: true,
    endConnectionOnClose: false,
    expiration: sessionAge,
    clearExpired: true,
  }, db);
  // Reject startup-store errors without logging connection credentials.
  store.onReady().catch(() => console.error('No se pudo inicializar el almacén MySQL de sesiones.'));
  return session({
    name: 'vega.sid', secret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure, sameSite: secure ? 'none' : 'lax', maxAge: sessionAge, path: '/' },
  });
}

/** Also mount this globally on /api, including routers supplied by other modules. */
export function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const configured = applicationOrigin();
  if (!configured) return res.status(503).json({ ok: false, error: 'El origen de la aplicación no está configurado correctamente.' });
  const origin = req.get('Origin');
  if (origin && origin !== configured) return res.status(403).json({ ok: false, error: 'Origen de la solicitud no autorizado.' });
  if (!origin && req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ ok: false, error: 'Solicitud de origen cruzado no autorizada.' });
  // Reject browser form submissions and text/plain JSON CSRF; webhook must bypass this middleware.
  const contentType = (req.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (req.method === 'POST' && req.path === '/member/transfer-proof' && contentType === 'application/octet-stream') {
    if (origin !== configured || req.get('X-Requested-With') !== 'XMLHttpRequest') {
      return res.status(403).json({ ok: false, error: 'La subida requiere el origen de la aplicación y X-Requested-With: XMLHttpRequest.' });
    }
    return next();
  }
  if (req.method !== 'DELETE' && contentType !== 'application/json') return res.status(415).json({ ok: false, error: 'Se requiere contenido JSON.' });
  return next();
}

export async function requireUser(req, res, next) {
  try {
    if (!req.session?.userId) return res.status(401).json({ ok: false, error: 'Debes iniciar sesión.' });
    const [rows] = await db.execute('SELECT id, family_id, role, active FROM users WHERE id = ? LIMIT 1', [req.session.userId]);
    const user = rows[0];
    if (!user || !user.active) {
      req.session.destroy(() => {});
      return res.status(401).json({ ok: false, error: 'La sesión ya no es válida.' });
    }
    // A role/family change takes effect immediately, rather than trusting a stale cookie.
    req.session.userId = Number(user.id);
    req.session.familyId = user.family_id == null ? null : Number(user.family_id);
    req.session.role = user.role;
    return next();
  } catch (error) { return next(error); }
}

export function requireAdmin(req, res, next) {
  return requireUser(req, res, error => {
    if (error) return next(error);
    if (req.session.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo para administradores.' });
    return next();
  });
}
