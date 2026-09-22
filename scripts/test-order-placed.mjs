// "Order placed", proved against the live schema. All writes roll back.
//
// What it has to show: the note is compulsory, a next date is refused, the
// task closes instead of booking another call, and the call is stored as the
// conversion outcome the analytics count. Then the same outcome on a WATI
// hand-over, where the customer's never-worked RRR task goes with it — and a
// task a rep has already worked does not.
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-order-placed-test' });
let failures = 0;
function check(label, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
}
async function as(id) {
  await db.query('set local role postgres');
  await db.query('select set_config($1,$2,true)',
    ['request.jwt.claims', JSON.stringify({ sub: id, role: 'authenticated' })]);
  await db.query('set local role authenticated');
}
async function probe(sql, params = []) {
  await db.query('savepoint p');
  try {
    const result = await db.query(sql, params);
    await db.query('release savepoint p');
    return { rows: result.rows };
  } catch (error) {
    await db.query('rollback to savepoint p');
    return { error: error.message };
  }
}

try {
  await db.connect();
  await db.query('begin');

  const rep = (await db.query(`select u.id, a.email from users u
    join auth.users a on a.id = u.id
    where u.role = 'sales_exec' and u.is_active order by u.full_name limit 1`)).rows[0];
  const alka = (await db.query(`select id from users where role = 'auditor'
    and is_active order by full_name limit 1`)).rows[0];
  if (!rep || !alka) throw new Error('Need an active sales_exec and an auditor');
  // This rep must start with nothing open, exactly as in test-rrr-work.mjs —
  // live assignments would otherwise be read back as ours.
  for (const table of ['rrr_work_items', 'wati_work_items']) {
    await db.query(`update ${table} set completed_at = now(), last_called_at = null
      where completed_at is null and assigned_to = $1`, [rep.id]);
  }
  const orders = (await db.query(`select o.id, o.customer_id, c.phone_e164 from orders o
    join customers c on c.id = o.customer_id
    where o.stage = 'delivered' and o.delivered_at is not null
      and o.course_duration_days in (15,30) and not c.is_dnd
      and c.merged_into_id is null
      and not exists (select 1 from rrr_work_items w
                       where w.customer_id = o.customer_id and w.completed_at is null)
    limit 2`)).rows;
  if (orders.length < 2) throw new Error('Need two delivered course orders on free customers');
  const [first, second] = orders;
  const number = (await db.query(
    'select id from contact_numbers where is_active order by sort_order limit 1')).rows[0];
  const { tomorrow } = (await db.query(
    'select (ist_today() + 1)::text as tomorrow')).rows[0];

  // ---- an order on an RRR task ----
  await as(alka.id);
  const assigned = await probe(`select fn_assign_rrr_work('medicine_ending',$1::uuid[],$2) as n`,
    [[first.id], rep.id]);
  check('auditor assigns a calling task', assigned.rows?.[0]?.n === 1, assigned.error);

  await as(rep.id);
  const work = (await probe(
    'select id from rrr_work_items where completed_at is null')).rows?.[0];
  check('rep sees the assigned task', !!work);

  const noNote = await probe(
    `select fn_log_assigned_rrr_call($1,'order_placed','  ',null,$2,null) as r`,
    [work.id, number?.id ?? null]);
  check('order placed without a note is refused', !!noNote.error, noNote.error);

  const dated = await probe(
    `select fn_log_assigned_rrr_call($1,'order_placed','GP60 5495',$2,$3,null) as r`,
    [work.id, tomorrow, number?.id ?? null]);
  check('order placed with a next date is refused', !!dated.error, dated.error);

  const logged = await probe(
    `select fn_log_assigned_rrr_call($1,'order_placed','GP60 5495 COD',null,$2,null) as r`,
    [work.id, number?.id ?? null]);
  check('order placed with a note and no date is saved',
    logged.rows?.[0]?.r?.scheduledNext === false, logged.error);

  const task = await probe(
    'select last_outcome, completed_at from rrr_work_items where id = $1', [work.id]);
  check('the task is closed, outcome order_placed',
    task.rows?.[0]?.last_outcome === 'order_placed' && task.rows?.[0]?.completed_at !== null,
    task.error ?? JSON.stringify(task.rows?.[0]));

  // Read the follow-up as the auditor: `sales_rrr_followups_only` narrows a
  // rep to customers with an open task, and this order has just closed theirs.
  await as(alka.id);
  const call = await probe(`select outcome, remark, next_due_at
    from followups where customer_id = $1 and outcome = 'order_placed'
    order by completed_at desc limit 1`, [first.customer_id]);
  check('the call is the conversion row the analytics count',
    call.rows?.[0]?.remark === 'GP60 5495 COD' && call.rows?.[0]?.next_due_at === null,
    call.error ?? JSON.stringify(call.rows?.[0]));

  const open = await probe(`select count(*)::int n from followups
    where customer_id = $1 and completed_at is null
      and (due_at at time zone 'Asia/Kolkata')::date <= ist_today() + 7`,
    [first.customer_id]);
  check('no follow-up was booked for the week ahead', open.rows?.[0]?.n === 0,
    open.error ?? JSON.stringify(open.rows?.[0]));

  // ---- an order on a WATI hand-over clears the same customer's RRR task ----
  const rrrTask = await probe(`select fn_assign_rrr_work('medicine_ending',$1::uuid[],$2) as n`,
    [[second.id], rep.id]);
  check('the second customer gets an RRR task too', rrrTask.rows?.[0]?.n === 1, rrrTask.error);
  const watiLead = {
    id: crypto.randomUUID(), phone: second.phone_e164, name: 'Known Customer Chat',
    source: 'Wati Elementor', intent: 8, concern: 'Repeat order',
  };
  const handed = await probe('select fn_assign_wati_work($1,$2::jsonb) as n',
    [rep.email, JSON.stringify([watiLead])]);
  check('the same customer is handed over from WATI too',
    handed.rows?.[0]?.n === 1, handed.error);

  await as(rep.id);
  const wati = (await probe(`select id, customer_id from wati_work_items
    where completed_at is null order by assigned_at desc limit 1`)).rows?.[0];
  check('the WATI task knows the customer', wati?.customer_id === second.customer_id,
    JSON.stringify(wati));

  const watiDated = await probe(
    `select fn_log_wati_call($1,'order_placed','GP30 2985',$2,$3,null) as r`,
    [wati.id, tomorrow, number?.id ?? null]);
  check('a WATI order with a next date is refused', !!watiDated.error, watiDated.error);

  const watiOrder = await probe(
    `select fn_log_wati_call($1,'order_placed','GP30 2985 prepaid',null,$2,null) as r`,
    [wati.id, number?.id ?? null]);
  check('a WATI order is saved and says what it closed',
    watiOrder.rows?.[0]?.r?.scheduledNext === false
      && watiOrder.rows?.[0]?.r?.tasksClosed === 1,
    watiOrder.error ?? JSON.stringify(watiOrder.rows?.[0]?.r));

  const cleared = await probe(`select count(*)::int n from rrr_work_items
    where customer_id = $1 and completed_at is null`, [second.customer_id]);
  check('the customer is not still waiting in an RRR list',
    cleared.rows?.[0]?.n === 0, cleared.error ?? JSON.stringify(cleared.rows?.[0]));

  // ---- a task a rep has actually worked is history, not clutter ----
  await as(alka.id);
  const reassigned = await probe(`select fn_assign_rrr_work('medicine_ending',$1::uuid[],$2) as n`,
    [[second.id], rep.id]);
  check('the customer can be assigned again', reassigned.rows?.[0]?.n === 1, reassigned.error);
  const secondLead = { ...watiLead, id: crypto.randomUUID() };
  const handedAgain = await probe('select fn_assign_wati_work($1,$2::jsonb) as n',
    [rep.email, JSON.stringify([secondLead])]);
  check('and handed over from WATI again', handedAgain.rows?.[0]?.n === 1, handedAgain.error);

  await as(rep.id);
  const workedTask = (await probe(`select id from rrr_work_items
    where customer_id = $1 and completed_at is null`, [second.customer_id])).rows?.[0];
  const worked = await probe(
    `select fn_log_assigned_rrr_call($1,'no_answer','',ist_today()+3,$2,null) as r`,
    [workedTask.id, number?.id ?? null]);
  check('the RRR task is worked and left open', !worked.error, worked.error);

  const wati2 = (await probe(`select id from wati_work_items
    where completed_at is null order by assigned_at desc limit 1`)).rows?.[0];
  const keptOrder = await probe(
    `select fn_log_wati_call($1,'order_placed','DC60 repeat',null,$2,null) as r`,
    [wati2.id, number?.id ?? null]);
  check('a WATI order leaves a worked RRR task alone',
    keptOrder.rows?.[0]?.r?.tasksClosed === 0,
    keptOrder.error ?? JSON.stringify(keptOrder.rows?.[0]?.r));
  const kept = await probe('select count(*)::int n from rrr_work_items where id = $1',
    [workedTask.id]);
  check('the worked task is still there', kept.rows?.[0]?.n === 1,
    kept.error ?? JSON.stringify(kept.rows?.[0]));

  await db.query('rollback');
} catch (error) {
  console.error(error.message);
  failures++;
  try { await db.query('rollback'); } catch { /* connection already gone */ }
} finally {
  await db.end();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
