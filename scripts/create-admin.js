import bcrypt from 'bcryptjs';
import db from '../server/lib/db.js';

const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administración').trim().slice(0,160);
if (!process.env.DATABASE_URL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || [...password].length < 12 || Buffer.byteLength(password) > 72) {
  console.error('Configura DATABASE_URL, BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (mínimo 12 caracteres y máximo 72 bytes) como variables de entorno.');
  process.exit(1);
}
try {
  const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) {
    console.error('Ya existe una cuenta con ese correo. No se modificó.');
    process.exitCode = 1;
  } else {
    const hash = await bcrypt.hash(password, 12);
    await db.execute("INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,'admin',1)", [name,email,hash]);
    console.log('Cuenta administradora creada. Retira BOOTSTRAP_ADMIN_PASSWORD del entorno después de usarla.');
  }
} catch (error) {
  console.error('No se pudo crear la cuenta:', error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
