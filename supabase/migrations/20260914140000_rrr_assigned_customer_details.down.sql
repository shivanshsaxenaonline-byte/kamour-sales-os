drop policy if exists sales_rrr_orders_only on public.orders;
create policy sales_rrr_orders_only on public.orders as restrictive
  for select to authenticated using (
    (select app_role()) not in ('sales_exec','sales_manager') or exists (
      select 1 from public.rrr_work_items w where w.order_id = orders.id
        and w.assigned_to = (select auth.uid()) and w.completed_at is null));

drop policy if exists sales_rrr_order_items_only on public.order_items;
create policy sales_rrr_order_items_only on public.order_items as restrictive
  for select to authenticated using ((select app_role()) not in ('sales_exec','sales_manager'));

create or replace view public.v_rrr_customer_followups with (security_invoker = true) as
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

drop function if exists public.app_user_display_name(uuid);
