-- Alka assigns from RRR > All customers, ownership moves and the row shows
-- "Assigned · today" — but for some customers no calling task is ever
-- created, so the rep's Open task / "Aaj ke calls" never sees it and it
-- never shows up filtered under their own id either.
--
-- Investigated 2026-09-22 against production: 212 customers in the RRR
-- queue (real orders, not DND, not merged) are currently owned by an active
-- salesperson with zero rrr_work_items ever created for them. The requires-
-- an-order guard in fn_assign_rrr_customers_with_work turns out not to be
-- the live cause — v_rrr_queue already requires lifetime_orders > 0, so a
-- customer without an order can't reach this screen to be selected. It was
-- dead weight, and the user asked for it gone outright, so it goes. The
-- actual 212 are leftovers from before 20260916081500 taught this entry
-- point to hand over the call as well as the customer; nothing since has
-- reproduced the gap on a fresh assign, but they are stuck exactly as
-- described, so this backfills their task too.
--
-- Down: supabase/migrations/20260922100000_an_assigned_customer_gets_the_call.down.sql

create or replace function public.fn_assign_rrr_customers_with_work(
  p_customer_ids uuid[],
  p_owner_id     uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_eligible uuid[];
  v_chunk    uuid[];
  v_owned    int;
  v_tasks    int := 0;
  i          int;
begin
  -- No role check of its own: both functions below check the caller, and this
  -- one must not become a second, looser way in.
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    return jsonb_build_object('owned', 0, 'tasks', 0, 'skipped', 0);
  end if;

  v_owned := public.fn_assign_rrr_customers(p_customer_ids, p_owner_id);

  if p_owner_id is null then
    -- Unassigning takes the calling task back too, DND and merged included:
    -- those are exactly the tasks that should not be sitting in a rep's day.
    v_tasks := public.fn_assign_rrr_work('due', p_customer_ids, null);
    return jsonb_build_object('owned', v_owned, 'tasks', v_tasks, 'skipped', 0);
  end if;

  -- A DND or merged customer cannot become a call; those two stay. The
  -- has-an-order guard is gone: v_rrr_queue (which is all this screen ever
  -- offers to select) already requires lifetime_orders > 0, so it never
  -- excluded anyone reachable here and only hid failures instead of
  -- surfacing them.
  select coalesce(array_agg(c.id), '{}') into v_eligible
  from public.customers c
  where c.id = any(p_customer_ids)
    and not c.is_dnd
    and c.merged_into_id is null;

  i := 1;
  while i <= cardinality(v_eligible) loop
    v_chunk := v_eligible[i : i + 249];   -- the work function takes 250 a call
    v_tasks := v_tasks + public.fn_assign_rrr_work('due', v_chunk, p_owner_id);
    i := i + 250;
  end loop;

  return jsonb_build_object(
    'owned', v_owned,
    'tasks', v_tasks,
    'skipped', cardinality(p_customer_ids) - cardinality(v_eligible));
end;
$$;

revoke all on function public.fn_assign_rrr_customers_with_work(uuid[], uuid) from public, anon;
grant execute on function public.fn_assign_rrr_customers_with_work(uuid[], uuid) to authenticated;

comment on function public.fn_assign_rrr_customers_with_work(uuid[], uuid) is
  'RRR > All customers assign: moves permanent ownership and hands over the calling task in one action (NULL owner = back to the pool, task withdrawn). Only DND and merged customers are held back. Permission is checked by the two functions it calls.';

-- Backfill: every currently-owned, callable RRR-queue customer that never
-- got a task, gets one now, so today's Open task / Aaj ke calls matches
-- what the Owner column has said all along.
insert into public.rrr_work_items (source, source_date, customer_id, order_id, assigned_to, assigned_by)
select 'due', public.ist_today(), c.id,
  coalesce(
    (select f.order_id from public.followups f
      where f.customer_id = c.id and f.kind = 'order' and f.completed_at is null
        and f.order_id is not null
      order by f.due_at, f.id limit 1),
    (select o.id from public.orders o where o.customer_id = c.id
      order by o.created_at desc, o.id desc limit 1)),
  c.current_owner_id, c.current_owner_id
from public.customers c
join public.users u on u.id = c.current_owner_id
where c.merged_into_id is null
  and not c.is_dnd
  and c.lifetime_orders > 0
  and u.role in ('sales_exec', 'sales_manager')
  and u.is_active
  and not exists (
    select 1 from public.rrr_work_items w
    where w.customer_id = c.id and w.completed_at is null)
on conflict (customer_id) where completed_at is null do nothing;
