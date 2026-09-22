-- Alka's explicit calling handoff. Daily AI suggestions and permanent customer
-- ownership are separate from the work a sales rep is allowed to call.
create table public.rrr_work_items (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('ai', 'medicine_ending')),
  source_date date,
  customer_id uuid not null references public.customers(id),
  order_id uuid not null references public.orders(id),
  assigned_to uuid references public.users(id),
  assigned_by uuid not null references public.users(id),
  assigned_at timestamptz not null default now(),
  due_on date not null default public.ist_today(),
  last_outcome text,
  last_called_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index rrr_work_one_open_customer on public.rrr_work_items(customer_id)
  where completed_at is null;
create index rrr_work_by_rep on public.rrr_work_items(assigned_to, due_on)
  where completed_at is null;
alter table public.rrr_work_items enable row level security;
grant select on public.rrr_work_items to authenticated;
create policy rrr_work_read on public.rrr_work_items for select to authenticated
  using ((assigned_to = (select auth.uid()) and completed_at is null)
    or ((select app_can_read_all())
      and (select app_role()) not in ('sales_exec','sales_manager')));

-- A still-open manual assignment must stay with its rep rather than being
-- reintroduced as a fresh AI suggestion after the normal cooldown.
do $$
declare definition text;
  needle text := 'and not c.is_dnd';
  old_gate text := 'v_role not in (''admin'',''ceo'',''coo'',''sales_manager'',''auditor'')';
begin
  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;
  if position(needle in definition) = 0 or position(old_gate in definition) = 0 then
    raise exception 'AI generator changed; assignment exclusion requires review';
  end if;
  definition := replace(definition, needle, needle || E'\n      and not exists (select 1 from public.rrr_work_items w where w.customer_id = c.id and w.completed_at is null)');
  definition := replace(definition,
    old_gate, 'v_role not in (''admin'',''ceo'',''coo'',''auditor'')');
  execute definition;
end $$;

-- Permanent ownership assignment remains an oversight action, even when a
-- sales manager is also one of the people who receives calling tasks.
do $$
declare definition text;
  old_gate text := 'v_role not in (''admin'',''ceo'',''coo'',''sales_manager'',''auditor'')';
begin
  select pg_get_functiondef('public.fn_assign_rrr_customers(uuid[], uuid)'::regprocedure)
    into definition;
  if position(old_gate in definition) = 0 then
    raise exception 'Customer assignment function changed; role patch requires review';
  end if;
  execute replace(definition, old_gate,
    'v_role not in (''admin'',''ceo'',''coo'',''auditor'')');
end $$;

create or replace function public.app_rrr_work_assigned(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rrr_work_items w
    where w.customer_id = cid and w.assigned_to = auth.uid()
      and w.completed_at is null
  )
$$;
revoke all on function public.app_rrr_work_assigned(uuid) from public, anon;
grant execute on function public.app_rrr_work_assigned(uuid) to authenticated;

