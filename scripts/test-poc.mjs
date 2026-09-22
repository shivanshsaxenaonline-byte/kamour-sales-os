import fs from 'node:fs';
import pg from 'pg';

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL missing.');

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect();
  const { rows: [result] } = await db.query(`
    select count(*)::int as total,
           count(*) filter (where consultation_date is null)::int as date_missing,
           count(*) filter (where owner_id is null)::int as unassigned,
           count(*) filter (
             where lower(btrim(prescription_status)) <> 'yes'
                or lower(btrim(medicine_purchased)) <> 'no'
           )::int as invalid_filter_rows,
           min(consultation_date) as oldest_consultation,
           max(consultation_date) as newest_consultation
    from poc_leads
    where is_active
  `);
  if (!result.total) throw new Error('POC sync produced no active records.');
  if (result.invalid_filter_rows) throw new Error('POC includes records outside the requested filter.');
  console.log(JSON.stringify(result));
} finally {
  await db.end();
}
