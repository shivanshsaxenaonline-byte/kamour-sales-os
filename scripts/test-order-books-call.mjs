// The order books the next call, proved against the live schema. Writes roll back.
//
// What it has to show: an order that answers an "order placed" claim raises an
// open follow-up dated from the course it carries (delivery date when the
// sheet has one, order date + the measured transit when it does not, three
// days early either way); the delivery date arriving later moves that call; a
// parcel that comes back takes it away; and an order nobody claimed raises
// nothing, because the Medicine Ending screen already reads those.
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-order-books-call' });
let failures = 0;
function check(label, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
}
const MARK = 'Course follow-up scheduled from the order';

try {
  await db.connect();
  await db.query('begin');

  const rep = (await db.query(`select id from users where role = 'sales_exec'
    and is_active order by full_name limit 1`)).rows[0];
  if (!rep) throw new Error('Need an active sales_exec');
  // Two customers with an order to hang a call on and nothing open, so the
  // follow-up read back can only be the one the trigger booked.
  const people = (await db.query(`select o.id as order_id, o.customer_id from orders o
    join customers c on c.id = o.customer_id
    where not c.is_dnd and c.merged_into_id is null
      and not exists (select 1 from followups f
                       where f.customer_id = o.customer_id and f.completed_at is null)
    order by o.created_at desc limit 2`)).rows;
  if (people.length < 2) throw new Error('Need two customers with no open follow-up');
  const [claimed, quiet] = people;

  // The claim: a rep logged "order placed" on this customer today.
  await db.query(`insert into followups
    (customer_id, kind, order_id, due_at, owner_id, outcome, remark, completed_at, attempt_no)
    values ($1,'order',$2, now(), $3, 'order_placed', 'GP30 2985', now(), 99)`,
    [claimed.customer_id, claimed.order_id, rep.id]);

  const newOrder = async (customerId, over = {}) => {
    const { rows } = await db.query(`insert into orders
      (order_no, customer_id, stage, payment_state, amount, discount, shipping_amount,
       course_duration_days, created_at, is_repeat, is_legacy, original_owner_id, current_owner_id)
      values ($1,$2,$3::order_stage,'unpaid',2985,0,0,$4, now(), true, true, $5, $5)
      returning id, next_followup_at::text`,
      [`TEST-${Math.random().toString(36).slice(2, 10)}`, customerId,
        over.stage ?? 'confirmed', over.course ?? 15, rep.id]);
    return rows[0];
  };
  const bookedFor = async (customerId) => (await db.query(
    `select (due_at at time zone 'Asia/Kolkata')::date::text as due_on, owner_id, remark,
            order_id, attempt_no
       from followups where customer_id = $1 and completed_at is null
       order by due_at limit 1`, [customerId])).rows[0] ?? null;
  const dayIn = async (n) => (await db.query(
    'select (ist_today() + $1::int)::text as d', [n])).rows[0].d;

  // ---- an order with no delivery date yet ----
  const order = await newOrder(claimed.customer_id);
  const undelivered = await bookedFor(claimed.customer_id);
  // order date today + 6 transit + 15 course - 3 early
  check('the new order books a call at transit + course, three days early',
    undelivered?.due_on === await dayIn(18) && undelivered?.remark === MARK,
    JSON.stringify(undelivered));
  check('the rep who took the order owns it', undelivered?.owner_id === rep.id);
  check('it hangs on the new order, not the old one',
    undelivered?.order_id === order.id);
  check('the order carries the same date', order.next_followup_at === await dayIn(18),
    order.next_followup_at);

  // ---- the delivery date arrives ----
  await db.query('update orders set delivered_at = now() where id = $1', [order.id]);
  const delivered = await bookedFor(claimed.customer_id);
  check('the delivery date moves the call to delivered + course - 3',
    delivered?.due_on === await dayIn(12), JSON.stringify(delivered));
  check('it moved the same row rather than stacking a second one',
    delivered?.attempt_no === undelivered?.attempt_no,
    `${undelivered?.attempt_no} → ${delivered?.attempt_no}`);
  const only = await db.query(
    'select count(*)::int n from followups where customer_id = $1 and completed_at is null',
    [claimed.customer_id]);
  check('exactly one call is waiting on the customer', only.rows[0].n === 1,
    JSON.stringify(only.rows[0]));

  // ---- a 30-day course is judged on its own length ----
  await db.query('update orders set course_duration_days = 30 where id = $1', [order.id]);
  const longer = await bookedFor(claimed.customer_id);
  check('a 30-day course pushes the call out by its own duration',
    longer?.due_on === await dayIn(27), JSON.stringify(longer));

  // ---- the parcel comes back ----
  await db.query(`update orders set stage = 'rto' where id = $1`, [order.id]);
  const afterRto = await bookedFor(claimed.customer_id);
  check('a returned parcel takes the booked call away', afterRto === null,
    JSON.stringify(afterRto));
  const cleared = await db.query(
    'select next_followup_at from orders where id = $1', [order.id]);
  check('and the order stops carrying a date',
    cleared.rows[0].next_followup_at === null, JSON.stringify(cleared.rows[0]));

  // ---- an order nobody claimed ----
  await newOrder(quiet.customer_id);
  const unclaimed = await bookedFor(quiet.customer_id);
  check('an order with no claim behind it books nothing', unclaimed === null,
    JSON.stringify(unclaimed));

  // ---- a customer already waiting on another call is left alone ----
  const waiting = await db.query(`insert into followups
    (customer_id, kind, order_id, due_at, owner_id, attempt_no, remark)
    values ($1,'order',$2, now() + interval '2 days', $3, 1, 'Interested — kal call')
    returning id`, [quiet.customer_id, quiet.order_id, rep.id]);
  await db.query(`insert into followups
    (customer_id, kind, order_id, due_at, owner_id, outcome, remark, completed_at, attempt_no)
    values ($1,'order',$2, now(), $3, 'order_placed', 'DC60', now(), 98)`,
    [quiet.customer_id, quiet.order_id, rep.id]);
  await newOrder(quiet.customer_id);
  const stillWaiting = await bookedFor(quiet.customer_id);
  check('an earlier open call is not replaced or stacked behind',
    stillWaiting?.id === undefined && stillWaiting?.remark === 'Interested — kal call',
    JSON.stringify(stillWaiting));
  const count = await db.query(
    'select count(*)::int n from followups where customer_id = $1 and completed_at is null',
    [quiet.customer_id]);
  check('still just the one call waiting on them', count.rows[0].n === 1,
    JSON.stringify(count.rows[0]));
  await db.query('select $1::uuid', [waiting.rows[0].id]);

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
