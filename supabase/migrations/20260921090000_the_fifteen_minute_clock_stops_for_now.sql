-- The fifteen-minute clock stops, for now
--
-- `sla_breach` sat at the top of the Today queue: any lead not yet contacted
-- once its `sla_due_at` had passed. Migration 014 gave that column a default of
-- now() + 15 minutes, and 018 nulled it out for the legacy Zoho backfill — but
-- the live Zoho sync keeps inserting fresh rows that take the default and
-- breach a quarter of an hour later. Every one of the 67 rows in the bucket
-- today is an unpaid `zoho_legacy` lead. A red banner that is always on is not
-- a signal, so the bucket comes out of the queue.
--
-- The `sla_due_at is null or sla_due_at >= now()` guards came from 017, whose
-- job was to stop a breached lead appearing twice. With no breach branch left
-- they would instead hide every breached lead completely, so they come out
-- too: an uncontacted lead now lands in `paid_lead` or `unpaid_lead` on its
-- merits, whatever its clock says.
--
-- `leads.sla_due_at` keeps its column, its default and its index. Nothing is
-- dropped, so the down migration restores the bucket on its own.
--
-- Down: supabase/migrations/20260921090000_the_fifteen_minute_clock_stops_for_now.down.sql

create or replace view v_aaj_ka_kaam with (security_invoker = true) as
select 1 as rank_bucket, 'paid_lead' as bucket, 'lead' as entity_type,
       l.id as entity_id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164)
            else c.phone_e164 end as phone,
       l.paid_at as due_at, l.owner_id,
       'Paid — book consultation' as action_label
from leads l join customers c on c.id = l.customer_id
where l.payment_state = 'paid' and l.first_contacted_at is null
  and l.is_junk = false and c.merged_into_id is null

union all
select 2, 'rrr_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id,
       case f.rrr_touch when 'repeat_pitch' then 'Pitch the repeat order'
                        when 'last_chance'  then 'Last chance call'
                        when 'mid'          then 'Mid-course check-in'
                        else 'Response check' end
from followups f join customers c on c.id = f.customer_id
where f.kind = 'rrr' and f.completed_at is null and f.due_at <= now()
  and c.merged_into_id is null

union all
select 3, 'followup_due', 'followup', f.id, f.customer_id, c.full_name,
       c.phone_e164, f.due_at, f.owner_id, 'Follow up'
from followups f join customers c on c.id = f.customer_id
where f.kind <> 'rrr' and f.completed_at is null and f.due_at <= now()
  and c.merged_into_id is null

union all
select 4, 'unpaid_lead', 'lead', l.id, l.customer_id, c.full_name,
       case when l.owner_id is null then mask_phone(c.phone_e164) else c.phone_e164 end,
       l.created_at, l.owner_id, 'Unpaid — follow up'
from leads l join customers c on c.id = l.customer_id
where l.payment_state = 'unpaid' and l.first_contacted_at is null
  and l.is_junk = false and c.merged_into_id is null;

comment on column leads.sla_due_at is
  'Still written on every new lead, but no longer read by the Today queue: '
  'the sla_breach bucket was removed on 2026-09-21 because the live Zoho sync '
  'made it permanently full. Restore it with the down migration.';
