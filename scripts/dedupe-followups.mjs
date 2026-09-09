// Remove follow-ups duplicated by re-running import-ai-queue.mjs while its
// idempotency key was broken.
//
//   node scripts/dedupe-followups.mjs            dry run
//   node scripts/dedupe-followups.mjs --commit   apply
//
// The bug: due_at is written at 00:00 IST, which is 18:30 UTC the PREVIOUS
// day. The dedupe key read `due_at::date` in a UTC database, so it returned
// the day before the sheet's Selection Date and never matched — every re-run
// re-imported the entire call log.
//
// A genuine second call to the same customer on the same day exists in this
// data and must survive. So identity here is the whole imported row, not just
// customer and date: two rows with the same customer, due date, outcome and
// remark are the same call recorded twice. The earliest is kept, because a
// later copy may have been re-pointed at a merged order.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const COMMIT = process.argv.includes('--commit');

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300_000,
  application_name: 'kamour-dedupe-followups',
});

async function main() {
  await c.connect();
  await c.query('begin');

  const before = (await c.query(
    `select count(*)::int n from followups where kind = 'order'`)).rows[0].n;

  const deleted = await c.query(`
    delete from followups f
     using (
       select id,
              row_number() over (
                partition by customer_id, due_at,
                             coalesce(outcome, ''), coalesce(remark, ''), attempt_no
                order by created_at, id
              ) as rn
         from followups
        where kind = 'order'
     ) d
     where f.id = d.id and d.rn > 1
  `);

  const after = (await c.query(
    `select count(*)::int n from followups where kind = 'order'`)).rows[0].n;

  const remainingDupes = (await c.query(`
    select count(*)::int groups from (
      select 1 from followups where kind = 'order'
       group by customer_id, due_at, coalesce(outcome,''), coalesce(remark,''), attempt_no
      having count(*) > 1) x`)).rows[0].groups;

  console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY RUN (nothing written)'}\n`);
  console.log(`queue follow-ups  ${before} -> ${after}   (deleted ${deleted.rowCount})`);
  console.log(`identical groups still present: ${remainingDupes}`);

  const spread = await c.query(`
    select coalesce(outcome, '(none)') as outcome, count(*)::int n
      from followups where kind = 'order' group by 1 order by 2 desc`);
  console.table(spread.rows);

  if (COMMIT) await c.query('commit');
  else { await c.query('rollback'); console.log('rolled back — re-run with --commit to keep it'); }
  await c.end();
}

main().catch(async (e) => {
  console.error('\ndedupe failed:', e.message);
  try { await c.query('rollback'); await c.end(); } catch {}
  process.exit(1);
});
