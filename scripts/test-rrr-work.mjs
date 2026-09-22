// Live-schema RLS and assignment proof. All writes roll back.
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-rrr-work-test' });
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
  await db.query('savepoint rrr_probe');
  try {
    const result = await db.query(sql, params);
    await db.query('release savepoint rrr_probe');
    return { rows: result.rows };
  } catch (error) {
    await db.query('rollback to savepoint rrr_probe');
    return { error: error.message };
  }
}

try {
  await db.connect();
  await db.query('begin');
  // Live assignments exist once the floor is using the screen, so the "no work
  // yet" probes need a rep who has nothing open; clear any in this transaction.
  const reps = (await db.query(`select id from users where role = 'sales_exec'
    and is_active order by full_name limit 2`)).rows;
  const alka = (await db.query(`select id from users where role = 'auditor'
    and is_active order by full_name limit 1`)).rows[0];
  const manager = (await db.query(`select id from users where role = 'sales_manager'
    and is_active order by full_name limit 1`)).rows[0];
  // Two things this used to get wrong, both of which surfaced the moment the
  // floor put real work on these screens.
  //
  // It cleared only the two reps, so once Alka began handing Due-today leads to
  // Ashutosh the "unassigned manager" probes failed on live data rather than on
  // anything the policies were doing.
  //
  // And completing a task no longer hides it: 20260915063256 widened
  // rrr_work_read so a rep can still see their own tasks completed TODAY, which
  // is what the day's progress bar counts. Marking live work complete therefore
  // left it visible and the probe read it back. Clearing the call time as well
  // is what actually means "this person has nothing open and nothing done
  // today" — and `assigned_to` cannot simply be nulled, wati_work_items
  // declares it NOT NULL.
  const idle = [...reps.map((rep) => rep.id), manager.id];
  for (const table of ['rrr_work_items', 'wati_work_items']) {
    await db.query(`update ${table} set completed_at = now(), last_called_at = null
      where completed_at is null and assigned_to = any($1::uuid[])`, [idle]);
  }
  const ai = (await db.query(`select l.customer_id, o.id as order_id
    from ai_daily_leads l
    join customers c on c.id = l.customer_id and not c.is_dnd
      and c.merged_into_id is null
    join lateral (select id from orders where customer_id = l.customer_id
      order by created_at desc, id desc limit 1) o on true
    where l.run_on = ist_today() limit 1`)).rows[0];
  const medicine = (await db.query(`select o.id, o.customer_id from orders o
    join customers c on c.id = o.customer_id
    where o.stage = 'delivered' and o.delivered_at is not null
      and o.course_duration_days in (15,30) and not c.is_dnd
      and c.merged_into_id is null and c.id <> $1 limit 1`, [ai?.customer_id])).rows[0];
  const managerMedicine = (await db.query(`select o.id, o.customer_id from orders o
    join customers c on c.id = o.customer_id
    where o.stage = 'delivered' and o.delivered_at is not null
      and o.course_duration_days in (15,30) and not c.is_dnd
      and c.merged_into_id is null and c.id not in ($1,$2) limit 1`,
    [ai?.customer_id, medicine?.customer_id])).rows[0];
  if (reps.length < 2 || !alka || !manager || !ai || !medicine || !managerMedicine)
    throw new Error('Need two reps, manager, auditor, AI lead and two medicine orders');
  const expectedOrders = (await db.query('select count(*)::int as n from orders where customer_id = $1',
    [ai.customer_id])).rows[0].n;

  await as(reps[0].id);
  for (const table of ['rrr_work_items', 'customers', 'orders', 'leads',
    'ai_daily_leads', 'consultations', 'v_pool_leads']) {
    const result = await probe(`select id from ${table} limit 1`);
    // AI daily leads does not have an id column.
    if (table === 'ai_daily_leads' || table === 'v_pool_leads') {
      const count = await probe(`select count(*)::int as n from ${table}`);
      check(`unassigned rep cannot read ${table}`, count.rows?.[0]?.n === 0, count.error);
    } else check(`unassigned rep cannot read ${table}`, result.rows?.length === 0, result.error);
  }
  await as(manager.id);
  for (const table of ['rrr_work_items', 'customers', 'orders', 'leads', 'ai_daily_leads']) {
    const result = await probe(`select count(*)::int as n from ${table}`);
    check(`unassigned manager cannot read ${table}`, result.rows?.[0]?.n === 0, result.error);
  }

  await as(alka.id);
  const assigned = await probe(`select fn_assign_rrr_work('ai',$1::uuid[],$2) as n`,
    [[ai.customer_id], reps[0].id]);
  check('Alka assigns AI calling task', assigned.rows?.[0]?.n === 1, assigned.error);
  const medAssigned = await probe(`select fn_assign_rrr_work('medicine_ending',$1::uuid[],$2) as n`,
    [[medicine.id], reps[1].id]);
  check('Alka assigns medicine calling task', medAssigned.rows?.[0]?.n === 1, medAssigned.error);
  const managerAssigned = await probe(`select fn_assign_rrr_work('medicine_ending',$1::uuid[],$2) as n`,
    [[managerMedicine.id], manager.id]);
  check('Alka assigns manager a medicine calling task', managerAssigned.rows?.[0]?.n === 1,
    managerAssigned.error);

  await as(reps[0].id);
  const work = await probe('select id,source,customer_id,order_id from rrr_work_items');
  check('rep A sees only assigned AI source', work.rows?.length === 1 && work.rows[0].source === 'ai');
  const visibleCustomers = await probe('select id from customers limit 3');
  check('rep A reads only assigned customer',
    visibleCustomers.rows?.length === 1 && visibleCustomers.rows[0].id === ai.customer_id,
    visibleCustomers.error);
  const visibleOrders = await probe('select id, customer_id from orders');
  check('rep A reads every order of the assigned customer and nothing else',
    visibleOrders.rows?.length > 0 && visibleOrders.rows.some((o) => o.id === ai.order_id)
      && visibleOrders.rows.every((o) => o.customer_id === ai.customer_id)
      && visibleOrders.rows.length === expectedOrders,
    visibleOrders.error ?? JSON.stringify({ expectedOrders, actual: visibleOrders.rows?.length }));
  const otherItems = await probe(`select count(*)::int as n from order_items oi
    where not exists (select 1 from orders o where o.id = oi.order_id and o.customer_id = $1)`,
    [ai.customer_id]);
  check('rep A reads no order items of other customers', otherItems.rows?.[0]?.n === 0, otherItems.error);
  const history = await probe(`select count(*)::int as n, count(distinct customer_id)::int as c
    from v_rrr_customer_followups`);
  check('rep A follow-up history covers only the assigned customer',
    (history.rows?.[0]?.c ?? 2) <= 1, history.error);
  const panelOrders = await probe('select order_id from v_rrr_customer_orders where customer_id = $1',
    [ai.customer_id]);
  check('rep A detail panel loads order history', panelOrders.rows?.length === expectedOrders,
    panelOrders.error);
  const directWrite = await probe(`insert into followups
    (customer_id,kind,order_id,due_at,owner_id,attempt_no)
    values ($1,'order',$2,now(),$3,1) returning id`,
    [ai.customer_id, ai.order_id, reps[0].id]);
  check('rep cannot bypass assigned call RPC with direct followup write',
    !!directWrite.error || directWrite.rows?.length === 0);
  const next = (await db.query('select (ist_today() + 3)::text as day')).rows[0].day;
  const logged = await probe(`select fn_log_assigned_rrr_call($1,'no_answer','test call',$2,null,null) as result`,
    [work.rows?.[0]?.id, next]);
  check('assigned rep logs outcome and next date', logged.rows?.[0]?.result?.scheduledNext === true,
    logged.error);
  const taskAfter = await probe('select due_on::text as due_on,last_outcome,completed_at from rrr_work_items where id=$1',
    [work.rows?.[0]?.id]);
  check('task stays assigned with saved outcome', taskAfter.rows?.[0]?.due_on === next
    && taskAfter.rows?.[0]?.last_outcome === 'no_answer'
    && taskAfter.rows?.[0]?.completed_at === null,
    taskAfter.error ?? JSON.stringify({ expected: next, actual: taskAfter.rows }));
  const oldRpc = await probe(`select fn_log_assigned_rrr_call($1,'order_placed','old form',null,null)`,
    [work.rows?.[0]?.id]);
  check('old call RPC cannot bypass new outcome rules', !!oldRpc.error);
  const removed = await probe(`select fn_log_assigned_rrr_call($1,'wrong_number','',null,null,null)`,
    [work.rows?.[0]?.id]);
  check('removed wrong-number option is rejected', !!removed.error);
  const removedOrder = await probe(`select fn_log_assigned_rrr_call($1,'order_placed','',null,null,null)`,
    [work.rows?.[0]?.id]);
  check('removed order-placed option is rejected', !!removedOrder.error);
  const noDays = await probe(`select fn_log_assigned_rrr_call($1,'medicine_not_finished','',null,null,null)`,
    [work.rows?.[0]?.id]);
  check('medicine outcome requires days remaining', !!noDays.error);
  const medicineNext = (await db.query('select (ist_today() + 6)::text as day')).rows[0].day;
  const medicineLogged = await probe(`select fn_log_assigned_rrr_call(
    $1,'medicine_not_finished','six days stated',$2,null,6) as result`,
    [work.rows?.[0]?.id, medicineNext]);
  check('medicine days schedule the matching follow-up',
    medicineLogged.rows?.[0]?.result?.scheduledNext === true, medicineLogged.error);
  const medTask = await probe('select due_on::text as due_on,medicine_days_left from rrr_work_items where id=$1',
    [work.rows?.[0]?.id]);
  check('remaining medicine days are saved on the task',
    medTask.rows?.[0]?.due_on === medicineNext && medTask.rows?.[0]?.medicine_days_left === 6,
    medTask.error);
  const medHistory = await probe('select remark from followups where id=$1',
    [medicineLogged.rows?.[0]?.result?.followupId]);
  check('remaining medicine days are saved in call history',
    medHistory.rows?.[0]?.remark?.includes('Medicine remaining: 6 days'), medHistory.error);
  const noDate = await probe(`select fn_log_assigned_rrr_call(
    $1,'will_update_later','',null,null,null)`, [work.rows?.[0]?.id]);
  check('will update later requires an explicit date', !!noDate.error);
  const connectedNoDate = await probe(`select fn_log_assigned_rrr_call(
    $1,'connected','',null,null,null)`, [work.rows?.[0]?.id]);
  check('connected call also requires an explicit date', !!connectedNoDate.error);
  const tomorrow = (await db.query('select (ist_today() + 1)::text as day')).rows[0].day;
  const interested = await probe(`select fn_log_assigned_rrr_call(
    $1,'will_buy','',$2,null,null) as result`, [work.rows?.[0]?.id, tomorrow]);
  check('interested is scheduled for the next day',
    interested.rows?.[0]?.result?.scheduledNext === true, interested.error);
  const wrongInterested = await probe(`select fn_log_assigned_rrr_call(
    $1,'will_buy','',$2,null,null)`, [work.rows?.[0]?.id, next]);
  check('interested cannot be scheduled three days later', !!wrongInterested.error);

  await as(reps[1].id);
  const wrong = await probe(`select fn_log_assigned_rrr_call($1,'connected','wrong caller',$2,null,null)`,
    [work.rows?.[0]?.id, tomorrow]);
  check('other rep cannot log AI task', !!wrong.error);
  const repB = await probe('select source,customer_id from rrr_work_items');
  check('rep B sees only assigned Medicine Ending source', repB.rows?.length === 1
    && repB.rows[0].source === 'medicine_ending'
    && repB.rows[0].customer_id === medicine.customer_id, repB.error);
  await as(manager.id);
  const managerWork = await probe('select source,customer_id from rrr_work_items');
  check('manager sees only own assigned Medicine Ending task', managerWork.rows?.length === 1
    && managerWork.rows[0].customer_id === managerMedicine.customer_id, managerWork.error);
} catch (error) {
  failures++;
  console.error(error);
} finally {
  try { await db.query('set local role postgres'); await db.query('rollback'); } catch {}
  await db.end();
  process.exitCode = failures ? 1 : 0;
}