-- An assigned rep can read precisely the customer/order/call history behind
-- the task, even when permanent ownership belongs to somebody else.
drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers for select to authenticated using (
  (select app_can_read_all())
  or current_owner_id = (select auth.uid())
  or original_owner_id = (select auth.uid())
  or ((select app_role()) = 'doctor' and app_doctor_sees_customer(id))
  or ((select app_role()) = 'ops' and app_ops_sees_customer(id))
  or ((select app_role()) = 'sales_exec' and app_ai_lead_today(id))
  or ((select app_role()) = 'sales_exec' and app_rrr_work_assigned(id))
);
-- A salesperson's old permanent ownership or automatic AI suggestion is not
-- an Alka-approved calling assignment. Restrictive policies intersect the
-- older permissive policies, including any added by other CRM modules.
create policy sales_rrr_customers_only on public.customers as restrictive
  for select to authenticated using (
    (select app_role()) not in ('sales_exec','sales_manager') or public.app_rrr_work_assigned(id));
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using (
  (select app_can_read_all())
  or current_owner_id = (select auth.uid())
  or original_owner_id = (select auth.uid())
  or ((select app_role()) = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
  or ((select app_role()) = 'sales_exec' and app_ai_lead_today(customer_id))
  or ((select app_role()) = 'sales_exec' and app_rrr_work_assigned(customer_id))
);
create policy sales_rrr_orders_only on public.orders as restrictive
  for select to authenticated using (
    (select app_role()) not in ('sales_exec','sales_manager') or exists (
      select 1 from public.rrr_work_items w where w.order_id = orders.id
        and w.assigned_to = (select auth.uid()) and w.completed_at is null));
drop policy if exists followups_read on public.followups;
create policy followups_read on public.followups for select to authenticated using (
  owner_id = (select auth.uid())
  or (select app_can_read_all())
  or ((select app_role()) = 'sales_exec' and app_ai_lead_today(customer_id))
  or ((select app_role()) = 'sales_exec' and app_rrr_work_assigned(customer_id))
);
create policy sales_rrr_followups_only on public.followups as restrictive
  for select to authenticated using (
    (select app_role()) not in ('sales_exec','sales_manager') or public.app_rrr_work_assigned(customer_id));

-- Other CRM queues and direct writes are outside the sales RRR workspace.
create policy sales_rrr_leads_only on public.leads as restrictive
  for select to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_consultations_only on public.consultations as restrictive
  for select to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_prescriptions_only on public.prescriptions as restrictive
  for select to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_ai_suggestions_only on public.ai_daily_leads as restrictive
  for select to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_order_items_only on public.order_items as restrictive
  for select to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_write_customers on public.customers as restrictive
  for update to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'))
  with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_write_orders on public.orders as restrictive
  for update to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'))
  with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_insert_followups on public.followups as restrictive
  for insert to authenticated with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_update_followups on public.followups as restrictive
  for update to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'))
  with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_delete_followups on public.followups as restrictive
  for delete to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_insert_customers on public.customers as restrictive
  for insert to authenticated with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_insert_orders on public.orders as restrictive
  for insert to authenticated with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_write_leads on public.leads as restrictive
  for all to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'))
  with check ((select app_role()) not in ('sales_exec','sales_manager'));
create policy sales_rrr_write_consultations on public.consultations as restrictive
  for all to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'))
  with check ((select app_role()) not in ('sales_exec','sales_manager'));

-- The pool view is intentionally security-definer in this app. Filter it
-- explicitly because its base-table RLS cannot protect sales users here.
create or replace view public.v_pool_leads as
select l.id, l.customer_id, c.full_name,
  public.mask_phone(c.phone_e164) as phone_masked,
  src.label_en as source, l.payment_state, l.sla_due_at, l.created_at
from public.leads l
join public.customers c on c.id = l.customer_id
join public.lead_sources src on src.id = l.source_id
where l.owner_id is null and l.is_junk = false and c.merged_into_id is null
  and public.app_role() not in ('sales_exec','sales_manager');

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
revoke all on function public.fn_assign_rrr_work(text, uuid[], uuid) from public, anon;
grant execute on function public.fn_assign_rrr_work(text, uuid[], uuid) to authenticated;

create or replace function public.fn_log_assigned_rrr_call(
  p_work_id uuid, p_outcome text, p_note text,
  p_next_due_on date, p_contact_number_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_work public.rrr_work_items%rowtype;
  v_followup uuid;
  v_attempt int;
  v_next_at timestamptz;
begin
  select * into v_work from public.rrr_work_items
    where id = p_work_id and completed_at is null for update;
  if v_work.id is null or v_work.assigned_to is distinct from auth.uid()
     or app_role() not in ('sales_exec','sales_manager') then
    raise exception 'This follow-up is not assigned to you.' using errcode = '42501';
  end if;
  if p_outcome not in ('order_placed','will_buy','medicine_not_finished',
      'will_update_later','no_answer','not_interested','wrong_number','connected','busy') then
    raise exception 'Choose a valid call outcome.' using errcode = '22023';
  end if;
  if length(coalesce(p_note,'')) > 2000 then
    raise exception 'Note is too long.' using errcode = '22023';
  end if;
  if p_next_due_on is not null and p_next_due_on < public.ist_today() then
    raise exception 'Next follow-up date cannot be in the past.' using errcode = '22023';
  end if;
  if p_contact_number_id is not null and not exists (
    select 1 from public.contact_numbers where id = p_contact_number_id and is_active
  ) then
    raise exception 'Choose an active calling number.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.orders o where o.id = v_work.order_id
                 and o.customer_id = v_work.customer_id) then
    raise exception 'The task order does not belong to this customer.' using errcode = '23514';
  end if;
  if exists (select 1 from public.customers c where c.id = v_work.customer_id
             and (c.is_dnd or c.merged_into_id is not null)) then
    raise exception 'This customer is DND or merged and cannot be called.' using errcode = '42501';
  end if;
  v_next_at := p_next_due_on::timestamp at time zone 'Asia/Kolkata';
  select f.id, f.attempt_no into v_followup, v_attempt
  from public.followups f where f.customer_id = v_work.customer_id
    and f.order_id = v_work.order_id and f.kind = 'order'
    and f.completed_at is null
  order by f.due_at, f.id limit 1 for update;
  if v_followup is not null then
    update public.followups set outcome = p_outcome, remark = nullif(trim(p_note),''),
      completed_at = now(), next_due_at = v_next_at,
      contact_number_id = p_contact_number_id, owner_id = auth.uid()
    where id = v_followup;
  else
    select coalesce(max(f.attempt_no),0) + 1 into v_attempt
      from public.followups f where f.customer_id = v_work.customer_id and f.kind = 'order';
    insert into public.followups
      (customer_id, kind, order_id, due_at, owner_id, outcome, remark,
       next_due_at, completed_at, attempt_no, contact_number_id)
    values (v_work.customer_id, 'order', v_work.order_id, now(), auth.uid(),
      p_outcome, nullif(trim(p_note),''), v_next_at, now(), v_attempt, p_contact_number_id)
    returning id into v_followup;
  end if;
  if p_next_due_on is not null then
    insert into public.followups
      (customer_id, kind, order_id, due_at, owner_id, attempt_no, contact_number_id)
    values (v_work.customer_id, 'order', v_work.order_id, v_next_at,
      auth.uid(), v_attempt + 1, p_contact_number_id);
  end if;
  update public.rrr_work_items set
    due_on = coalesce(p_next_due_on, due_on),
    last_outcome = p_outcome,
    last_called_at = now(),
    completed_at = case when p_next_due_on is null then now() else null end,
    updated_at = now()
  where id = p_work_id;
  return jsonb_build_object('scheduledNext', p_next_due_on is not null,
                            'followupId', v_followup);
end;
$$;
revoke all on function public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)
  from public, anon;
grant execute on function public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)
  to authenticated;
