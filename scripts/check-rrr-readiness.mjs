import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'kamour-rrr-readiness' });
try {
  await db.connect();
  const result = await db.query(`
    select l.owner_id as assigned_to, u.full_name as rep, count(*)::int as leads,
      count(*) filter (where q.open_followup_id is not null)::int as with_open_followup,
      count(*) filter (where q.open_followup_id is not null and f.owner_id is distinct from l.owner_id)::int as open_owned_elsewhere,
      count(*) filter (where q.current_owner_id is distinct from l.owner_id)::int as customer_owned_elsewhere,
      count(*) filter (where l.reason like 'Carried over from %')::int as carried
    from ai_daily_leads l
    join users u on u.id = l.owner_id
    join v_rrr_queue q on q.customer_id = l.customer_id
    left join followups f on f.id = q.open_followup_id
    where l.run_on = ist_today()
    group by l.owner_id, u.full_name order by u.full_name`);
  console.log(JSON.stringify(result.rows, null, 2));
  const runs = await db.query(`select run_on::text, generated_at, total from ai_lead_runs
    where run_on between ist_today() - 1 and ist_today() order by run_on`);
  console.log(JSON.stringify(runs.rows, null, 2));
  const totals = await db.query(`
    select
      (select count(*)::int from v_rrr_queue) as rrr_customers,
      (select count(*)::int from followups where kind = 'order' and completed_at is null) as pending_order_followups,
      (select count(*)::int from followups where kind = 'order' and completed_at is not null
        and (completed_at at time zone 'Asia/Kolkata')::date >= '2026-09-09'::date
        and remark like '%exact call time not recorded%') as recent_date_only_calls,
      (select count(*)::int from orders where stage = 'delivered' and delivered_at is not null
        and course_duration_days in (15,30)) as delivered_15_30,
      (select count(*)::int from orders where stage = 'delivered' and delivered_at is not null
        and course_duration_days in (15,30)
        and delivered_at::date <> (delivered_at at time zone 'Asia/Kolkata')::date) as utc_date_shifted,
      (select count(*)::int from import_rejects where source = 'km002_ai_queue'
        and reason = 'customer_has_no_order_to_attach_to' and source_row_no >= 1775) as recent_no_order_rejects`);
  console.log(JSON.stringify(totals.rows[0], null, 2));
} finally {
  await db.end();
}
