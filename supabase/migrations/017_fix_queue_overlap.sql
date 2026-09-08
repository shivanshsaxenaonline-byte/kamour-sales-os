-- 017 · Aaj Ka Kaam buckets must be mutually exclusive
--
-- The original view put an uncontacted, SLA-breached, unpaid lead into BOTH
-- bucket 1 (sla_breach) and bucket 5 (unpaid_lead). Result: 31,922 rows for
-- 15,961 actual people — every rep would work each person twice.
--
-- PROJECT.md calls this "ONE priority queue". One person, one row, at their
-- highest-priority reason.
--
-- Down: supabase/migrations/017_fix_queue_overlap.down.sql

drop view if exists v_aaj_ka_kaam;

create view v_aaj_ka_kaam with (security_invoker = true) as
-- 1 · SLA breached, still not contacted. Outranks everything, paid or not.
select 1                       as rank_bucket,
       'sla_breach'            as bucket,
       'lead'                  as entity_type,
       l.id                    as entity_id,
       l.customer_id,
       c.full_name,
       case when l.owner_id = auth.uid() then c.phone_e164
            else mask_phone(c.phone_e164) end as phone,
       l.sla_due_at            as due_at,
       l.owner_id,
       'Turant call karo'      as action_label
from leads l
join customers c on c.id = l.customer_id
where l.first_contacted_at is null
  and l.sla_due_at < now()
  and l.is_junk = false
  and c.merged_into_id is null

union all
-- 2 · paid lead waiting, still inside its SLA window
select 2, 'paid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id = auth.uid() then c.phone_e164
            else mask_phone(c.phone_e164) end,
       l.paid_at, l.owner_id, 'Paid lead — consult book karo'
from leads l
join customers c on c.id = l.customer_id
where l.payment_state = 'paid'
  and l.first_contacted_at is null
  and (l.sla_due_at is null or l.sla_due_at >= now())   -- else bucket 1 owns it
  and l.is_junk = false
  and c.merged_into_id is null

union all
-- 3 · RRR touch due
select 3, 'rrr_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id,
       case f.rrr_touch
         when 'repeat_pitch' then 'Repeat pitch karo'
         when 'last_chance'  then 'Last chance call'
         else 'RRR follow-up' end
from followups f
join customers c on c.id = f.customer_id
where f.kind = 'rrr'
  and f.completed_at is null
  and f.due_at <= now()
  and c.merged_into_id is null

union all
-- 4 · ordinary follow-up due
select 4, 'followup_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id, 'Follow-up baaki'
from followups f
join customers c on c.id = f.customer_id
where f.kind <> 'rrr'
  and f.completed_at is null
  and f.due_at <= now()
  and c.merged_into_id is null

union all
-- 5 · unpaid lead, uncontacted, still inside its SLA window
select 5, 'unpaid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id = auth.uid() then c.phone_e164
            else mask_phone(c.phone_e164) end,
       l.created_at, l.owner_id, 'Unpaid — follow karo'
from leads l
join customers c on c.id = l.customer_id
where l.payment_state = 'unpaid'
  and l.first_contacted_at is null
  and (l.sla_due_at is null or l.sla_due_at >= now())   -- else bucket 1 owns it
  and l.is_junk = false
  and c.merged_into_id is null;

comment on view v_aaj_ka_kaam is
  'ONE priority queue, buckets mutually exclusive. Query with: order by rank_bucket, due_at — never select *.';
