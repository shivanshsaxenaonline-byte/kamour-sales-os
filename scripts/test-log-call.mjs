// Proof tests for call logging (migration 026 + logCall server action).
//
// The action deliberately uses no SECURITY DEFINER — it relies on the
// `followups_write` RLS policy. These tests check that reliance is actually
// sound, by writing as impersonated users the way PostgREST does.
//
// One transaction, rolled back.
//
//   node scripts/test-log-call.mjs

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-logcall-tests',
});

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

const as = async (uid) => {
  await c.query('select set_config($1,$2,true)', [
    'request.jwt.claims', JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await c.query('set local role authenticated');
};
const asPostgres = async () => { await c.query('set local role postgres'); };

let sp = 0;
const attempt = async (sql, params = []) => {
  const name = `t${++sp}`;
  await c.query(`savepoint ${name}`);
  try {
    const rows = (await c.query(sql, params)).rows;
    await c.query(`release savepoint ${name}`);
    return { rows };
  } catch (e) {
    await c.query(`rollback to savepoint ${name}`);
    return { error: e.message };
  }
};

async function main() {
  await c.connect();
  await c.query('begin');

  const execs = (await c.query(
    `select id, full_name from users where role = 'sales_exec' and is_active order by full_name`)).rows;
  if (execs.length < 2) throw new Error('need two active sales execs to test isolation');
  const [repA, repB] = execs;
  const auditor = (await c.query(`select id from users where role='auditor' limit 1`)).rows[0].id;
  const number = (await c.query(`select id from contact_numbers order by sort_order limit 1`)).rows[0].id;

  // A customer owned by repA, with one open follow-up of theirs.
  const cust = (await c.query(
    `select customer_id, open_followup_id, last_order_id from v_rrr_queue
      where open_followup_id is not null and last_order_id is not null limit 1`)).rows[0];
  await c.query(`update customers set current_owner_id = $1 where id = $2`, [repA.id, cust.customer_id]);
  await c.query(`update followups set owner_id = $1 where id = $2`, [repA.id, cust.open_followup_id]);

  console.log('\nLogging a call\n');

  await as(repA.id);
  const logged = await attempt(
    `update followups set outcome='order_placed', completed_at=now(), contact_number_id=$2,
            remark='test', owner_id=$3
      where id = $1 and completed_at is null returning id`,
    [cust.open_followup_id, number, repA.id]);
  ok('the owning rep can log their own call', logged.rows?.length === 1, logged.error);

  const contactSaved = (await c.query(
    `select contact_number_id from followups where id=$1`, [cust.open_followup_id])).rows[0];
  ok('the business number used is recorded', contactSaved.contact_number_id === number);

  // Scheduling the next attempt is an INSERT, which the same policy must allow.
  const next = await attempt(
    `insert into followups (customer_id, kind, order_id, due_at, owner_id, attempt_no)
     values ($1,'order',$2, now() + interval '3 days', $3, 2) returning id`,
    [cust.customer_id, cust.last_order_id, repA.id]);
  ok('the rep can schedule the next follow-up', next.rows?.length === 1, next.error);

  await asPostgres();

  console.log('\nIsolation\n');

  // A second rep must not be able to touch it. Under RLS this is not an
  // error — the row is simply invisible, so zero rows update. Silence and
  // success look identical from the client, which is why this is asserted.
  const openOther = (await c.query(
    `select f.id from followups f join customers cu on cu.id = f.customer_id
      where f.completed_at is null and cu.current_owner_id = $1 limit 1`, [repA.id])).rows[0];

  await as(repB.id);
  const stolen = await attempt(
    `update followups set outcome='order_placed', completed_at=now()
      where id = $1 and completed_at is null returning id`, [openOther.id]);
  ok("another rep cannot log someone else's call",
     !stolen.error && stolen.rows.length === 0,
     stolen.error ?? `updated ${stolen.rows?.length} rows`);

  const peek = await attempt(`select id from followups where id = $1`, [openOther.id]);
  ok("another rep cannot even see it", peek.rows?.length === 0, `saw ${peek.rows?.length} rows`);

  await asPostgres();

  console.log('\nThe auditor stays read-only here\n');

  await as(auditor);
  const auditorLog = await attempt(
    `update followups set outcome='order_placed', completed_at=now()
      where id = $1 and completed_at is null returning id`, [openOther.id]);
  ok('an auditor cannot log a call (assignment was the only exception)',
     !!auditorLog.error || auditorLog.rows.length === 0,
     auditorLog.error ?? `updated ${auditorLog.rows?.length} rows`);

  await asPostgres();

  console.log('\nWhat may be stored\n');

  const badOutcome = await attempt(
    `update followups set outcome = 'sold_maybe' where id = $1`, [openOther.id]);
  ok('an outcome outside the allowed list is refused',
     !!badOutcome.error && /followups_outcome_check/.test(badOutcome.error),
     badOutcome.error ?? 'no error raised');

  const orphan = await attempt(
    `insert into followups (customer_id, kind, due_at) values ($1,'order', now())`,
    [cust.customer_id]);
  ok('a follow-up with no parent is refused',
     !!orphan.error && /one_parent/.test(orphan.error), orphan.error ?? 'no error raised');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await c.query('rollback');
  await c.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('test run failed:', e.message);
  try { await c.query('rollback'); await c.end(); } catch {}
  process.exit(1);
});
