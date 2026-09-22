// Rebuild today's AI list after a dated import or generator change.
import fs from 'node:fs';
import pg from 'pg';

pg.types.setTypeParser(1082, (value) => value);

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'kamour-refresh-ai-daily' });
try {
  await db.connect();
  await db.query('begin');
  const date = (await db.query('select ist_today() as date')).rows[0].date;
  const generated = Number((await db.query('select fn_generate_ai_daily_leads($1::date, true) as count', [date])).rows[0].count);
  const rows = (await db.query(`
    select u.full_name as rep, count(*)::int as leads,
      count(*) filter (where l.reason like 'Carried over from %')::int as carried
    from ai_daily_leads l join users u on u.id = l.owner_id
    where l.run_on = $1 group by u.full_name order by u.full_name`, [date])).rows;
  const expected = Number((await db.query(`
    select coalesce(sum(coalesce(daily_lead_cap, 15)),0)::int as count
    from users where is_active and role in ('sales_exec','sales_manager')
      and coalesce(daily_lead_cap,15) > 0`)).rows[0].count);
  if (generated !== expected || rows.reduce((n, row) => n + row.leads, 0) !== expected) {
    throw new Error(`AI list count mismatch: generated ${generated}, expected ${expected}`);
  }
  await db.query('commit');
  console.log(JSON.stringify({ date, generated, reps: rows }, null, 2));
} catch (error) {
  try { await db.query('rollback'); } catch {}
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
