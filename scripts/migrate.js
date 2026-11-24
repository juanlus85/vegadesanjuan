import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../server/lib/db.js';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Configúrala en el entorno de Node.js de Plesk.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  let statementCount = 0;
  for (const filename of ['schema.sql', 'history.sql', 'subscriptions.sql']) {
    const sql = await fs.readFile(path.join(root, 'database', filename), 'utf8');
    // These bundled migrations contain standalone comments and simple DDL only.
    // Strip full-line comments so a trailing comment never becomes an empty query.
    const statements = sql.replace(/^\s*--.*$/gm, '').split(/;\s*(?:\n|$)/).map(x => x.trim()).filter(Boolean);
    for (const statement of statements) await db.query(statement);
    statementCount += statements.length;
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [mark] = await connection.execute('INSERT IGNORE INTO app_migrations (migration_key) VALUES (?)', ['2026-cartero-real-draft']);
    if (mark.affectedRows === 1) {
      await connection.execute(`INSERT INTO events
        (title,description,starts_at,location,published,tickets_enabled,member_price_cents,guest_price_cents,price_confirmed)
        VALUES (?,?,?,?,0,1,250,400,0)`, [
        'Cartero Real',
        'Borrador: confirmar año, hora, lugar y precio reducido antes de publicar o habilitar la venta. La hora 00:00 es solo un marcador.',
        '2026-12-13 00:00:00', ''
      ]);
      console.log('Creado un borrador no publicado del Cartero Real para que la asociación confirme los datos.');
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  console.log(`Esquema comprobado: ${statementCount} tablas o instrucciones. No se han borrado datos.`);
} catch (error) {
  console.error('No se pudo preparar el esquema:', error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
