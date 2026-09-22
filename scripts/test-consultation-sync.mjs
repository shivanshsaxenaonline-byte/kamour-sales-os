import fs from 'node:fs';
import pg from 'pg';

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]])
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL missing.');

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await db.connect();
  const { rows: [result] } = await db.query(`
    select
      (select count(*)::int from consultations) as consultations,
      (select count(*)::int from sheet_consultation_links) as linked_sheet_rows,
      (select max(last_success_at) from sheet_consultation_sync_sources) as last_success_at,
      exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'consultations'
      ) as realtime_enabled
  `);
  if (!result.consultations) throw new Error('Consultations are empty.');
  if (!result.linked_sheet_rows) throw new Error('No Consultation Sheet rows are linked.');
  if (!result.last_success_at) throw new Error('Consultation Sheet has not synced successfully.');
  if (!result.realtime_enabled) throw new Error('Consultations are not in the Realtime publication.');
  console.log(JSON.stringify(result));
} finally {
  await db.end();
}
