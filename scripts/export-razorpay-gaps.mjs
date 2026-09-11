// The two lists the Razorpay backfill made possible, as CSV for Excel.
//
//   node scripts/export-razorpay-gaps.mjs
//
// Writes into exports/ (gitignored). Read-only against the database.
//
// Neither list is an accusation. Both are questions somebody now has the
// ability to ask, which they did not have yesterday.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v);

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 180_000,
  application_name: 'razorpay-gaps',
});

// Excel opens UTF-8 CSV as mojibake unless it sees a BOM, and these files have
// Indian names in them. Quotes doubled, everything quoted — a name with a
// comma in it must not silently split a column.
const csv = (rows) => {
  if (!rows.length) return '﻿(no rows)\n';
  const cols = Object.keys(rows[0]);
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))]
    .join('\r\n') + '\r\n';
};

const write = (name, rows) => {
  fs.mkdirSync('exports', { recursive: true });
  const p = path.join('exports', name);
  fs.writeFileSync(p, csv(rows));
  console.log(`${String(rows.length).padStart(5)} rows  ->  ${p}`);
};

await c.connect();

// ---------------------------------------------------------------------------
// 1. Money that looks like a medicine order, with no order recorded against
//    that phone number. The user's own worry, made checkable: a name typed
//    into a sheet can be wrong, a payment id cannot.
// ---------------------------------------------------------------------------
const { rows: gaps } = await c.query(`
  select
    to_char(p.paid_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') as "Payment date",
    p.amount                                    as "Amount",
    coalesce(p.phone_e164, p.contact_raw, '—')  as "Phone",
    coalesce(cu.full_name, '(not in our system)') as "Name in our system",
    case when cu.id is null then 'Phone not found at all'
         else 'In system, but zero orders' end  as "Why it is on this list",
    coalesce(p.method, '—')                     as "Paid by",
    coalesce(p.vpa, p.bank, p.wallet, '—')      as "UPI id / bank",
    p.id                                        as "Razorpay payment id",
    coalesce(p.acquirer_data->>'rrn', '—')      as "Bank reference (RRN)",
    coalesce(p.email, '—')                      as "Email"
  from razorpay_payments p
  left join customers cu
         on cu.phone_e164 = p.phone_e164 and cu.merged_into_id is null
  where p.status = 'captured'
    and p.amount >= 1500
    and (cu.id is null or cu.lifetime_orders = 0)
  order by p.amount desc, p.paid_at desc`);
write('1-payments-with-no-order.csv', gaps);
const gapTotal = gaps.reduce((s, r) => s + Number(r.Amount), 0);

// ---------------------------------------------------------------------------
// 2. People who tried to pay, failed, never paid successfully, never ordered,
//    and tried recently enough to remember doing it. They raised their hand.
// ---------------------------------------------------------------------------
const { rows: failed } = await c.query(`
  with attempts as (
    select p.phone_e164,
           max(p.paid_at)  as last_try,
           count(*)        as tries,
           max(p.amount)   as biggest,
           (array_agg(p.error_description order by p.paid_at desc)
              filter (where p.error_description is not null))[1] as why
    from razorpay_payments p
    where p.status = 'failed' and p.phone_e164 is not null
    group by 1)
  select
    to_char(a.last_try at time zone 'Asia/Kolkata', 'DD Mon YYYY') as "Last tried on",
    (current_date - a.last_try::date)             as "Days ago",
    a.phone_e164                                  as "Phone",
    coalesce(cu.full_name, '(not in our system)') as "Name in our system",
    a.biggest                                     as "Amount they tried to pay",
    a.tries                                       as "How many attempts",
    coalesce(a.why, '—')                          as "Razorpay reason"
  from attempts a
  left join customers cu
         on cu.phone_e164 = a.phone_e164 and cu.merged_into_id is null
  where a.last_try >= current_date - 180
    and not exists (select 1 from razorpay_payments ok
                    where ok.phone_e164 = a.phone_e164 and ok.status = 'captured')
    and (cu.id is null or cu.lifetime_orders = 0)
  order by a.biggest desc, a.last_try desc`);
write('2-tried-to-pay-and-failed.csv', failed);

// ---------------------------------------------------------------------------
// 3. The easy wins: a payment whose amount and date line up with exactly one
//    order from the same phone. Listed for a human to approve, not applied.
// ---------------------------------------------------------------------------
const { rows: easy } = await c.query(`
  select
    to_char(u.paid_at at time zone 'Asia/Kolkata', 'DD Mon YYYY') as "Payment date",
    u.amount            as "Amount",
    u.phone_e164        as "Phone",
    u.likely_customer   as "Customer",
    o.order_no          as "Order number",
    to_char(o.created_at at time zone 'Asia/Kolkata', 'DD Mon YYYY') as "Order date",
    o.amount            as "Order amount",
    u.payment_id        as "Razorpay payment id"
  from v_razorpay_unmatched u
  join orders o on o.id = u.candidate_orders[1]
  where u.candidate_count = 1 and u.amount >= 1500
  order by u.amount desc`);
write('3-safe-to-match.csv', easy);

console.log('');
console.log(`List 1 — ₹${Math.round(gapTotal).toLocaleString('en-IN')} of payments with no order on file.`);
console.log(`List 2 — ${failed.length} people who tried to pay and could not.`);
console.log(`List 3 — ${easy.length} payments that line up with exactly one order.`);
console.log('');
console.log('None of these change anything. They are lists to work through.');

await c.end();
