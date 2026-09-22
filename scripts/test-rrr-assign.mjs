// Proof tests for the RRR tab's assignment path (migration 025).
//
// The UI hides the assign controls from roles that may not assign, but hiding
// a control is not a security boundary — a crafted PostgREST call skips the
// UI entirely. These tests impersonate a real `authenticated` JWT, exactly as
// PostgREST does, and check the database itself refuses.
//
// Everything runs in one transaction that is rolled back.
//
//   node scripts/test-rrr-assign.mjs

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
  application_name: 'kamour-rrr-tests',
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

// Returns { rows } or { error }. An error and an empty result are different
// outcomes and must never be conflated.
//
// Each attempt runs inside a savepoint: half of these tests EXPECT the
// database to raise, and a raised error otherwise poisons the surrounding
// transaction so every later test dies with "current transaction is aborted".
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

  const who = Object.fromEntries((await c.query(
    `select role, id from users where role in
       ('auditor','coo','admin','sales_exec','ops','doctor') and is_active
     order by role`)).rows.map((r) => [r.role, r.id]));

  const rep = (await c.query(
    `select id from users where role = 'sales_exec' and is_active order by full_name limit 1`)).rows[0].id;
  const victims = (await c.query(
    `select customer_id from v_rrr_queue limit 3`)).rows.map((r) => r.customer_id);

  console.log('\nRRR assignment — who may assign\n');

  // --- the auditor: the deliberate, narrow exception (D-065) ---
  await as(who.auditor);
  const auditorAssign = await attempt(
    'select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n', [victims, rep]);
  ok('auditor CAN assign through the function', !auditorAssign.error, auditorAssign.error);

  // ...but only through it. Everything else must still be refused.
  const auditorDirect = await attempt(
    `update customers set current_owner_id = $1 where id = $2`, [rep, victims[0]]);
  ok('auditor still cannot UPDATE customers directly',
     auditorDirect.rows?.length === 0 || auditorDirect.error !== undefined ||
     (await c.query('select current_owner_id from customers where id=$1', [victims[0]])).rows[0].current_owner_id === rep);
  const auditorOrder = await attempt(
    `update orders set amount = 1 where customer_id = $1`, [victims[0]]);
  ok('auditor still cannot change an order amount',
     auditorOrder.error !== undefined || (await c.query(
       'select count(*)::int n from orders where customer_id=$1 and amount=1', [victims[0]])).rows[0].n === 0);

  await asPostgres();

  // --- roles that must be refused outright ---
  // A skipped test is announced, never silent. Every doctor account on this
  // instance is deactivated and the app layout blocks an inactive user before
  // any query runs, so there is no doctor session to defend against — but the
  // day one is reactivated, this line starts testing instead of skipping.
  for (const role of ['sales_exec', 'ops', 'doctor']) {
    if (!who[role]) { console.log(`  SKIP  ${role} is refused — no active user with this role`); continue; }
    await as(who[role]);
    const r = await attempt('select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n', [victims, rep]);
    ok(`${role} is refused`, !!r.error && /not permitted/i.test(r.error), r.error ?? 'no error raised');
    await asPostgres();
  }

  // --- oversight roles that must be allowed ---
  for (const role of ['coo', 'admin']) {
    if (!who[role]) continue;
    await as(who[role]);
    const r = await attempt('select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n', [victims, rep]);
    ok(`${role} can assign`, !r.error, r.error);
    await asPostgres();
  }

  console.log('\nWhat may be assigned, and to whom\n');

  await as(who.admin ?? who.coo);

  // ops is active and is not a salesperson — the role check, isolated.
  const toOps = await attempt(
    'select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n', [victims, who.ops]);
  ok('cannot assign an RRR lead to a non-salesperson (ops)',
     !!toOps.error && /salesperson/i.test(toOps.error), toOps.error ?? 'no error raised');

  // Every doctor on this instance is deactivated, so this exercises the
  // is_active check rather than the role check. Both must refuse.
  const inactive = (await c.query(
    `select id from users where not is_active limit 1`)).rows[0];
  if (!inactive) throw new Error('test needs at least one deactivated user');
  const toInactive = await attempt(
    'select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n', [victims, inactive.id]);
  ok('cannot assign to a deactivated user',
     !!toInactive.error && /deactivated/i.test(toInactive.error), toInactive.error ?? 'no error raised');

  const ghost = await attempt(
    'select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n',
    [victims, '00000000-0000-0000-0000-00000000dead']);
  ok('cannot assign to a user that does not exist',
     !!ghost.error && /does not exist/i.test(ghost.error), ghost.error ?? 'no error raised');

  const unassign = await attempt(
    'select fn_assign_rrr_customers($1::uuid[], null) as n', [victims]);
  ok('can put leads back in the unassigned pool', !unassign.error, unassign.error);

  const empty = await attempt('select fn_assign_rrr_customers($1::uuid[], $2::uuid) as n', [[], rep]);
  ok('empty selection is a no-op, not an error', !empty.error && empty.rows[0].n === 0, empty.error);

  console.log('\nSide effects\n');

  await asPostgres();
  await as(who.auditor);
  await c.query('select fn_assign_rrr_customers($1::uuid[], $2::uuid)', [[victims[0]], rep]);
  await asPostgres();

  const audit = (await c.query(
    `select changed_by, new_value from audit_log
      where table_name = 'customers' and field = 'owner_id' and record_id = $1
      order by changed_at desc limit 1`, [victims[0]])).rows[0];
  ok("the auditor's assignment is recorded in audit_log",
     !!audit && audit.changed_by === who.auditor && audit.new_value === rep,
     audit ? `changed_by=${audit.changed_by}` : 'no audit row written');

  const openFu = (await c.query(
    `select count(*)::int n from followups
      where customer_id = $1 and completed_at is null and owner_id is distinct from $2`,
    [victims[0], rep])).rows[0].n;
  ok('open follow-ups moved to the new owner', openFu === 0, `${openFu} left behind`);

  const doneFu = (await c.query(
    `select count(*)::int n from followups
      where customer_id = $1 and completed_at is not null and owner_id = $2
        and owner_id is distinct from $2`, [victims[0], rep])).rows[0].n;
  ok('completed follow-ups keep their original owner (history not rewritten)', doneFu === 0);

  // --- the handover the All-customers tab actually makes --------------------
  // Owning a customer stopped meaning anything to a rep at the 14 September
  // cutover: their day is rrr_work_items, and the restrictive
  // `sales_rrr_customers_only` policy hides everything else. So the test that
  // matters is not "did current_owner_id change" - it is "can the rep see it".
  console.log('\nAll-customers assign hands over the call\n');

  await asPostgres();
  const handover = (await c.query(
    `select v.customer_id from v_rrr_queue v
      where not exists (select 1 from rrr_work_items w
                        where w.customer_id = v.customer_id and w.completed_at is null)
      limit 3`)).rows.map((r) => r.customer_id);

  await as(who.auditor);
  const both = await attempt(
    'select fn_assign_rrr_customers_with_work($1::uuid[], $2::uuid) as r', [handover, rep]);
  ok('auditor can assign customer and call in one action', !both.error, both.error);
  ok('every selected customer became a calling task',
     both.rows?.[0]?.r?.tasks === handover.length,
     JSON.stringify(both.rows?.[0]?.r));

  await asPostgres();
  const owned = (await c.query(
    'select count(*)::int n from customers where id = any($1::uuid[]) and current_owner_id = $2',
    [handover, rep])).rows[0].n;
  ok('ownership moved with it', owned === handover.length, owned + ' of ' + handover.length);

  // The point of the whole exercise.
  await as(rep);
  const repSees = await attempt(
    `select count(*)::int n from rrr_work_items w
      where w.customer_id = any($1::uuid[]) and w.assigned_to = auth.uid()
        and w.completed_at is null`, [handover]);
  ok('the rep sees the leads on their own list',
     repSees.rows?.[0]?.n === handover.length,
     repSees.error ?? (repSees.rows?.[0]?.n + ' of ' + handover.length));
  const repReads = await attempt(
    'select count(*)::int n from customers where id = any($1::uuid[])', [handover]);
  ok('the rep can open those customers', repReads.rows?.[0]?.n === handover.length,
     repReads.error ?? (repReads.rows?.[0]?.n + ' of ' + handover.length));

  await asPostgres();
  await as(who.auditor);
  const pool = await attempt(
    'select fn_assign_rrr_customers_with_work($1::uuid[], null) as r', [handover]);
  ok('back to the pool withdraws the calling task too',
     pool.rows?.[0]?.r?.tasks === handover.length,
     pool.error ?? JSON.stringify(pool.rows?.[0]?.r));
  await asPostgres();
  const left = (await c.query(
    `select count(*)::int n from rrr_work_items
      where customer_id = any($1::uuid[]) and completed_at is null`, [handover])).rows[0].n;
  ok('no task left behind', left === 0, left + ' still open');

  // One DND customer in a batch of three must not fail the other two.
  await c.query('update customers set is_dnd = true where id = $1', [handover[0]]);
  await as(who.auditor);
  const mixed = await attempt(
    'select fn_assign_rrr_customers_with_work($1::uuid[], $2::uuid) as r', [handover, rep]);
  ok('a DND customer is skipped, not fatal',
     !mixed.error && mixed.rows?.[0]?.r?.skipped === 1
       && mixed.rows?.[0]?.r?.tasks === handover.length - 1,
     mixed.error ?? JSON.stringify(mixed.rows?.[0]?.r));
  await asPostgres();
  await c.query('update customers set is_dnd = false where id = $1', [handover[0]]);

  await as(who.sales_exec);
  const repAssigns = await attempt(
    'select fn_assign_rrr_customers_with_work($1::uuid[], $2::uuid)', [handover, rep]);
  ok('a sales exec cannot hand leads out through the combined function',
     !!repAssigns.error && /not permitted/i.test(repAssigns.error),
     repAssigns.error ?? 'no error raised');
  await asPostgres();
  await as(who.auditor);
  const badTarget = await attempt(
    'select fn_assign_rrr_customers_with_work($1::uuid[], $2::uuid)', [handover, who.ops]);
  ok('the combined function still refuses a non-salesperson target',
     !!badTarget.error, badTarget.error ?? 'no error raised');
  await asPostgres();

  // --- a handover is a fresh task, not the last one with a new name on it ---
  // Most of Due today already has an open task: the rep called yesterday, got
  // no answer, and the follow-up came back round. Re-assigning used to carry
  // that call across, so the Due screen thought the new rep had already rung
  // and never struck the row through, and an inherited future date could park
  // the lead in the rep's Upcoming tab instead of today's calls.
  console.log('\nRe-assigning a lead that was already called\n');

  const carried = handover[1];
  await c.query(
    `update rrr_work_items set assigned_to = $1, last_outcome = 'no_answer',
       last_called_at = now() - interval '1 day', medicine_days_left = 4,
       due_on = ist_today() + 30
     where customer_id = $2 and completed_at is null`, [rep, carried]);

  await as(who.auditor);
  const again = await attempt(
    `select fn_assign_rrr_work('due', array[$1]::uuid[], $2::uuid) as n`, [carried, rep]);
  ok('re-assigning an already-called lead succeeds', !again.error, again.error);
  await asPostgres();

  const fresh = (await c.query(
    `select last_outcome, last_called_at, medicine_days_left,
            due_on = ist_today() as due_today
       from rrr_work_items where customer_id = $1 and completed_at is null`, [carried])).rows[0];
  ok('the previous rep\'s call does not come with it',
     fresh?.last_outcome === null && fresh?.last_called_at === null
       && fresh?.medicine_days_left === null,
     JSON.stringify(fresh));
  ok('a lead handed over today is due today, not on the old date',
     fresh?.due_today === true, JSON.stringify(fresh));

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
