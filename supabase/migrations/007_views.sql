-- 007 · narrow list views
--
-- Column discipline enforced in SQL rather than trusted to each component.
-- A view that does not contain raw_payload / notes / body cannot leak them
-- into a list payload no matter what the client writes. (decisions.md D-006)
--
-- security_invoker = true is essential: without it these views run as the
-- owner and bypass every RLS policy in migration 008.
--
-- Down: supabase/migrations/007_views.down.sql

create view v_leads_list with (security_invoker = true) as
select
  l.id,
  l.customer_id,
  c.full_name,
  case when l.owner_id = auth.uid() then c.phone_e164
       else mask_phone(c.phone_e164) end        as phone,
  src.label_en                                  as source,
  st.label_en                                   as status,
  l.payment_state,
  l.amount,
  l.is_junk,
  l.sla_due_at,
  l.first_contacted_at,
  l.owner_id,
  u.full_name                                   as owner_name,
  l.created_at
from leads l
join customers c   on c.id = l.customer_id
join lead_sources src on src.id = l.source_id
join lead_statuses st on st.id = l.status_id
left join users u  on u.id = l.owner_id
where c.merged_into_id is null;

create view v_consultations_list with (security_invoker = true) as
select
  k.id,
  k.customer_id,
  c.full_name,
  c.phone_e164        as phone,
  k.doctor_id,
  d.full_name         as doctor_name,
  k.scheduled_at,
  k.state,
  k.completed_at,
  k.fee_state,
  k.fee_amount,
  cr.label_en         as cancel_reason,
  k.created_at
from consultations k
join customers c  on c.id = k.customer_id
left join users d on d.id = k.doctor_id
left join cancel_reasons cr on cr.id = k.cancel_reason_id
where c.merged_into_id is null;

create view v_orders_list with (security_invoker = true) as
select
  o.id,
  o.order_no,
  o.customer_id,
  c.full_name,
  c.phone_e164        as phone,
  o.amount,
  o.discount,
  o.stage,
  o.payment_state,
  pm.label_en         as payment_mode,
  cu.label_en         as courier,
  o.awb,
  o.dispatch_date,
  o.course_duration_days,
  o.next_followup_at,
  o.is_repeat,
  o.current_owner_id,
  u.full_name         as owner_name,
  o.created_at
from orders o
join customers c on c.id = o.customer_id
left join payment_modes pm on pm.id = o.payment_mode_id
left join couriers cu on cu.id = o.courier_id
left join users u on u.id = o.current_owner_id
where c.merged_into_id is null;

-- ---------------------------------------------------------------------------
-- Aaj Ka Kaam — ONE priority queue across all sources, not a set of tabs.
-- Phase 1 ranking is a plain ORDER BY, no scoring model:
--   1 SLA breach · 2 paid lead · 3 RRR due · 4 follow-up due · 5 unpaid lead
-- ---------------------------------------------------------------------------
create view v_aaj_ka_kaam with (security_invoker = true) as
-- 1 · SLA breached, still not contacted
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
  and l.sla_due_at is not null
  and l.sla_due_at < now()
  and l.is_junk = false
  and c.merged_into_id is null

union all
-- 2 · paid lead waiting (they paid ₹99, the clock is on us)
select 2, 'paid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id = auth.uid() then c.phone_e164
            else mask_phone(c.phone_e164) end,
       l.paid_at, l.owner_id, 'Paid lead — consult book karo'
from leads l
join customers c on c.id = l.customer_id
where l.payment_state = 'paid'
  and l.first_contacted_at is null
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
-- 5 · unpaid lead, never contacted
select 5, 'unpaid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id = auth.uid() then c.phone_e164
            else mask_phone(c.phone_e164) end,
       l.created_at, l.owner_id, 'Unpaid — follow karo'
from leads l
join customers c on c.id = l.customer_id
where l.payment_state = 'unpaid'
  and l.first_contacted_at is null
  and l.is_junk = false
  and c.merged_into_id is null;

comment on view v_aaj_ka_kaam is
  'Default home for sales execs. Query with: order by rank_bucket, due_at — never select *.';
