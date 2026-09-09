-- 027 · RRR screen: drop the segment, add the history
--
-- User: "I think ye segment wali cheez is just a confusion so completely
-- remove that." Good call, and it retires a wart flagged in D-065: `segment`
-- meant one thing in PROJECT.md (measured from course_ends_at, NULL across the
-- whole imported base) and another on the team's own dashboard (orders +
-- recency), and having both on one screen under the same A1..C2 labels could
-- only mislead. The underlying `customers.segment` column is untouched — this
-- removes it from the RRR screen, it does not redefine anyone's data.
--
-- In its place, what the team actually reads on their existing workspace:
-- payment profile, AOV, how long since the last order, and — on opening a
-- customer — their order history and every call ever made to them.
--
-- Down: supabase/migrations/027_rrr_customer_history.down.sql

drop view if exists v_rrr_queue;

create view v_rrr_queue with (security_invoker = true) as
select
  c.id                                            as customer_id,
  c.full_name,
  c.phone_e164,
  c.lifetime_orders,
  c.lifetime_value,
  case when c.lifetime_orders > 0
       then round(c.lifetime_value / c.lifetime_orders, 2) end  as aov,
  (c.lifetime_orders > 1)                         as is_repeat_buyer,
  c.last_order_at::date                           as last_order_on,
  (current_date - c.last_order_at::date)          as days_since_order,
  pay.profile                                     as payment_profile,
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
-- How this customer pays, across everything they have ever ordered. `partial`
-- is COD with something paid up front, so it counts as mixed, not prepaid.
left join lateral (
  select case
           when bool_and(o.payment_state = 'paid')   then 'Prepaid only'
           when bool_and(o.payment_state = 'unpaid') then 'COD only'
           else 'Mixed'
         end as profile
  from orders o
  where o.customer_id = c.id
) pay on true
where c.merged_into_id is null
  and c.lifetime_orders > 0;

comment on view v_rrr_queue is
  'Everyone who has ever ordered: how they pay, what they are worth, how long since they bought, and what the floor already tried. No segment column on purpose (D-067).';

-- ---------------------------------------------------------------------------
-- Opening a customer. Two views rather than one join, because they answer two
-- different questions and the screen shows them as two separate lists.
-- ---------------------------------------------------------------------------
create view v_rrr_customer_orders with (security_invoker = true) as
select
  o.customer_id,
  o.id                                            as order_id,
  o.order_no,
  o.created_at::date                              as ordered_on,
  o.amount,
  o.discount,
  o.stage,
  o.payment_state,
  pm.label_en                                     as payment_mode,
  o.ship_state,
  src.label_en                                    as source,
  o.course_duration_days,
  o.delivered_at::date                            as delivered_on,
  -- "Gold Plus 30N×1, Power Drive×3", or NULL where the source sheet never
  -- recorded a product breakdown (D-062) — shown as unknown, not as empty.
  items.products
from orders o
left join payment_modes pm on pm.id = o.payment_mode_id
left join lead_sources src on src.id = o.source_id
left join lateral (
  select string_agg(p.name || coalesce(' ' || p.variant, '') || '×' || oi.quantity,
                    ', ' order by p.sort_order) as products
  from order_items oi
  join products p on p.id = oi.product_id
  where oi.order_id = o.id
) items on true;

comment on view v_rrr_customer_orders is
  'One customer''s order history for the RRR detail panel. products is NULL when the source sheet had no per-product columns for that order.';

create view v_rrr_customer_followups with (security_invoker = true) as
select
  f.customer_id,
  f.id                                            as followup_id,
  f.due_at,
  f.completed_at,
  f.outcome,
  f.remark,
  f.attempt_no,
  f.kind,
  u.full_name                                     as by_name,
  cn.label_en                                     as called_from
from followups f
left join users u on u.id = f.owner_id
left join contact_numbers cn on cn.id = f.contact_number_id;

comment on view v_rrr_customer_followups is
  'Every call ever logged against a customer, newest first in the UI. Rows with completed_at NULL are still pending, not history.';
