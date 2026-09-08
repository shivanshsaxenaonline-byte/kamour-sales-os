// RLS proof tests — Phase 0 step 4.
//
// These impersonate a real `authenticated` JWT (set role + request.jwt.claims),
// which is exactly what PostgREST does. Testing as `postgres` would prove
// nothing: the superuser bypasses RLS.
//
// Everything runs inside one transaction that is rolled back, so the database
// is untouched.
//
//   node scripts/test-rls.mjs

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-rls-tests',
});

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

const U = {
  execA:   '00000000-0000-0000-0000-0000000000a1',
  execB:   '00000000-0000-0000-0000-0000000000b1',
  manager: '00000000-0000-0000-0000-0000000000c1',
  doctor:  '00000000-0000-0000-0000-0000000000d1',
  ops:     '00000000-0000-0000-0000-0000000000e1',
  ceo:     '00000000-0000-0000-0000-0000000000f1',
};

// Become a given user for the next statements, the way PostgREST does.
const as = async (uid) => {
  await c.query('select set_config($1,$2,true)', [
    'request.jwt.claims',
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await c.query('set local role authenticated');
};
const asPostgres = async () => { await c.query('set local role postgres'); };

// count rows visible to the current identity. An error is a distinct outcome
// from "zero rows" and must never be silently counted as either.
let lastErr = null;
const visible = async (sql, params = []) => {
  lastErr = null;
  await c.query('savepoint sp_v');
  try { const r = await c.query(sql, params); await c.query('release savepoint sp_v'); return r.rowCount; }
  catch (e) { lastErr = e.message; await c.query('rollback to savepoint sp_v'); return -1; }
};

const run = async () => {
  await c.connect();
  await c.query('begin');
  try {
    // ---------------- fixtures ----------------
    for (const [name, id] of Object.entries(U)) {
      await c.query(
        `insert into auth.users(id, instance_id, aud, role, email)
         values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2)`,
        [id, `${name}@kamour.test`]
      );
    }
    await c.query(
      `insert into users(id, full_name, role, manager_id) values
        ($1,'Exec A','sales_exec',$3),
        ($2,'Exec B','sales_exec',$3),
        ($3,'Manager','sales_manager',null),
        ($4,'Doctor','doctor',null),
        ($5,'Ops','ops',null),
        ($6,'CEO','ceo',null)`,
      [U.execA, U.execB, U.manager, U.doctor, U.ops, U.ceo]
    );

    const mkCustomer = async (phone, name, owner) =>
      (await c.query(
        `insert into customers(phone_e164, full_name, original_owner_id, current_owner_id)
         values ($1,$2,$3,$3) returning id`, [phone, name, owner]
      )).rows[0].id;

    const custA = await mkCustomer('+919990000001', 'Customer of A', U.execA);
    const custB = await mkCustomer('+919990000002', 'Customer of B', U.execB);
    const custPool = (await c.query(
      `insert into customers(phone_e164, full_name) values ('+919990000003','Pool Person')
       returning id`)).rows[0].id;

    const src = (await c.query(`select id from lead_sources where code='elementor'`)).rows[0].id;
    const st  = (await c.query(`select id from lead_statuses where code='new'`)).rows[0].id;

    const mkLead = async (cust, owner) =>
      (await c.query(
        `insert into leads(customer_id, source_id, status_id, owner_id)
         values ($1,$2,$3,$4) returning id`, [cust, src, st, owner]
      )).rows[0].id;

    const leadA = await mkLead(custA, U.execA);
    const leadB = await mkLead(custB, U.execB);
    await mkLead(custPool, null);              // unassigned → the pool

    const orderB = (await c.query(
      `insert into orders(customer_id, amount, course_duration_days,
                          original_owner_id, current_owner_id, stage, dispatch_date)
       values ($1, 2499, 15, $2, $2, 'dispatched', current_date) returning id`,
      [custB, U.execB]
    )).rows[0].id;

    const consultB = (await c.query(
      `insert into consultations(customer_id, doctor_id, state)
       values ($1,$2,'pending') returning id`, [custB, U.doctor]
    )).rows[0].id;

    // ---------------- the actual tests ----------------
    console.log('\nsales_exec isolation (the crafted-API-call requirement)');
    await as(U.execA);
    ok('exec A sees own lead', await visible('select 1 from leads where id=$1', [leadA]) === 1);
    ok("exec A CANNOT see exec B's lead",
       await visible('select 1 from leads where id=$1', [leadB]) === 0);
    ok('exec A sees only 1 lead in an unfiltered scan',
       await visible('select 1 from leads') === 1);
    let n = await visible('select 1 from customers where id=$1', [custB]);
    ok("exec A CANNOT see exec B's customer", n === 0, `rowCount=${n} ${lastErr ?? ''}`);
    n = await visible('select 1 from orders where id=$1', [orderB]);
    ok("exec A CANNOT see exec B's order", n === 0, `rowCount=${n} ${lastErr ?? ''}`);

    const updated = (await c.query(
      'update leads set is_junk = true where id = $1 returning id', [leadB])).rowCount;
    ok("exec A CANNOT update exec B's lead (0 rows affected, silent by design)", updated === 0);

    console.log('\nthe pool: rows denied at the table, masked through the view');
    ok('exec A cannot see the unassigned lead in the base table',
       await visible('select 1 from leads where owner_id is null') === 0);
    // Filtered to the fixture: real imported data now fills the pool too, so a
    // hardcoded count would only measure the size of the import.
    const pool = await c.query(
      'select full_name, phone_masked from v_pool_leads where customer_id = $1', [custPool]);
    ok('exec A sees the pool lead through v_pool_leads', pool.rowCount === 1);
    ok(`phone is masked: ${pool.rows[0]?.phone_masked}`,
       /^\d{2}••••\d{4}$/.test(pool.rows[0]?.phone_masked ?? ''));
    ok('the raw phone is NOT in the pool view',
       !JSON.stringify(pool.rows).includes('+919990000003'));

    console.log('\nsales_manager sees the team');
    await asPostgres(); await as(U.manager);
    ok('manager sees both execs\' leads', await visible('select 1 from leads') >= 2);
    ok('manager sees both customers',
       await visible('select 1 from customers where id in ($1,$2)', [custA, custB]) === 2);

    console.log('\ndoctor reaches customers only through their consultations');
    await asPostgres(); await as(U.doctor);
    ok('doctor sees the consultation assigned to them',
       await visible('select 1 from consultations where id=$1', [consultB]) === 1);
    ok("doctor sees that consultation's customer",
       await visible('select 1 from customers where id=$1', [custB]) === 1);
    ok('doctor sees NO leads', await visible('select 1 from leads') === 0);
    ok('doctor sees an unrelated customer? (must be 0)',
       await visible('select 1 from customers where id=$1', [custA]) === 0);

    console.log('\nops sees dispatched orders, never the sales floor');
    await asPostgres(); await as(U.ops);
    ok('ops sees the dispatched order',
       await visible('select 1 from orders where id=$1', [orderB]) === 1);
    ok('ops sees NO leads', await visible('select 1 from leads') === 0);

    console.log('\nceo reads everything, writes nothing');
    await asPostgres(); await as(U.ceo);
    // Counted against the true totals rather than hardcoded: real imported data
    // now sits alongside the fixtures, and "sees all" is the property under test.
    await asPostgres();
    const totalLeads  = (await c.query('select count(*)::int n from leads')).rows[0].n;
    const totalOrders = (await c.query('select count(*)::int n from orders')).rows[0].n;
    await as(U.ceo);
    ok(`ceo sees all ${totalLeads} leads`,   await visible('select 1 from leads')  === totalLeads);
    ok(`ceo sees all ${totalOrders} orders`, await visible('select 1 from orders') === totalOrders);
    // A policy violation aborts the transaction, so every denied write needs
    // its own savepoint or the rest of the suite runs against a dead session.
    let ceoWrote;
    await c.query('savepoint sp_ceo');
    try {
      ceoWrote = (await c.query(
        `insert into leads(customer_id, source_id, status_id) values ($1,$2,$3) returning id`,
        [custA, src, st])).rowCount;
    } catch { ceoWrote = 0; await c.query('rollback to savepoint sp_ceo'); }
    ok('ceo CANNOT insert a lead', ceoWrote === 0);

    console.log('\nanon (the public key) is locked out');
    await asPostgres();
    await c.query('set local role anon');
    ok('anon sees no leads',      await visible('select 1 from leads') <= 0);
    ok('anon sees no customers',  await visible('select 1 from customers') <= 0);
    ok('anon sees no orders',     await visible('select 1 from orders') <= 0);
    ok('anon cannot read the pool view', await visible('select 1 from v_pool_leads') <= 0);

    console.log('\nlookups stay readable, or every dropdown breaks');
    await asPostgres(); await as(U.execA);
    ok('lookups readable by an authenticated user',
       await visible('select 1 from lead_statuses') === 7);
    ok('products readable', await visible('select 1 from products') === 10);
  } catch (e) {
    fail++;
    console.log(`\n  ERROR  ${e.message}`);
  }

  await c.query('rollback');
  await c.end();

  console.log(`\n${pass} passed, ${fail} failed — test transaction rolled back`);
  process.exitCode = fail ? 1 : 0;
};

run();
