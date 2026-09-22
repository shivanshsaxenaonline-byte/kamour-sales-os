// Orders that arrived before the trigger existed, given the call they earned.
//
// From today an order books its own next call (migration 20260919150000). The
// orders already in the base did not: the call was marked "order placed", the
// order synced, and nothing scheduled anything — the customer is on a course
// that ends with no call waiting.
//
// Same date and the same guards as the trigger: only where nothing else is
// open on the customer, never a returned or cancelled parcel, never DND or
// merged. A date that has already passed is pulled to tomorrow rather than
// filed in the past.
//
// Deliberately wider than the trigger in one way. The trigger wants a rep's
// own `order_placed` call; here the rows the old sheet import wrote when an
// order synced count too, because for those customers that row is the only
// trace left that they bought and nobody booked the call. Most of them are
// orders never marked delivered, which the Medicine Ending screen — which
// reads delivered orders — cannot see at all. The listing says which is which.
//
// Every date is computed in Postgres and never round-trips through a
// JavaScript `Date`: `date` comes back as UTC midnight, and turning that back
// into a string in IST moves it a day early. The first run of this script did
// exactly that, which is why it also re-dates the rows it finds.
//
//   node scripts/backfill-course-followups.mjs          # show only
//   node scripts/backfill-course-followups.mjs --apply  # book and re-date
//   node scripts/backfill-course-followups.mjs 90 --apply   # wider window
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const apply = process.argv.includes('--apply');
const days = Number(process.argv.find((a) => /^\d+$/.test(a))) || 45;
const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-backfill-course-calls',
});
await db.connect();

const MARK = 'Course follow-up scheduled from the order';

// The orders that should have booked a call and did not, newest claim wins.
const CANDIDATES = `
select o.id as order_id, o.order_no, c.full_name, o.stage::text as stage,
       (o.created_at at time zone 'Asia/Kolkata')::date::text as ordered_on,
       coalesce(o.course_duration_days, 15) as course,
       greatest(o.next_followup_at, ist_today() + 1)::text as due_on,
       o.next_followup_at < ist_today() as was_past,
       coalesce(u.full_name, 'Unassigned') as rep,
       case when claim.remark ~* 'Automatically marked converted|Course follow-up scheduled'
            then 'from the synced order' else 'rep marked it' end as claim_kind
  from orders o
  join customers c on c.id = o.customer_id
  cross join lateral (
    select f.owner_id, f.remark
      from followups f
     where f.customer_id = o.customer_id and f.outcome = 'order_placed'
       and f.completed_at is not null
       and f.completed_at between o.created_at - interval '21 days'
                              and o.created_at + interval '7 days'
     order by f.completed_at desc limit 1) claim
  left join users u on u.id = claim.owner_id
 where o.created_at > now() - ($1 || ' days')::interval
   and o.stage not in ('rto', 'cancelled')
   and o.next_followup_at is not null
   and not c.is_dnd and c.merged_into_id is null
   and not exists (select 1 from followups f2
                    where f2.customer_id = o.customer_id and f2.completed_at is null)
 order by greatest(o.next_followup_at, ist_today() + 1)`;

// Rows this script booked before, put back on the order's own date.
const REDATE = `
update followups f
   set due_at = greatest(o.next_followup_at, ist_today() + 1)::timestamp
                  at time zone 'Asia/Kolkata',
       updated_at = now()
  from orders o
 where o.id = f.order_id and f.completed_at is null and f.remark = $1
   and o.next_followup_at is not null
   and (f.due_at at time zone 'Asia/Kolkata')::date
       is distinct from greatest(o.next_followup_at, ist_today() + 1)`;

const BOOK = `
insert into followups (customer_id, kind, order_id, due_at, owner_id, attempt_no, remark)
select o.customer_id, 'order', o.id,
       greatest(o.next_followup_at, ist_today() + 1)::timestamp at time zone 'Asia/Kolkata',
       claim.owner_id,
       coalesce((select max(f.attempt_no) from followups f
                  where f.customer_id = o.customer_id and f.kind = 'order'), 0) + 1,
       $2
  from orders o
  join customers c on c.id = o.customer_id
  cross join lateral (
    select f.owner_id
      from followups f
     where f.customer_id = o.customer_id and f.outcome = 'order_placed'
       and f.completed_at is not null
       and f.completed_at between o.created_at - interval '21 days'
                              and o.created_at + interval '7 days'
     order by f.completed_at desc limit 1) claim
 where o.created_at > now() - ($1 || ' days')::interval
   and o.stage not in ('rto', 'cancelled')
   and o.next_followup_at is not null
   and not c.is_dnd and c.merged_into_id is null
   and not exists (select 1 from followups f2
                    where f2.customer_id = o.customer_id and f2.completed_at is null)`;

try {
  const { rows } = await db.query(CANDIDATES, [String(days)]);
  if (!rows.length) {
    console.log(`No orders in the last ${days} days are missing their course call.`);
  } else {
    console.log(`${rows.length} order(s) whose course call was never booked:\n`);
    for (const r of rows) {
      console.log(`  ${r.full_name} · ${r.order_no} · ${r.course}-day course`
        + ` ordered ${r.ordered_on} → call ${r.due_on}`
        + (r.was_past ? ' (course already ended — due tomorrow)' : '')
        + ` · ${r.stage} · ${r.claim_kind} · ${r.rep}`);
    }
    console.log('');
  }
  if (!apply) {
    console.log('Dry run. Re-run with --apply to book them and re-date any already booked.');
  } else {
    // One customer can have two orders in the window; the guard inside BOOK is
    // checked once for the statement, so the insert runs per customer and the
    // second order finds a call already waiting.
    let booked = 0;
    for (let pass = 0; pass < 2; pass++) {
      const { rowCount } = await db.query(BOOK, [String(days), MARK]);
      booked += rowCount;
      if (!rowCount) break;
    }
    const fixed = await db.query(REDATE, [MARK]);
    console.log(`Booked ${booked} call(s); re-dated ${fixed.rowCount} already booked.`);
  }
} finally {
  await db.end();
}
