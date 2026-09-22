drop view if exists v_orders_list;

create view v_orders_list with (security_invoker = true) as
select
  o.id, o.order_no, o.customer_id, c.full_name, c.phone_e164 as phone,
  o.amount, o.discount, o.stage, o.payment_state,
  pm.label_en as payment_mode, cu.label_en as courier, o.awb,
  o.dispatch_date, o.course_duration_days, o.next_followup_at, o.is_repeat,
  o.current_owner_id, u.full_name as owner_name, o.created_at
from orders o
join customers c on c.id = o.customer_id
left join payment_modes pm on pm.id = o.payment_mode_id
left join couriers cu on cu.id = o.courier_id
left join users u on u.id = o.current_owner_id
where c.merged_into_id is null;

drop function if exists save_order_workspace(uuid, timestamptz, jsonb, jsonb);
drop function if exists claim_sheet_order_sync(text, text);
drop table if exists sheet_order_links;
drop table if exists sheet_order_sync_sources;

drop policy if exists auditor_no_order_items_insert on order_items;
drop policy if exists auditor_no_order_items_update on order_items;
drop policy if exists auditor_no_order_items_delete on order_items;
drop policy if exists order_items_write on order_items;
create policy order_items_write on order_items for all to authenticated
  using (exists (
    select 1 from orders o where o.id = order_items.order_id
      and (o.current_owner_id = auth.uid() or app_can_read_all())
  ))
  with check (exists (
    select 1 from orders o where o.id = order_items.order_id
      and (o.current_owner_id = auth.uid() or app_can_read_all())
  ));

drop index if exists consultations_taken_by_id_idx;
alter table consultations drop column if exists taken_by_id;
alter table orders
  drop column if exists gclid,
  drop column if exists ad_code,
  drop column if exists order_notes;
