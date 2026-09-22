// "Other" outcome, proved against the live schema. All writes roll back.
//
// What it has to show: the note is compulsory, the next date is tomorrow and
// nothing else, and after the call the customer is genuinely back in the work
// — an open follow-up due tomorrow (what /rrr/due reads) and a task still open
// with due_on = tomorrow (what a rep's own list reads).
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-other-outcome-test' });
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

  const rep = (await db.query(`select id from users where role = 'sales_exec'
    and is_active order by full_name limit 1`)).rows[0];
  const alka = (await db.query(`select id from users where role = 'auditor'
    and is_active order by full_name limit 1`)).rows[0];
  if (!rep || !alka) throw new Error('Need an active sales_exec and an auditor');
  // This rep must start the test with nothing open, exactly as in
  // test-rrr-work.mjs — live assignments would otherwise be read back as ours.
  for (const table of ['rrr_work_items', 'wati_work_items']) {
    await db.query(`update ${table} set completed_at = now(), last_called_at = null
      where completed_at is null and assigned_to = $1`, [rep.id]);
  }
  const order = (await db.query(`select o.id, o.customer_id from orders o
    join customers c on c.id = o.customer_id
    where o.stage = 'delivered' and o.delivered_at is not null
      and o.course_duration_days in (15,30) and not c.is_dnd
      and c.merged_into_id is null limit 1`)).rows[0];
  if (!order) throw new Error('Need one delivered course order to assign');
  const number = (await db.query(
    'select id from contact_numbers where is_active order by sort_order limit 1')).rows[0];
  const { today, tomorrow, later } = (await db.query(`select ist_today()::text as today,
    (ist_today() + 1)::text as tomorrow, (ist_today() + 4)::text as later`)).rows[0];

  await as(alka.id);
  const assigned = await probe(`select fn_assign_rrr_work('medicine_ending',$1::uuid[],$2) as n`,
    [[order.id], rep.id]);
  check('auditor assigns a calling task', assigned.rows?.[0]?.n === 1, assigned.error);

  await as(rep.id);
  const work = (await probe('select id from rrr_work_items')).rows?.[0];
  check('rep sees the assigned task', !!work);

  const empty = await probe(
    `select fn_log_assigned_rrr_call($1,'other','   ',$2,$3,null) as r`,
    [work.id, tomorrow, number?.id ?? null]);
  check('other without a note is refused', !!empty.error, empty.error);

  const wrongDay = await probe(
    `select fn_log_assigned_rrr_call($1,'other','shifted to Pune',$2,$3,null) as r`,
    [work.id, later, number?.id ?? null]);
  check('other with a date other than tomorrow is refused', !!wrongDay.error, wrongDay.error);

  const noDay = await probe(
    `select fn_log_assigned_rrr_call($1,'other','shifted to Pune',null,$2,null) as r`,
    [work.id, number?.id ?? null]);
  check('other with no next date is refused', !!noDay.error, noDay.error);

  const logged = await probe(
    `select fn_log_assigned_rrr_call($1,'other','Hospital mein hai, agle hafte baat karenge',$2,$3,null) as r`,
    [work.id, tomorrow, number?.id ?? null]);
  check('other with a note and tomorrow is saved',
    logged.rows?.[0]?.r?.scheduledNext === true, logged.error);

  const task = await probe(
    'select due_on::text as due_on, last_outcome, completed_at from rrr_work_items where id = $1',
    [work.id]);
  check('task stays open, due tomorrow, outcome other',
    task.rows?.[0]?.due_on === tomorrow && task.rows?.[0]?.last_outcome === 'other'
      && task.rows?.[0]?.completed_at === null,
    task.error ?? JSON.stringify(task.rows?.[0]));

  const call = await probe(`select outcome, remark, (next_due_at at time zone 'Asia/Kolkata')::date::text as next
    from followups where customer_id = $1 and outcome = 'other'
    order by completed_at desc limit 1`, [order.customer_id]);
  check('the call is recorded with its note and next date',
    call.rows?.[0]?.next === tomorrow
      && call.rows?.[0]?.remark === 'Hospital mein hai, agle hafte baat karenge',
    call.error ?? JSON.stringify(call.rows?.[0]));

  const open = await probe(`select (due_at at time zone 'Asia/Kolkata')::date::text as due, attempt_no from followups
    where customer_id = $1 and completed_at is null order by due_at limit 1`,
    [order.customer_id]);
  check('an open follow-up is waiting in Action due tomorrow',
    open.rows?.[0]?.due === tomorrow, open.error ?? JSON.stringify(open.rows?.[0]));
  check('and it is not due today', open.rows?.[0]?.due !== today);

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
