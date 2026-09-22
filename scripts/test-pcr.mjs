import fs from 'node:fs';
import pg from 'pg';

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL missing.');

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await db.connect();
  const { rows: [queue] } = await db.query(`
    select count(*)::int as total,
           count(*) filter (where priority_rank = 0)::int as missed,
           count(*) filter (where priority_rank = 1)::int as upcoming,
           count(*) filter (where priority_rank = 2)::int as date_missing,
           count(*) filter (where priority_rank = 3)::int as cycle_complete,
           count(*) filter (where converted)::int as converted,
           count(*) filter (where owner_id is null)::int as unassigned,
           min(booking_date) as oldest_booking,
           max(booking_date) as newest_booking
    from pcr_leads
    where is_active
  `);
  const { rows: [team] } = await db.query(`
    select count(*)::int as active_salespeople
    from users
    where is_active and role in ('sales_exec', 'sales_manager')
  `);
  if (!queue.total) throw new Error('PCR sync produced no active records.');
  console.log(JSON.stringify({ ...queue, ...team }));
} finally {
  await db.end();
}
