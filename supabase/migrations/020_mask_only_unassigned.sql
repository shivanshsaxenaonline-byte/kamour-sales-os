-- 020 · mask the phone for UNASSIGNED leads, not for everyone but the owner
--
-- PROJECT.md: "Phone numbers masked (98••••4773) for unassigned leads."
-- The queue masked on `owner_id <> auth.uid()`, so a sales_manager reviewing
-- their own team's work saw 79••••1046 — useless for a manager who needs to
-- call, and not what the rule says.
--
-- RLS has already decided WHETHER a row is visible. Masking answers a narrower
-- question: has this lead been claimed yet? Unclaimed -> masked, for everyone.
--
-- Down: supabase/migrations/020_mask_only_unassigned.down.sql

create or replace view v_aaj_ka_kaam with (security_invoker = true) as
select 1 as rank_bucket, 'sla_breach' as bucket, 'lead' as entity_type,
       l.id as entity_id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164)
            else c.phone_e164 end as phone,
       l.sla_due_at as due_at, l.owner_id, 'Turant call karo' as action_label
from leads l join customers c on c.id = l.customer_id
where l.first_contacted_at is null and l.sla_due_at < now()
  and l.is_junk = false and c.merged_into_id is null

union all
select 2, 'paid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164) else c.phone_e164 end,
       l.paid_at, l.owner_id, 'Paid lead — consult book karo'
from leads l join customers c on c.id = l.customer_id
where l.payment_state = 'paid' and l.first_contacted_at is null
  and (l.sla_due_at is null or l.sla_due_at >= now())
  and l.is_junk = false and c.merged_into_id is null

union all
select 3, 'rrr_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id,
       case f.rrr_touch when 'repeat_pitch' then 'Repeat pitch karo'
                        when 'last_chance'  then 'Last chance call'
                        else 'RRR follow-up' end
from followups f join customers c on c.id = f.customer_id
where f.kind = 'rrr' and f.completed_at is null and f.due_at <= now()
  and c.merged_into_id is null

union all
select 4, 'followup_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id, 'Follow-up baaki'
from followups f join customers c on c.id = f.customer_id
where f.kind <> 'rrr' and f.completed_at is null and f.due_at <= now()
  and c.merged_into_id is null

union all
select 5, 'unpaid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164) else c.phone_e164 end,
       l.created_at, l.owner_id, 'Unpaid — follow karo'
from leads l join customers c on c.id = l.customer_id
where l.payment_state = 'unpaid' and l.first_contacted_at is null
  and (l.sla_due_at is null or l.sla_due_at >= now())
  and l.is_junk = false and c.merged_into_id is null;

create or replace view v_leads_list with (security_invoker = true) as
select l.id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164)
            else c.phone_e164 end as phone,
       src.label_en as source, st.label_en as status,
       l.payment_state, l.amount, l.is_junk, l.sla_due_at, l.first_contacted_at,
       l.owner_id, u.full_name as owner_name, l.created_at
from leads l
join customers c on c.id = l.customer_id
join lead_sources src on src.id = l.source_id
join lead_statuses st on st.id = l.status_id
left join users u on u.id = l.owner_id
where c.merged_into_id is null;
