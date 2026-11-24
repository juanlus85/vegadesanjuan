import nodemailer from 'nodemailer';
import db from './db.js';

export const EDITABLE_SETTINGS = Object.freeze({
  associationName: 160,
  contactEmail: 255,
  contactPhone: 40,
  smtpHost: 255,
  smtpPort: 5,
  smtpSecure: 5,
  smtpUser: 255,
  smtpFrom: 255,
  contactRecipients: 520,
});
export const PUBLIC_SETTINGS = ['associationName', 'contactEmail', 'contactPhone'];
const EMAIL = /^[^\s@<>(),;:\\"\[\]]+@[^\s@<>(),;:\\"\[\]]+\.[^\s@<>(),;:\\"\[\]]+$/u;
export function isEmail(value) { return typeof value === 'string' && value.length <= 254 && EMAIL.test(value); }

export async function getSettings(conn = db) {
  const [rows] = await conn.query('SELECT setting_key, setting_value FROM settings');
  const result = {};
  for (const row of rows) {
    if (Object.hasOwn(EDITABLE_SETTINGS, row.setting_key)) result[row.setting_key] = row.setting_value;
  }
  return result;
}

export function validateSetting(key, input) {
  if (!Object.hasOwn(EDITABLE_SETTINGS, key)) throw new Error(`Ajuste no permitido: ${key}`);
  if (key === 'smtpSecure' && typeof input === 'boolean') input = String(input);
  if (key === 'smtpPort' && typeof input === 'number') input = String(input);
  if (Array.isArray(input) && key === 'contactRecipients') input = input.join(',');
  if (typeof input !== 'string') throw new Error(`Valor no válido para ${key}.`);
  const value = input.trim();
  if (value.length > EDITABLE_SETTINGS[key] || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Valor no válido para ${key}.`);
  if (key === 'smtpPort' && value && (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error('Puerto SMTP no válido.');
  if (key === 'smtpSecure' && value && !['true', 'false'].includes(value)) throw new Error('La opción TLS SMTP no es válida.');
  if (['smtpFrom', 'contactEmail'].includes(key) && value && !isEmail(value)) throw new Error(`Correo no válido para ${key}.`);
  if (key === 'smtpHost' && value && (!/^[a-zA-Z0-9.-]+$/.test(value) || value.startsWith('.') || value.endsWith('.'))) throw new Error('Servidor SMTP no válido.');
  if (key === 'contactRecipients' && value) {
    const recipients = value.split(',').map(x => x.trim());
    if (recipients.length > 2 || recipients.some(x => !isEmail(x)) || new Set(recipients.map(x => x.toLowerCase())).size !== recipients.length) throw new Error('Introduce uno o dos destinatarios de correo válidos, separados por comas.');
    return recipients.join(', ');
  }
  return value;
}

export function mailConfigured(settings, requireRecipients = true) {
  try {
    if (!process.env.SMTP_PASSWORD || !settings.smtpHost || !settings.smtpPort || !settings.smtpUser || !settings.smtpFrom) return false;
    for (const key of ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpFrom']) validateSetting(key, settings[key] || '');
    if (requireRecipients) {
      if (!settings.contactRecipients) return false;
      validateSetting('contactRecipients', settings.contactRecipients);
    }
    return true;
  } catch { return false; }
}

// Nodemailer normally returns strings, but transports may return address objects.
function addressKey(value) {
  return (typeof value === 'string' ? value : value?.address || '').trim().toLowerCase();
}
function deliveryResults(recipients, accepted, rejected) {
  const acceptedSet = new Set((accepted || []).map(addressKey));
  const rejectedSet = new Set((rejected || []).map(addressKey));
  return recipients.map(recipient => ({
    recipient,
    status: acceptedSet.has(addressKey(recipient)) ? 'accepted'
      : rejectedSet.has(addressKey(recipient)) ? 'rejected' : 'unknown',
  }));
}

/** SMTP acceptance is not proof of delivery to the final inbox. No retries. */
export async function sendMail({ to, subject, text, replyTo, settings: supplied }) {
  const settings = supplied || await getSettings();
  if (!mailConfigured(settings, false)) throw new Error('El correo SMTP no está configurado.');
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length || recipients.length > 2 || recipients.some(address => !isEmail(address))) throw new Error('Destinatario no válido.');
  if (replyTo && !isEmail(replyTo)) throw new Error('Dirección de respuesta no válida.');
  if (typeof subject !== 'string' || /[\r\n]/.test(subject)) throw new Error('Asunto no válido.');
  const secure = settings.smtpSecure === 'true';
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost, port: Number(settings.smtpPort), secure,
    requireTLS: !secure, tls: { rejectUnauthorized: true },
    auth: { user: settings.smtpUser, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  try {
    let info;
    try {
      info = await transporter.sendMail({ from: settings.smtpFrom, to: recipients, replyTo, subject, text });
    } catch (error) {
      // A transport failure can occur after DATA; lack of confirmation is not proof of non-delivery.
      error.deliveries = deliveryResults(recipients, [], Array.isArray(error.rejected) ? error.rejected : []);
      throw error;
    }
    const deliveries = deliveryResults(recipients,
      Array.isArray(info.accepted) ? info.accepted : [], Array.isArray(info.rejected) ? info.rejected : []);
    if (!deliveries.some(result => result.status === 'accepted')) {
      const error = new Error('El servidor SMTP no confirmó ningún destinatario.');
      error.deliveries = deliveries;
      throw error;
    }
    return { deliveries };
  } finally { try { transporter.close(); } catch {} }
}
