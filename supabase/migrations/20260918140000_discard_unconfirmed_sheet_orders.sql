-- An order the sheet says was never confirmed is not an order.
--
-- Two marks on the Medicine Order sheet mean the same thing: the tick in
-- `Pending Status`, and a row in the `Pending Confirmation Medicine Order -
-- AP+TA+SS` tab whose Confirmation Status is Cancelled. Neither customer ever
-- took delivery, and several of them are being called today — three of the
-- seven ticked rows had already been assigned to a rep and rung.
--
-- The sync now refuses to import those rows at all, and removes the order if
-- one was created before the tick went on (which is how all seven got in: the
-- floor ticks the row after the order has already been entered). That removal
-- is this function, because it is more than one statement and half of it is
-- not covered by a cascade.
--
-- What it removes, and what it deliberately does not:
--   * the order, and with it order_items, its follow-ups and the sheet link,
--     by cascade;
--   * the RRR task pointing at the order — rrr_work_items.order_id has no
--     cascade, so a task would otherwise hold the delete open;
--   * NOT the customer. Every one of these eight has a lead or a consultation
--     from another sheet, and deleting the customer would take that with it
--     and then be recreated by the next consultation sync anyway. With no
--     orders left their `lifetime_orders` rolls to zero, and v_rrr_queue —
--     which every RRR screen reads — requires `lifetime_orders > 0`. They
--     disappear from the floor's lists without their history being destroyed.
--
-- Down: supabase/migrations/20260918140000_discard_unconfirmed_sheet_orders.down.sql

create function public.fn_discard_sheet_order(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_customer uuid;
  v_tasks    int;
  v_left     int;
begin
  select customer_id into v_customer from public.orders
    where id = p_order_id for update;
  if v_customer is null then
    return jsonb_build_object('removed', false, 'reason', 'not_found');
  end if;

  delete from public.rrr_work_items where order_id = p_order_id;
  get diagnostics v_tasks = row_count;

  delete from public.orders where id = p_order_id;

  select count(*) into v_left from public.orders where customer_id = v_customer;

  return jsonb_build_object('removed', true, 'customerId', v_customer,
                            'tasksRemoved', v_tasks, 'ordersLeft', v_left);
end;
$$;

-- Only the sync may call it: it runs with the service key, and nobody signed
-- into the app has any business deleting an order by id.
revoke all on function public.fn_discard_sheet_order(uuid) from public, anon, authenticated;
grant execute on function public.fn_discard_sheet_order(uuid) to service_role;
