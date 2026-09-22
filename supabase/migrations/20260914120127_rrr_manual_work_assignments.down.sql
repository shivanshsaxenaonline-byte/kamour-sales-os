drop function if exists public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid);
drop function if exists public.fn_assign_rrr_work(text, uuid[], uuid);
do $$
declare definition text;
  needle text := E'and not c.is_dnd\n      and not exists (select 1 from public.rrr_work_items w where w.customer_id = c.id and w.completed_at is null)';
  new_gate text := 'v_role not in (''admin'',''ceo'',''coo'',''auditor'')';
begin
  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;
  if position(needle in definition) = 0 then
    raise exception 'AI generator changed; cannot reverse assignment exclusion';
  end if;
  definition := replace(definition, needle, 'and not c.is_dnd');
  definition := replace(definition, new_gate,
    'v_role not in (''admin'',''ceo'',''coo'',''sales_manager'',''auditor'')');
  execute definition;
end $$;
do $$
declare definition text;
  new_gate text := 'v_role not in (''admin'',''ceo'',''coo'',''auditor'')';
begin
  select pg_get_functiondef('public.fn_assign_rrr_customers(uuid[], uuid)'::regprocedure)
    into definition;
  execute replace(definition, new_gate,
    'v_role not in (''admin'',''ceo'',''coo'',''sales_manager'',''auditor'')');
end $$;
drop policy if exists sales_rrr_customers_only on public.customers;
drop policy if exists sales_rrr_orders_only on public.orders;
drop policy if exists sales_rrr_followups_only on public.followups;
drop policy if exists sales_rrr_leads_only on public.leads;
drop policy if exists sales_rrr_consultations_only on public.consultations;
drop policy if exists sales_rrr_prescriptions_only on public.prescriptions;
drop policy if exists sales_rrr_ai_suggestions_only on public.ai_daily_leads;
drop policy if exists sales_rrr_order_items_only on public.order_items;
drop policy if exists sales_rrr_write_customers on public.customers;
drop policy if exists sales_rrr_write_orders on public.orders;
drop policy if exists sales_rrr_insert_followups on public.followups;
drop policy if exists sales_rrr_update_followups on public.followups;
drop policy if exists sales_rrr_delete_followups on public.followups;
drop policy if exists sales_rrr_insert_customers on public.customers;
drop policy if exists sales_rrr_insert_orders on public.orders;
drop policy if exists sales_rrr_write_leads on public.leads;
drop policy if exists sales_rrr_write_consultations on public.consultations;
create or replace view public.v_pool_leads as
select l.id, l.customer_id, c.full_name,
  public.mask_phone(c.phone_e164) as phone_masked,
  src.label_en as source, l.payment_state, l.sla_due_at, l.created_at
from public.leads l
join public.customers c on c.id = l.customer_id
join public.lead_sources src on src.id = l.source_id
where l.owner_id is null and l.is_junk = false and c.merged_into_id is null;

drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers for select to authenticated using (
  (select app_can_read_all())
  or current_owner_id = (select auth.uid())
  or original_owner_id = (select auth.uid())
  or ((select app_role()) = 'doctor' and app_doctor_sees_customer(id))
  or ((select app_role()) = 'ops' and app_ops_sees_customer(id))
  or ((select app_role()) = 'sales_exec' and app_ai_lead_today(id))
);
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using (
  (select app_can_read_all())
  or current_owner_id = (select auth.uid())
  or original_owner_id = (select auth.uid())
  or ((select app_role()) = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
  or ((select app_role()) = 'sales_exec' and app_ai_lead_today(customer_id))
);
drop policy if exists followups_read on public.followups;
create policy followups_read on public.followups for select to authenticated using (
  owner_id = (select auth.uid())
  or (select app_can_read_all())
  or ((select app_role()) = 'sales_exec' and app_ai_lead_today(customer_id))
);
drop function if exists public.app_rrr_work_assigned(uuid);
drop table if exists public.rrr_work_items;
