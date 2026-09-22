-- Restores the upsert-with-no-rep behaviour. The deleted rep-less tasks are
-- not recreated.
create or replace function public.fn_assign_rrr_work(
  p_source text, p_ids uuid[], p_owner_id uuid
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := app_role();
  v_target_role user_role;
  v_active boolean;
  v_id uuid;
  v_customer uuid;
  v_order uuid;
  v_count int := 0;
begin
  if v_role is null or v_role not in ('admin','ceo','coo','auditor') then
    raise exception 'Not permitted to assign RRR work.' using errcode = '42501';
  end if;
  if p_source not in ('ai','medicine_ending') then
    raise exception 'Unknown RRR work source.' using errcode = '22023';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if cardinality(p_ids) > 250 then
    raise exception 'Assign at most 250 items at a time.' using errcode = '22023';
  end if;
  if p_owner_id is not null then
    select role, is_active into v_target_role, v_active from public.users where id = p_owner_id;
    if v_target_role not in ('sales_exec','sales_manager') or not coalesce(v_active,false) then
      raise exception 'Choose an active salesperson.' using errcode = '22023';
    end if;
  end if;

  for v_id in select distinct unnest(p_ids) loop
    v_customer := null;
    v_order := null;
    if p_source = 'ai' then
      select l.customer_id, o.id into v_customer, v_order
      from public.ai_daily_leads l
      join lateral (
        select id from public.orders where customer_id = l.customer_id
        order by created_at desc, id desc limit 1
      ) o on true
      where l.customer_id = v_id and l.run_on = public.ist_today();
    else
      select o.customer_id, o.id into v_customer, v_order
      from public.orders o
      where o.id = v_id and o.stage = 'delivered' and o.delivered_at is not null
        and o.course_duration_days in (15,30);
    end if;
    if v_customer is null or v_order is null then
      raise exception 'Selected AI lead or medicine order is no longer eligible.' using errcode = '22023';
    end if;
    if exists (select 1 from public.customers c where c.id = v_customer
               and (c.is_dnd or c.merged_into_id is not null)) then
      raise exception 'A selected customer is DND or merged and cannot be assigned.' using errcode = '22023';
    end if;
    insert into public.rrr_work_items
      (source, source_date, customer_id, order_id, assigned_to, assigned_by)
    values (p_source, case when p_source = 'ai' then public.ist_today() else null end,
      v_customer, v_order, p_owner_id, auth.uid())
    on conflict (customer_id) where completed_at is null do update set
      source = excluded.source,
      source_date = excluded.source_date,
      order_id = excluded.order_id,
      assigned_to = excluded.assigned_to,
      assigned_by = excluded.assigned_by,
      assigned_at = now(),
      updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
