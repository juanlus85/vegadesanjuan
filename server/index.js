import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './lib/db.js';
import { createSessionMiddleware, checkOrigin } from './lib/auth.js';
import { startAnnualScheduler } from './lib/annual.js';
import coreRouter from './routes/core.js';
import eventsRouter from './routes/events.js';
import stripeRouter, { webhookHandler } from './routes/stripe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'private, no-store');
  next();
});

// Stripe signatures require the original request body, before JSON parsing and sessions.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), webhookHandler);
app.use(express.json({ limit: '128kb' }));

app.get('/api/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'Base de datos no disponible.' }); }
});
app.use('/api', createSessionMiddleware());
app.use('/api', checkOrigin);
app.use('/api', coreRouter, eventsRouter, stripeRouter);
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada.' }));
app.use((error, _req, res, _next) => {
  console.error('Error al procesar una solicitud:', error?.message || 'error desconocido');
  if (res.headersSent) return;
  if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'Ya existe un registro con esos datos.' });
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message = status < 500 && error instanceof SyntaxError ? 'El JSON de la solicitud no es válido.'
    : status < 500 && typeof error?.message === 'string' ? error.message.slice(0, 300)
    : 'No se pudo completar la operación.';
  return res.status(status).json({ ok: false, error: message });
});

app.use(express.static(dist, { index: false, fallthrough: true, maxAge: '1h' }));
const pageMeta = {
  '/': ['Vega de San Juan | Asociación de Vecinos', 'Asociación de Vecinos Vega de San Juan, en San Juan de Aznalfarache. Un barrio que nos une.'],
  '/asociacion': ['La asociación | Vega de San Juan', 'Conoce los objetivos, el ámbito y las actividades de la Asociación de Vecinos Vega de San Juan.'],
  '/contacto': ['Contacto | Vega de San Juan', 'Contacta con la Asociación de Vecinos Vega de San Juan.'],
  '/alta': ['Hazte socio | Vega de San Juan', 'Forma parte de la asociación. La cuota anual es de 20 € por vivienda.'],
  '/acceso': ['Acceso de socios | Vega de San Juan', 'Accede al área de socios de la Asociación de Vecinos Vega de San Juan.'],
};
app.get('/sitemap.xml', (_req, res) => {
  const origin = process.env.APP_ORIGIN;
  if (!origin || !/^https:\/\/[^/]+$/.test(origin)) return res.status(503).type('text/plain').send('Origen no configurado.');
  const entries = Object.keys(pageMeta).filter(p => p !== '/acceso').map(p => `<url><loc>${origin}${p}</loc></url>`).join('');
  return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
});
app.get('*', async (req, res) => {
  const isPrivate = /^\/(socios|admin)(\/|$)/.test(req.path);
  const meta = pageMeta[req.path];
  if (!meta && !isPrivate) return res.status(404).type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Página no encontrada</title><h1>Página no encontrada</h1><p><a href="/">Volver al inicio</a></p></html>');
  try {
    let html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
    if (meta) {
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${meta[0]}</title>`)
        .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${meta[1]}" />`);
      if (process.env.APP_ORIGIN && /^https:\/\/[^/]+$/.test(process.env.APP_ORIGIN)) html = html.replace('</head>', `<link rel="canonical" href="${process.env.APP_ORIGIN}${req.path}" /></head>`);
    } else {
      html = html.replace('</head>', '<meta name="robots" content="noindex,nofollow" /></head>');
      res.set('Cache-Control', 'private, no-store');
    }
    return res.type('html').send(html);
  } catch { return res.status(503).type('text/plain').send('La aplicación aún no está compilada. Ejecuta npm run build.'); }
});

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto no válido.');
startAnnualScheduler();
app.listen(port, '0.0.0.0', () => console.log(`Aplicación lista en el puerto ${port}.`));
