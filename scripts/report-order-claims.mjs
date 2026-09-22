// Orders the floor says it took, against the orders that actually arrived.
//
// "Order placed" is the one outcome a rep writes about money, and it is
// written hours before the Medicine Order sheet can confirm it. The claim is
// worth exactly as much as the order that follows it, so this re-reads every
// claim against `orders`: a claim with an order created on or after the call
// is confirmed, one without it after a grace period is not — and an
// unconfirmed claim is either a sheet row nobody entered or a conversion
// nobody should be credited with.
//
// Follow-ups the sheet import wrote about an order that already existed are
// not claims and are left out — `Automatically marked converted` and
// `Course follow-up scheduled from delivery`, the same two the customer
// timeline hides as not-a-call.
//
// Both routes are read, because a call can be logged two ways: `followups`
// (every RRR call) and `wati_work_calls` (a WhatsApp prospect, who may have no
// customer row at all until their first order syncs).
//
//   node scripts/report-order-claims.mjs           # last 30 days, 2-day grace
//   node scripts/report-order-claims.mjs 60 3      # last 60 days, 3-day grace
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const days = Number(process.argv[2]) || 30;
const grace = Number(process.argv[3]) || 2;
const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-order-claims',
});
await db.connect();

// One row per claim, from either route, with the first order that could be it.
// "Could be it" is deliberately generous — same customer, created on or after
// the day of the call — because the sheet carries no link back to the call.
const CLAIMS = `
with claims as (
  select 'RRR'::text as route, f.completed_at as called_at, f.customer_id,
         coalesce(u.full_name, 'Unknown') as rep, c.full_name as customer,
         f.remark as note
    from followups f
    join customers c on c.id = f.customer_id
    left join users u on u.id = f.owner_id
   where f.outcome = 'order_placed'
     and f.completed_at >= now() - ($1 || ' days')::interval
     -- Sheet rows the import made that are not calls: the note left when an
     -- order synced, and the course reminder raised from its delivery date.
     -- They are order_placed because an order already existed, so reading them
     -- as an unconfirmed claim would accuse a rep of the system's bookkeeping.
     and coalesce(f.remark, '') !~* 'Automatically marked converted|Course follow-up scheduled'
  union all
  select 'WATI', k.called_at, w.customer_id,
         coalesce(u.full_name, 'Unknown'), w.display_name, k.note
    from wati_work_calls k
    join wati_work_items w on w.id = k.work_id
    left join users u on u.id = k.owner_id
   where k.outcome = 'order_placed'
     and k.called_at >= now() - ($1 || ' days')::interval
)
select claims.*,
       (claims.called_at at time zone 'Asia/Kolkata')::date as called_on,
       (select min(o.created_at) from orders o
         where o.customer_id = claims.customer_id
           and (o.created_at at time zone 'Asia/Kolkata')::date
               >= (claims.called_at at time zone 'Asia/Kolkata')::date) as order_at
  from claims
 order by claims.called_at desc`;

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

try {
  const { rows } = await db.query(CLAIMS, [String(days)]);
  if (!rows.length) {
    console.log(`No "order placed" calls in the last ${days} days.`);
  } else {
    const waiting = [];   // too recent to judge — the sheet has not caught up
    const missing = [];   // past the grace period with no order
    const confirmed = [];
    const cutoff = Date.now() - grace * 86_400_000;
    for (const r of rows) {
      if (r.order_at) confirmed.push(r);
      else if (new Date(r.called_at).getTime() > cutoff) waiting.push(r);
      else missing.push(r);
    }
    const line = (r) => `  ${day(r.called_on)} · ${r.route} · ${r.rep} · ${r.customer}`
      + (r.order_at ? ` → order ${day(r.order_at)}` : '')
      + (r.note ? ` · "${String(r.note).slice(0, 60)}"` : ' · (no note)');

    console.log(`${rows.length} claim(s) in the last ${days} days:`
      + ` ${confirmed.length} confirmed, ${waiting.length} waiting, ${missing.length} unconfirmed.\n`);
    if (missing.length) {
      console.log(`Unconfirmed after ${grace} day(s) — no order arrived:`);
      missing.forEach((r) => console.log(line(r)));
      console.log('');
    }
    if (waiting.length) {
      console.log('Too recent to judge:');
      waiting.forEach((r) => console.log(line(r)));
      console.log('');
    }
    console.log('Confirmed:');
    confirmed.forEach((r) => console.log(line(r)));
  }
} finally {
  await db.end();
}
