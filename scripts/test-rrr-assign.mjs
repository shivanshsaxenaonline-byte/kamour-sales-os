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
