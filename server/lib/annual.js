import db from './db.js';

export function madridYear(at = new Date()) {
  return Number(new Intl.DateTimeFormat('en', {timeZone: 'Europe/Madrid', year: 'numeric'}).format(at));
}

// A charge is created only after January 1 has actually arrived in Madrid.
// The unique (family_id, year) key prevents repetition on restarts/concurrent workers.
export async function synchronizeAnnualCharges(at = new Date()) {
  const year = madridYear(at);
  if (year >= 2026) {
    await db.execute(`INSERT IGNORE INTO charges (family_id,kind,year,description,amount_cents,due_date,status)
      SELECT id,'annual',2026,'Cuota 2026 — exenta',0,'2026-01-01','exempt' FROM families
      WHERE status = 'active' AND YEAR(created_at) <= 2026`);
  }
  // Do not invent past liabilities for periods when a family may have been inactive.
  // Historical adjustments must be reviewed and entered by an administrator.
  if (year >= 2027) {
    const y = year;
    await db.execute(`INSERT IGNORE INTO charges (family_id,kind,year,description,amount_cents,due_date,status)
      SELECT id,'annual',?, ?,2000,?,'pending' FROM families
      WHERE status = 'active' AND YEAR(created_at) <= ?`, [y, `Cuota anual ${y}`, `${y}-01-01`, y]);
  }
}

export function startAnnualScheduler() {
  const run = () => synchronizeAnnualCharges().catch(error => console.error('Cuotas anuales:', error.message));
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
