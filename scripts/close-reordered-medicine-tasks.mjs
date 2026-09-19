// Remove medicine-ending calling tasks whose customer has already reordered.
//
// The screen stopped raising these on 19 Sep (see the medicine-ending page:
// only 148 of 2,037 orders are ever marked `delivered`, so a customer's newer
// `confirmed` order used to be invisible here). Six tasks raised before that
// were still sitting in a rep's list, each one asking them to ring a customer
// about a course that customer had already replaced.
//
// Deleting, not completing: a task nobody called is not a call that happened,
// and fn_assign_rrr_work already removes unworked tasks by deleting them —
// the history lives in followups, not here. Only tasks with no outcome logged
// are touched; anything a rep has actually worked is left alone.
//
//   node scripts/close-reordered-medicine-tasks.mjs          # show only
//   node scripts/close-reordered-medicine-tasks.mjs --apply  # and delete
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const apply = process.argv.includes('--apply');
const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-close-reordered',
});
await db.connect();

const FIND = `
  select w.id, coalesce(u.full_name, 'Unassigned') as rep, cu.full_name as customer,
         o.order_no, (o.created_at at time zone 'Asia/Kolkata')::date as course_ordered,
         (select max(n.created_at at time zone 'Asia/Kolkata')::date
            from orders n
           where n.customer_id = w.customer_id and n.created_at > o.created_at) as reordered_on
  from rrr_work_items w
  join orders o     on o.id = w.order_id
  join customers cu on cu.id = w.customer_id
  left join users u on u.id = w.assigned_to
  where w.source = 'medicine_ending'
    and w.completed_at is null
    and w.last_outcome is null          -- never worked; a logged call stays
    and exists (select 1 from orders n
                 where n.customer_id = w.customer_id and n.created_at > o.created_at)
  order by rep, customer`;

try {
  const { rows } = await db.query(FIND);
  if (!rows.length) {
    console.log('No medicine-ending tasks are waiting on a customer who already reordered.');
  } else {
    console.log(`${rows.length} task(s) whose customer has already reordered:\n`);
    for (const r of rows) {
      console.log(`  ${r.rep} · ${r.customer} · ${r.order_no}`
        + ` (course ordered ${r.course_ordered.toISOString().slice(0, 10)},`
        + ` reordered ${r.reordered_on.toISOString().slice(0, 10)})`);
    }
    if (!apply) {
      console.log('\nDry run. Re-run with --apply to remove them.');
    } else {
      const ids = rows.map((r) => r.id);
      const { rowCount } = await db.query(
        'delete from rrr_work_items where id = any($1::uuid[])', [ids]);
      console.log(`\nRemoved ${rowCount} task(s).`);
      const left = await db.query(
        `select count(*)::int n from rrr_work_items
          where source = 'medicine_ending' and completed_at is null`);
      console.log(`Open medicine-ending tasks remaining: ${left.rows[0].n}`);
    }
  }
} finally {
  await db.end();
}
