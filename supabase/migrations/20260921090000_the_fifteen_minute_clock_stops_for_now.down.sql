-- Restore the Today queue exactly as migration 021 left it: the sla_breach
-- bucket back at rank 1, and the 017 guards back on the paid and unpaid
-- branches so a breached lead shows up once, not twice.

create or replace view v_aaj_ka_kaam with (security_invoker = true) as
select 1 as rank_bucket, 'sla_breach' as bucket, 'lead' as entity_type,
       l.id as entity_id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164)
            else c.phone_e164 end as phone,
       l.sla_due_at as due_at, l.owner_id, 'Call now' as action_label
from leads l join customers c on c.id = l.customer_id
where l.first_contacted_at is null and l.sla_due_at < now()
  and l.is_junk = false and c.merged_into_id is null

union all
select 2, 'paid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164) else c.phone_e164 end,
       l.paid_at, l.owner_id, 'Paid — book consultation'
from leads l join customers c on c.id = l.customer_id
where l.payment_state = 'paid' and l.first_contacted_at is null
  and (l.sla_due_at is null or l.sla_due_at >= now())
  and l.is_junk = false and c.merged_into_id is null

union all
select 3, 'rrr_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id,
       case f.rrr_touch when 'repeat_pitch' then 'Pitch the repeat order'
                        when 'last_chance'  then 'Last chance call'
                        when 'mid'          then 'Mid-course check-in'
                        else 'Response check' end
from followups f join customers c on c.id = f.customer_id
where f.kind = 'rrr' and f.completed_at is null and f.due_at <= now()
  and c.merged_into_id is null

union all
select 4, 'followup_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id, 'Follow up'
from followups f join customers c on c.id = f.customer_id
where f.kind <> 'rrr' and f.completed_at is null and f.due_at <= now()
  and c.merged_into_id is null

union all
select 5, 'unpaid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164) else c.phone_e164 end,
       l.created_at, l.owner_id, 'Unpaid — follow up'
from leads l join customers c on c.id = l.customer_id
where l.payment_state = 'unpaid' and l.first_contacted_at is null
  and (l.sla_due_at is null or l.sla_due_at >= now())
  and l.is_junk = false and c.merged_into_id is null;

comment on column leads.sla_due_at is
  'Null for the zoho_legacy backfill: an import is not a missed call. '
  'Live leads get now() + 15 minutes and appear in the sla_breach bucket.';
