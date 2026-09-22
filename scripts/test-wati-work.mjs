// Live-schema proof for the WATI Interested hand-over: the role gate on
// assigning, the tag row it writes, who can read it, and the call log rules.
// All writes roll back.
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-wati-work-test' });
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
  await db.query('savepoint wati_probe');
  try {
    const result = await db.query(sql, params);
    await db.query('release savepoint wati_probe');
    return { rows: result.rows };
  } catch (error) {
    await db.query('rollback to savepoint wati_probe');
    return { error: error.message };
  }
}
const lead = (over = {}) => ({
  id: crypto.randomUUID(), phone: '+919812345678', name: 'WhatsApp Prospect',
  source: 'Wati Elementor', intent: 8, concern: 'Hair fall', ...over,
});

try {
  await db.connect();
  await db.query('begin');

  const reps = (await db.query(`select u.id, a.email from users u
    join auth.users a on a.id = u.id
    where u.role = 'sales_exec' and u.is_active order by u.full_name limit 2`)).rows;
  const alka = (await db.query(`select id from users where role = 'auditor'
    and is_active order by full_name limit 1`)).rows[0];
  const customer = (await db.query(`select id, phone_e164 from customers
    where merged_into_id is null and not is_dnd limit 1`)).rows[0];
  if (reps.length < 2 || !alka || !customer)
    throw new Error('Need two active sales_exec reps, an auditor and a live customer');
  const [rep, other] = reps;

  // ---- schema ----
  for (const table of ['wati_work_items', 'wati_work_calls']) {
    const exists = (await db.query(`select to_regclass($1) is not null as ok`,
      [`public.${table}`])).rows[0].ok;
    check(`${table} exists`, exists);
    const rls = (await db.query(`select relrowsecurity from pg_class
      where oid = $1::regclass`, [`public.${table}`])).rows[0].relrowsecurity;
    check(`${table} has RLS on`, rls);
  }
  for (const fn of ['fn_assign_wati_work', 'fn_log_wati_call']) {
    const ok = (await db.query(`select count(*)::int n from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname = $1 and p.prosecdef`, [fn])).rows[0].n;
    check(`${fn} exists and is security definer`, ok === 1);
  }
  const anonCan = (await db.query(`select has_function_privilege('anon',
    'public.fn_assign_wati_work(text,jsonb)', 'execute') as ok`)).rows[0].ok;
  check('anon cannot execute fn_assign_wati_work', anonCan === false);
  for (const table of ['wati_work_items', 'wati_work_calls']) {
    const g = (await db.query(`select
      has_table_privilege('anon',$1,'select') as anon_select,
      has_table_privilege('authenticated',$1,'select') as auth_select,
      has_table_privilege('authenticated',$1,'insert') as auth_insert,
      has_table_privilege('authenticated',$1,'update') as auth_update,
      has_table_privilege('authenticated',$1,'delete') as auth_delete`,
      [`public.${table}`])).rows[0];
    check(`${table} grants read to authenticated only`,
      g.auth_select === true && g.anon_select === false
      && g.auth_insert === false && g.auth_update === false && g.auth_delete === false,
      `anon_select=${g.anon_select} auth insert/update/delete=${g.auth_insert}/${g.auth_update}/${g.auth_delete}`);
  }

  // ---- who may assign ----
  await as(rep.id);
  // Writing round the RPC has to be impossible, not merely unused by the app.
  const directInsert = await probe(`insert into wati_work_items
    (wa_lead_id, phone_e164, display_name, assigned_to, assigned_by)
    values ($1,'+919812399999','Sneaked in',$2,$2)`, [crypto.randomUUID(), rep.id]);
  check('a rep cannot insert a WATI task directly', !!directInsert.error, directInsert.error);
  const directUpdate = await probe(
    'update wati_work_items set completed_at = now() where completed_at is null');
  check('a rep cannot close a WATI task directly', !!directUpdate.error, directUpdate.error);

  const repAssign = await probe('select fn_assign_wati_work($1,$2::jsonb)',
    [other.email, JSON.stringify([lead()])]);
  check('a sales rep cannot hand out WATI leads',
    !!repAssign.error && /Not permitted/.test(repAssign.error), repAssign.error);

  await as(alka.id);
  const badAssignee = await probe('select fn_assign_wati_work($1,$2::jsonb)',
    ['nobody@kamour.local', JSON.stringify([lead()])]);
  check('an unknown assignee is refused',
    !!badAssignee.error && /active salesperson/.test(badAssignee.error), badAssignee.error);

  const auditorAssign = await probe('select fn_assign_wati_work($1,$2::jsonb) as n',
    [rep.email, JSON.stringify([lead()])]);
  check('Alka (auditor) can hand out a WATI lead',
    auditorAssign.rows?.[0]?.n === 1, auditorAssign.error);

  // ---- the tag row ----
  const newLead = lead({ phone: customer.phone_e164, name: 'Known Customer Chat' });
  const tagged = await probe('select fn_assign_wati_work($1,$2::jsonb) as n',
    [rep.email, JSON.stringify([newLead])]);
  check('a second lead assigns', tagged.rows?.[0]?.n === 1, tagged.error);
  await db.query('set local role postgres');
  const row = (await db.query(`select * from wati_work_items where wa_lead_id = $1`,
    [newLead.id])).rows[0];
  check('the hand-over is recorded against the rep', row?.assigned_to === rep.id);
  check('it is recorded as assigned by Alka', row?.assigned_by === alka.id);
  check('it carries the lead detail the tag shows',
    row?.display_name === 'Known Customer Chat' && row?.lead_source === 'Wati Elementor'
    && row?.intent_score === 8 && row?.primary_concern === 'Hair fall');
  check('due today, open, not yet called',
    row?.completed_at === null && row?.last_called_at === null);
  check('a known number resolves to its golden customer',
    row?.customer_id === customer.id, `got ${row?.customer_id}`);

  // Re-assigning the same lead moves it; it must never be handed out twice.
  await as(alka.id);
  const moved = await probe('select fn_assign_wati_work($1,$2::jsonb) as n',
    [other.email, JSON.stringify([newLead])]);
  check('re-assigning moves the lead', moved.rows?.[0]?.n === 1, moved.error);
  await db.query('set local role postgres');
  const afterMove = (await db.query(`select count(*)::int n,
    min(assigned_to::text) as owner from wati_work_items
    where wa_lead_id = $1 and completed_at is null`, [newLead.id])).rows[0];
  check('one open task, now with the other rep',
    afterMove.n === 1 && afterMove.owner === other.id);

  // ---- who may read it ----
  const mine = lead({ phone: '+919812300001' });
  await as(alka.id);
  await probe('select fn_assign_wati_work($1,$2::jsonb)', [rep.email, JSON.stringify([mine])]);
  await as(rep.id);
  const own = await probe('select count(*)::int n from wati_work_items where wa_lead_id = $1',
    [mine.id]);
  check('the assigned rep sees their own WATI task', own.rows?.[0]?.n === 1, own.error);
  await as(other.id);
  const notMine = await probe('select count(*)::int n from wati_work_items where wa_lead_id = $1',
    [mine.id]);
  check('another rep cannot see it', notMine.rows?.[0]?.n === 0, notMine.error);
  await as(alka.id);
  const auditorRead = await probe('select count(*)::int n from wati_work_items where wa_lead_id = $1',
    [mine.id]);
  check('Alka can read every hand-over', auditorRead.rows?.[0]?.n === 1, auditorRead.error);

  // ---- logging the call ----
  await db.query('set local role postgres');
  const workId = (await db.query('select id from wati_work_items where wa_lead_id = $1',
    [mine.id])).rows[0].id;
  const number = (await db.query('select id from contact_numbers where is_active limit 1')).rows[0];

  await as(other.id);
  const foreign = await probe('select fn_log_wati_call($1,$2,$3,$4,$5,$6)',
    [workId, 'connected', 'hello', new Date().toISOString().slice(0, 10), number?.id, null]);
  check('a rep cannot log a call on someone else\'s WATI lead',
    !!foreign.error && /not assigned to you/.test(foreign.error), foreign.error);

  await as(rep.id);
  const wrongDate = await probe('select fn_log_wati_call($1,$2,$3,$4,$5,$6)',
    [workId, 'will_buy', '', '2099-01-01', number?.id, null]);
  check('Interested must be due the next day',
    !!wrongDate.error && /due the next day/.test(wrongDate.error), wrongDate.error);
  const noDate = await probe('select fn_log_wati_call($1,$2,$3,$4,$5,$6)',
    [workId, 'connected', '', null, number?.id, null]);
  check('Baat hui must name the next date',
    !!noDate.error && /when to call again/.test(noDate.error), noDate.error);
  const strayDays = await probe('select fn_log_wati_call($1,$2,$3,$4,$5,$6)',
    [workId, 'no_answer', '', null, number?.id, 5]);
  check('medicine days are refused on any other outcome',
    !!strayDays.error && /only apply to medicine/.test(strayDays.error), strayDays.error);

  const tomorrow = (await db.query("select (ist_today() + 1)::text as d")).rows[0].d;
  const logged = await probe('select fn_log_wati_call($1,$2,$3,$4,$5,$6) as r',
    [workId, 'will_buy', 'Kal call karna hai', tomorrow, number?.id, null]);
  check('the rep can log an Interested call',
    logged.rows?.[0]?.r?.scheduledNext === true, logged.error);
  await db.query('set local role postgres');
  // due_on is a date; read it as text so the assertion is not re-timezoned by
  // the driver on its way back out.
  const afterCall = (await db.query(`select completed_at, last_outcome,
    due_on::text as due_on from wati_work_items where id = $1`, [workId])).rows[0];
  check('the task stays open and moves to tomorrow',
    afterCall.completed_at === null && afterCall.last_outcome === 'will_buy'
    && afterCall.due_on === tomorrow,
    `due ${afterCall.due_on}`);
  const call = (await db.query(`select * from wati_work_calls where work_id = $1`,
    [workId])).rows[0];
  check('the call is in the log with its note and number',
    call?.outcome === 'will_buy' && call?.note === 'Kal call karna hai'
    && call?.owner_id === rep.id && call?.attempt_no === 1
    && call?.contact_number_id === number?.id);

  // A terminal outcome closes the task, which is what takes it off the list.
  await as(rep.id);
  const closed = await probe('select fn_log_wati_call($1,$2,$3,$4,$5,$6) as r',
    [workId, 'not_interested', 'Nahi chahiye', null, number?.id, null]);
  check('a terminal outcome closes the task',
    closed.rows?.[0]?.r?.scheduledNext === false, closed.error);
  await db.query('set local role postgres');
  const done = (await db.query('select * from wati_work_items where id = $1',
    [workId])).rows[0];
  check('closed, with the second attempt recorded',
    done.completed_at !== null && done.last_outcome === 'not_interested');
  const attempts = (await db.query(`select max(attempt_no)::int n
    from wati_work_calls where work_id = $1`, [workId])).rows[0].n;
  check('the second call is attempt 2', attempts === 2);

  const capped = await (async () => {
    await as(alka.id);
    return probe('select fn_assign_wati_work($1,$2::jsonb)',
      [rep.email, JSON.stringify(Array.from({ length: 101 }, () => lead()))]);
  })();
  check('at most 100 leads in one hand-over',
    !!capped.error && /at most 100/.test(capped.error), capped.error);

  // Re-handing a lead that was already called must not pass the old call on
  // with it: the Interested screen reads last_outcome to decide whether a row
  // is still waiting, and the rep's list reads due_on to decide whether it is
  // today's call. Both belong to the handover, not to the lead's history.
  const again = lead();
  await as(alka.id);
  await db.query('select fn_assign_wati_work($1,$2::jsonb)',
    [rep.email, JSON.stringify([again])]);
  await db.query('set local role postgres');
  await db.query(`update wati_work_items set last_outcome = 'no_answer',
      last_called_at = now() - interval '1 day', medicine_days_left = 4,
      due_on = ist_today() + 30
    where wa_lead_id = $1 and completed_at is null`, [again.id]);
  await as(alka.id);
  const rehanded = await probe('select fn_assign_wati_work($1,$2::jsonb) as n',
    [rep.email, JSON.stringify([again])]);
  check('re-handing an already-called WATI lead succeeds', !rehanded.error, rehanded.error);
  await db.query('set local role postgres');
  const afterRehand = (await db.query(`select last_outcome, last_called_at,
      medicine_days_left, due_on = ist_today() as due_today
    from wati_work_items where wa_lead_id = $1 and completed_at is null`, [again.id])).rows[0];
  check('the previous handover\'s call does not come with it',
    afterRehand?.last_outcome === null && afterRehand?.last_called_at === null
      && afterRehand?.medicine_days_left === null, JSON.stringify(afterRehand));
  check('a WATI lead handed over today is due today',
    afterRehand?.due_today === true, JSON.stringify(afterRehand));
} catch (error) {
  console.error(error);
  failures++;
} finally {
  await db.query('rollback').catch(() => {});
  await db.end().catch(() => {});
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
