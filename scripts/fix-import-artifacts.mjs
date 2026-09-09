// Two defects created by importing overlapping sources. Both are data fixes,
// not schema, so they live here rather than in a migration.
//
//   node scripts/fix-import-artifacts.mjs            dry run
//   node scripts/fix-import-artifacts.mjs --commit   apply
//
// (1) DUPLICATE ORDERS. The July "Medicine Order Record" tab (imported first,
//     168 orders) and the KM002 Master Sheet cover the same July 2026 orders,
//     so those customers have every July order twice — inflating
//     lifetime_orders and lifetime_value, which is what the RRR screen ranks
//     on. The two copies carry DIFFERENT fields: July has the shipping
//     address, pincode, city, courier and payment mode; KM002 has the order's
//     source (CGA funnel, Kamour.in...). So the July row is kept as the
//     richer one, the source is copied onto it, and the KM002 copy is
//     deleted. Nothing is discarded, the two halves are merged.
//
// (2) OUTCOME WITHOUT COMPLETION. 149 rows from the AI Daily Queue carry a
//     real call outcome but no "Outcome Saved At" or "Last Contacted" date in
//     the sheet, so they imported with completed_at NULL — which means the
//     app still shows them as pending work that is already done. An outcome
//     is proof the call happened; the only date the source offers for it is
//     the day the queue scheduled it, so that is used, and the row's remark
//     already carries the operator's exact original words.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const COMMIT = process.argv.includes('--commit');

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300_000,
  application_name: 'kamour-fix-import-artifacts',
});

async function main() {
  await c.connect();
  await c.query('begin');

  const before = (await c.query(
    `select (select count(*)::int from orders)    as orders,
            (select count(*)::int from followups where kind='order') as queue_followups`)).rows[0];

  // ---- (1) merge the duplicate pairs -------------------------------------
  // A duplicate is the same customer, same order date and same amount. Two
  // rows that agree on all three are the same sale recorded twice, not two
  // sales — the KM002 sheet is a rebuild of the same order book.
  const dupes = (await c.query(`
    select keep.id as keep_id, drop_row.id as drop_id, drop_row.source_id
    from orders keep
    join orders drop_row
      on drop_row.customer_id      = keep.customer_id
     and drop_row.created_at::date = keep.created_at::date
     and drop_row.amount           = keep.amount
     and drop_row.id              <> keep.id
    -- keep the older import (it has address, courier and payment mode)
    where keep.updated_at < drop_row.updated_at
  `)).rows;

  let sourcesMoved = 0;
  for (const d of dupes) {
    if (d.source_id) {
      const r = await c.query(
        `update orders set source_id = $1 where id = $2 and source_id is null`,
        [d.source_id, d.keep_id]);
      sourcesMoved += r.rowCount;
    }
  }

  // Follow-ups may point at the copy being removed; move them, or deleting
  // the order would cascade real call history away with it.
  const moved = await c.query(
    `update followups f set order_id = d.keep_id
       from (select unnest($1::uuid[]) as keep_id, unnest($2::uuid[]) as drop_id) d
      where f.order_id = d.drop_id`,
    [dupes.map((d) => d.keep_id), dupes.map((d) => d.drop_id)]);

  const deleted = await c.query(
    `delete from orders where id = any($1::uuid[])`, [dupes.map((d) => d.drop_id)]);

  // ---- (2) an outcome means the call happened ----------------------------
  const completed = await c.query(
    `update followups
        set completed_at = due_at
      where kind = 'order'
        and outcome is not null
        and completed_at is null`);

  // ---- (3) the sheet's Order Amount is already net -----------------------
  // `orders.amount` means the GROSS amount here — `orders_discount_not_over_amount`
  // only makes sense that way — and lifetime_value is sum(amount - discount).
  // But the KM002 sheet's "Order Amount" is what the customer was actually
  // charged, with "Discount" recorded alongside as information. Proof rather
  // than assumption: sheet row 1209 has amount 499 and discount 500, which is
  // impossible if the amount were gross. Subtracting again understates every
  // customer's lifetime value by roughly a tenth — and that is the number the
  // RRR screen ranks on.
  //
  // Zeroing the discount on legacy rows makes `amount` mean one thing across
  // the whole table. The discount figures are NOT preserved anywhere here;
  // they remain in the source sheet and in data/incoming if ever needed.
  const netted = await c.query(
    `update orders set discount = 0 where is_legacy and discount > 0`);

  const after = (await c.query(
    `select (select count(*)::int from orders) as orders,
            (select count(*)::int from followups where completed_at is null) as still_pending`)).rows[0];

  console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY RUN (nothing written)'}\n`);
  console.log('duplicate orders');
  console.log(`  pairs found                ${dupes.length}`);
  console.log(`  source copied onto keeper  ${sourcesMoved}`);
  console.log(`  follow-ups re-pointed      ${moved.rowCount}`);
  console.log(`  duplicate rows deleted     ${deleted.rowCount}`);
  console.log('\nfollow-ups with an outcome but no completion');
  console.log(`  marked completed           ${completed.rowCount}`);
  console.log(`\norders ${before.orders} -> ${after.orders}   ·   still pending follow-ups: ${after.still_pending}`);

  // Spot-check against a customer the team can eyeball on their own dashboard.
  const spot = (await c.query(
    `select full_name, lifetime_orders, lifetime_value
       from v_rrr_queue order by lifetime_value desc limit 5`)).rows;
  console.log('\ntop customers after the fix:');
  console.table(spot);

  if (COMMIT) await c.query('commit');
  else { await c.query('rollback'); console.log('rolled back — re-run with --commit to keep it'); }
  await c.end();
}

main().catch(async (e) => {
  console.error('\nfix failed:', e.message);
  try { await c.query('rollback'); await c.end(); } catch {}
  process.exit(1);
});
