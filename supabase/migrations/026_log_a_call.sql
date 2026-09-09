-- 026 · recording what happened on a call
--
-- The app could edit a follow-up's free-text remark and nothing else — no
-- outcome, no completion, no next date. That is the single action the sales
-- floor performs dozens of times a day, and it is the reason the team could
-- not stop using the Google Sheet. Their sheet's form is three required
-- steps: what was the outcome, who attended, and which business number the
-- call went out from.
--
-- `outcome`, `completed_at`, `next_due_at` and `owner_id` already exist on
-- followups (005, 024). Only the business number was missing, and it is a
-- fixed list, so it becomes a lookup like every other fixed list here rather
-- than free text in a remark.
--
-- Down: supabase/migrations/026_log_a_call.down.sql

create table contact_numbers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  label_en    text not null,
  label_hi    text,
  sort_order  int not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on contact_numbers (sort_order) where is_active;

alter table contact_numbers enable row level security;
create policy contact_numbers_read on contact_numbers
  for select to authenticated using (true);

-- The four numbers the team actually calls and WhatsApps from, taken from
-- FOLLOW_UP_NUMBERS in their own Apps Script — not invented here.
insert into contact_numbers (code, label_en, sort_order) values
  ('7217399285', '7217399285', 10),
  ('9557799285', '9557799285', 20),
  ('9045599288', '9045599288', 30),
  ('9045599289', '9045599289', 40)
on conflict (code) do nothing;

alter table followups add column contact_number_id uuid references contact_numbers(id);

comment on column followups.contact_number_id is
  'Which business number this call went out from. Required by the floor''s own process so a customer keeps seeing the same number on WhatsApp.';

-- ---------------------------------------------------------------------------
-- The RRR list needs to know WHICH follow-up a call closes. Two extra fields:
-- the open follow-up to close, and the customer's latest order, which is the
-- parent for a call made with nothing scheduled — 618 of the 1,769 rows in
-- the team's own queue are exactly that ("manual_follow_up": a rep opened a
-- customer and called them without waiting for the system to ask).
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: CREATE OR REPLACE VIEW cannot add a column
-- anywhere but the end, and these belong beside the other follow-up fields.
drop view if exists v_rrr_queue;

create view v_rrr_queue with (security_invoker = true) as
select
  c.id                                            as customer_id,
  c.full_name,
  c.phone_e164,
  c.segment,
  case
    when c.last_order_at is null                                     then null
    when c.lifetime_orders >= 3
     and current_date - c.last_order_at::date <= 60                  then 'A1'
    when c.lifetime_orders >= 2
     and current_date - c.last_order_at::date <= 180                 then 'A2'
    when c.lifetime_orders  = 1
     and current_date - c.last_order_at::date <= 60                  then 'B1'
    when c.lifetime_orders  = 1
     and current_date - c.last_order_at::date <= 180                 then 'B2'
    when current_date - c.last_order_at::date <= 364                 then 'C1'
    else                                                                  'C2'
  end                                             as rfm_segment,
  c.lifetime_orders,
  c.lifetime_value,
  c.last_order_at::date                           as last_order_on,
  c.course_ends_at,
  (current_date - c.course_ends_at)               as days_since_course_end,
  (current_date - c.last_order_at::date)          as days_since_order,
  c.current_owner_id,
  owner.full_name                                 as owner_name,
  c.is_dnd,
  fu.attempts,
  fu.last_contacted_on,
  fu.last_outcome,
  fu.next_due_on,
  fu.open_followup_id,
  last_order.id                                   as last_order_id,
  src.label_en                                    as last_order_source
from customers c
left join users owner on owner.id = c.current_owner_id
left join lateral (
  select count(*)                                              as attempts,
         max(f.completed_at)::date                             as last_contacted_on,
         (array_agg(f.outcome order by f.completed_at desc nulls last))[1] as last_outcome,
         min(f.due_at) filter (where f.completed_at is null)::date         as next_due_on,
         (array_agg(f.id order by f.due_at) filter (where f.completed_at is null))[1] as open_followup_id
  from followups f
  where f.customer_id = c.id
) fu on true
left join lateral (
  select o.id, o.source_id
  from orders o
  where o.customer_id = c.id
  order by o.created_at desc
  limit 1
) last_order on true
left join lead_sources src on src.id = last_order.source_id
where c.merged_into_id is null
  and c.lifetime_orders > 0;

comment on view v_rrr_queue is
  'Everyone who has ever ordered, with their segment, what the floor already tried, and who owns them now. The RRR tab reads this; assignment goes through fn_assign_rrr_customers and calls are logged against open_followup_id (or last_order_id when nothing is scheduled).';
