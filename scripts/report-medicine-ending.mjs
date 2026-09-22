// Who is at the end of their course right now.
//
//   node scripts/report-medicine-ending.mjs            -7 to +3 days
//   node scripts/report-medicine-ending.mjs 14 7       -14 to +7 days
//
// Read-only. Same source as the Medicine Ending screen — delivered orders with
// a 15 or 30 day course — split into what the floor actually asks for: ran out
// in the last few days, runs out today, runs out in the next few. Each line
// says whether the customer has already been called, because a call today or
// yesterday takes them off the screen.
import fs from 'node:fs';
import pg from 'pg';

// date -> string, never a JS Date: node-postgres parses a date at local
// midnight and IST then reads it back a day out (D-016).
pg.types.setTypeParser(1082, (v) => v);

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const back = Number(process.argv[2] ?? 7);
const forward = Number(process.argv[3] ?? 3);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-medicine-ending-report' });
await db.connect();

const { rows } = await db.query(`
  with course as (
    select o.id as order_id, o.order_no, o.amount, o.customer_id,
           cu.full_name, cu.phone_e164, cu.is_dnd,
           (o.delivered_at at time zone 'Asia/Kolkata')::date as delivered_on,
           (o.delivered_at at time zone 'Asia/Kolkata')::date
             + o.course_duration_days as ends_on,
           o.course_duration_days
    from orders o
    join customers cu on cu.id = o.customer_id and cu.merged_into_id is null
    where o.stage = 'delivered' and o.delivered_at is not null
      and o.course_duration_days in (15, 30)
  )
  select c.*,
    (c.ends_on - public.ist_today()) as days_left,
    -- The call that would take them off the screen: anything logged since
    -- yesterday morning, by any route.
    (select max(f.completed_at) from followups f
      where f.customer_id = c.customer_id and f.completed_at is not null) as last_call,
    exists (select 1 from followups f
      where f.customer_id = c.customer_id and f.completed_at is not null
        and f.completed_at >= (public.ist_today() - 1)::timestamp at time zone 'Asia/Kolkata')
      as called_since_yesterday,
    (select w.assigned_to is not null from rrr_work_items w
      where w.order_id = c.order_id and w.completed_at is null limit 1) as assigned,
    (select u.full_name from rrr_work_items w join users u on u.id = w.assigned_to
      where w.order_id = c.order_id and w.completed_at is null limit 1) as assigned_to
  from course c
  where c.ends_on between public.ist_today() - $1::int and public.ist_today() + $2::int
  order by c.ends_on, c.amount desc`, [back, forward]);

const money = (n) => '₹' + Math.round(Number(n)).toLocaleString('en-IN');
const groups = [
  ['OVERDUE — medicine already finished', (r) => r.days_left < 0],
  ['DUE TODAY — medicine finishes today', (r) => r.days_left === 0],
  ['COMING UP — finishes within ' + forward + ' days', (r) => r.days_left > 0],
];

console.log(`\nMedicine ending, ${back} days back to ${forward} days ahead — ${rows.length} orders\n`);
for (const [title, test] of groups) {
  const part = rows.filter(test);
  console.log(`\n${title}  (${part.length})`);
  if (!part.length) { console.log('  none'); continue; }
  console.log('  ' + 'Ends'.padEnd(12) + 'Days'.padEnd(6) + 'Customer'.padEnd(26)
    + 'Number'.padEnd(15) + 'Order'.padEnd(12) + 'Value'.padEnd(10) + 'Status');
  for (const r of part) {
    const status = r.is_dnd ? 'DND'
      : r.called_since_yesterday ? 'called — off the screen'
      : r.assigned ? `assigned to ${r.assigned_to}`
      : r.last_call ? `last call ${String(r.last_call).slice(0, 10)}`
      : 'never called';
    console.log('  '
      + String(r.ends_on).padEnd(12)
      + String(r.days_left > 0 ? `+${r.days_left}` : r.days_left).padEnd(6)
      + String(r.full_name).slice(0, 24).padEnd(26)
      + String(r.phone_e164).padEnd(15)
      + String(r.order_no).slice(0, 10).padEnd(12)
      + money(r.amount).padEnd(10)
      + status);
  }
}
const hidden = rows.filter((r) => r.called_since_yesterday).length;
console.log(`\n${hidden} of these ${rows.length} are hidden from the Medicine Ending screen `
  + 'because they were called today or yesterday.\n');
await db.end();
