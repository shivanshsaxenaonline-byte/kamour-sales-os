-- 025 · the RRR list, and assigning from it
--
-- User: "here must be a tab of rrr like in alka and coo and shivansh they can
-- see all rrr list and after that according to data they can tick and send the
-- leads to sales person or assign them."
--
-- Two pieces: a view that answers "who is due for a repeat-order call, and what
-- do I need to know to decide who should make it", and one function that moves
-- a batch of them to a salesperson.
--
-- Down: supabase/migrations/025_rrr_queue_and_assign.down.sql

-- ---------------------------------------------------------------------------
-- The list. security_invoker so each viewer sees exactly the customers their
-- own RLS policy allows — the oversight roles (admin/ceo/coo/sales_manager/
-- auditor) see everyone, a sales exec sees only their own. (007, 019)
--
-- Deliberately NOT filtered to "due today": the whole point of this screen is
-- that Alka/Kratika/Shivansh look across the WHOLE base and decide. Filtering
-- belongs in the UI, where it can be changed without a migration.
-- ---------------------------------------------------------------------------
create view v_rrr_queue with (security_invoker = true) as
select
  c.id                                            as customer_id,
  c.full_name,
  c.phone_e164,
  c.segment,
  -- `customers.segment` is PROJECT.md's ladder, measured from course_ends_at,
  -- and it is NULL for the whole imported base because a legacy order has no
  -- dispatch_date and therefore no computable course end (D-062). Rather than
  -- redefine that column's meaning, this is the ladder the team already reads
  -- every day on their own dashboard — orders + recency, same A1..C2 labels —
  -- computed here so the RRR tab is not a screen full of blanks. If the two
  -- ever need to be one thing, that is a decision to take deliberately.
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
  -- what the sales floor already tried, from the imported call log (D-064)
  fu.attempts,
  fu.last_contacted_on,
  fu.last_outcome,
  fu.next_due_on,
  -- where this customer's most recent order came from (D-063)
  src.label_en                                    as last_order_source
from customers c
left join users owner on owner.id = c.current_owner_id
left join lateral (
  select count(*)                                              as attempts,
         max(f.completed_at)::date                             as last_contacted_on,
         (array_agg(f.outcome order by f.completed_at desc nulls last))[1] as last_outcome,
         min(f.due_at) filter (where f.completed_at is null)::date         as next_due_on
  from followups f
  where f.customer_id = c.id
) fu on true
left join lateral (
  select ls.label_en
  from orders o
  left join lead_sources ls on ls.id = o.source_id
  where o.customer_id = c.id
  order by o.created_at desc
  limit 1
) src on true
where c.merged_into_id is null
  and c.lifetime_orders > 0;   -- RRR is repeat business: no order, no RRR

comment on view v_rrr_queue is
  'Everyone who has ever ordered, with their segment, what the floor already tried, and who owns them now. The RRR tab reads this; assignment is done through fn_assign_rrr_customers.';

-- ---------------------------------------------------------------------------
-- Assignment.
--
-- Alka is an `auditor` — read-everything, write-nothing by design (D-012/013),
-- and the migration comment there says giving that role write access "would
-- make the audit trail lie about who looked at what". The user was shown that
-- conflict and chose explicitly to let her assign anyway. So instead of
-- widening the auditor's write surface across every table, this is the single
-- narrow hole: SECURITY DEFINER, one field, permission checked in the body,
-- and the existing customers audit trigger records who did it. An auditor
-- still cannot touch amounts, outcomes, stages or anything else.
-- ---------------------------------------------------------------------------
create or replace function fn_assign_rrr_customers(
  p_customer_ids uuid[],
  p_owner_id     uuid
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_role       user_role := app_role();
  v_new_role   user_role;
  v_active     boolean;
  v_count      int;
begin
  if v_role is null or v_role not in ('admin','ceo','coo','sales_manager','auditor') then
    raise exception 'Not permitted to assign RRR leads.' using errcode = '42501';
  end if;

  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    return 0;
  end if;

  -- p_owner_id NULL means "put it back in the unassigned pool", which is a
  -- real action here: 156 website orders arrived unassigned (D-063).
  if p_owner_id is not null then
    select role, is_active into v_new_role, v_active from users where id = p_owner_id;
    if v_new_role is null then
      raise exception 'That user does not exist.' using errcode = '22023';
    end if;
    if not v_active then
      raise exception 'That user is deactivated.' using errcode = '22023';
    end if;
    if v_new_role not in ('sales_exec','sales_manager') then
      raise exception 'RRR leads can only go to a salesperson.' using errcode = '22023';
    end if;
  end if;

  update customers
     set current_owner_id = p_owner_id
   where id = any(p_customer_ids)
     and merged_into_id is null
     and current_owner_id is distinct from p_owner_id;
  get diagnostics v_count = row_count;

  -- Open follow-ups follow the customer, or the new owner inherits a queue
  -- they cannot see. Completed ones keep their original owner: who made a
  -- call in the past is history and is never rewritten.
  update followups
     set owner_id = p_owner_id
   where customer_id = any(p_customer_ids)
     and completed_at is null;

  return v_count;
end;
$$;

revoke all on function fn_assign_rrr_customers(uuid[], uuid) from public;
grant execute on function fn_assign_rrr_customers(uuid[], uuid) to authenticated;

comment on function fn_assign_rrr_customers(uuid[], uuid) is
  'Bulk-assign RRR customers to a salesperson (NULL = back to unassigned). The only path by which an auditor may write, deliberately (D-065); every change is recorded in audit_log by the customers trigger.';
