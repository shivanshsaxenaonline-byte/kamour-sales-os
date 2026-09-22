-- Restores the has-an-order guard. The backfilled tasks are ordinary `due`
-- work items indistinguishable from a normal assign; they are left with
-- their reps rather than guessed back out.
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
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    return jsonb_build_object('owned', 0, 'tasks', 0, 'skipped', 0);
  end if;

  v_owned := public.fn_assign_rrr_customers(p_customer_ids, p_owner_id);

  if p_owner_id is null then
    v_tasks := public.fn_assign_rrr_work('due', p_customer_ids, null);
    return jsonb_build_object('owned', v_owned, 'tasks', v_tasks, 'skipped', 0);
  end if;

  select coalesce(array_agg(c.id), '{}') into v_eligible
  from public.customers c
  where c.id = any(p_customer_ids)
    and not c.is_dnd
    and c.merged_into_id is null
    and exists (select 1 from public.orders o where o.customer_id = c.id);

  i := 1;
  while i <= cardinality(v_eligible) loop
    v_chunk := v_eligible[i : i + 249];
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
