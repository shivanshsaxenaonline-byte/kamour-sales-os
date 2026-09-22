-- A rep calling an assigned customer needs the whole picture behind that
-- customer — every past order, what was in it, and who called before — not
-- only the single order the task was raised on. Access still ends the moment
-- the task is completed or reassigned (app_rrr_work_assigned).
--
-- Down: supabase/migrations/20260914140000_rrr_assigned_customer_details.down.sql

drop policy if exists sales_rrr_orders_only on public.orders;
create policy sales_rrr_orders_only on public.orders as restrictive
  for select to authenticated using (
    (select app_role()) not in ('sales_exec','sales_manager')
    or public.app_rrr_work_assigned(customer_id));

drop policy if exists sales_rrr_order_items_only on public.order_items;
create policy sales_rrr_order_items_only on public.order_items as restrictive
  for select to authenticated using (
    (select app_role()) not in ('sales_exec','sales_manager')
    or exists (select 1 from public.orders o
               where o.id = order_items.order_id
                 and public.app_rrr_work_assigned(o.customer_id)));

-- Reps cannot read other users' rows, so "who made this call" came back blank
-- in the history. Expose only the display name, and only through this view.
create or replace function public.app_user_display_name(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select full_name from public.users where id = uid
$$;
revoke all on function public.app_user_display_name(uuid) from public, anon;
grant execute on function public.app_user_display_name(uuid) to authenticated;

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
  public.app_user_display_name(f.owner_id)        as by_name,
  cn.label_en                                     as called_from
from followups f
left join contact_numbers cn on cn.id = f.contact_number_id;
