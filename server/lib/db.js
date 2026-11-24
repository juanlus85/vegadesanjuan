import mysql from 'mysql2/promise';

// Plesk supplies DATABASE_URL as a process environment variable. No .env file is read.
const url = process.env.DATABASE_URL;
if (!url) {
  console.warn('DATABASE_URL no está configurada; las operaciones con datos no estarán disponibles.');
}
// DATETIME values such as event times are wall-clock values chosen in Madrid.
// Return them as strings rather than silently converting them through the server timezone.
const db = mysql.createPool({
  uri: url || 'mysql://unconfigured:unconfigured@127.0.0.1:3306/unconfigured',
  dateStrings: true,
  enableKeepAlive: true,
});
export default db;
