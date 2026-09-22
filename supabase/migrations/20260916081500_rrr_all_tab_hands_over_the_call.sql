-- Assigning on RRR > All customers moved permanent ownership and nothing else.
-- Since the 14 September cutover a rep's only screen is /rrr/my, which reads
-- rrr_work_items, and the restrictive `sales_rrr_customers_only` policy hides
-- every customer with no open task of their own. So the tick-and-assign Alka
-- uses there landed in `customers.current_owner_id` and reached nobody: the
-- rep saw an empty day, and the row on her screen never changed.
--
-- One assign, both halves. Ownership still moves, exactly as before, and the
-- same action now hands over the call, the way Due today / AI Leads / Medicine
-- Ending already do. Putting a customer back in the unassigned pool takes the
-- open task back with it.
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

  -- A DND or merged customer, or one whose orders never made it into the
  -- database, cannot become a call. fn_assign_rrr_work raises on those, which
  -- would fail the whole batch over one row, so they are counted out here and
  -- reported back rather than silently dropped.
  select coalesce(array_agg(c.id), '{}') into v_eligible
  from public.customers c
  where c.id = any(p_customer_ids)
    and not c.is_dnd
    and c.merged_into_id is null
    and exists (select 1 from public.orders o where o.customer_id = c.id);

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
  'RRR > All customers assign: moves permanent ownership and hands over the calling task in one action (NULL owner = back to the pool, task withdrawn). Permission is checked by the two functions it calls.';
