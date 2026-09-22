drop view v_orders_list;

create view v_orders_list with (security_invoker = true) as
select
  o.id,
  o.order_no,
  o.customer_id,
  c.full_name,
  c.phone_e164 as phone,
  o.amount,
  o.discount,
  o.stage,
  o.payment_state,
  pm.label_en as payment_mode,
  cu.label_en as courier,
  o.awb,
  o.dispatch_date,
  o.course_duration_days,
  o.next_followup_at,
  o.is_repeat,
  o.current_owner_id,
  u.full_name as owner_name,
  o.created_at,
  o.shipping_amount,
  o.delivered_at,
  ls.label_en as source,
  o.order_notes,
  o.ad_code,
  o.gclid
from orders o
join customers c on c.id = o.customer_id
left join payment_modes pm on pm.id = o.payment_mode_id
left join couriers cu on cu.id = o.courier_id
left join lead_sources ls on ls.id = o.source_id
left join users u on u.id = o.current_owner_id
where c.merged_into_id is null;

alter table orders drop column sheet_row_number;
