-- Down: orders stop booking the call their course earns.
--
-- The follow-ups already booked are left where they are. Each one is a real
-- date for a real course, and deleting them would take the customer off Action
-- due with nothing put back.

drop trigger if exists trg_orders_book_next_call on public.orders;
drop function if exists public.fn_order_books_next_call();
drop function if exists public.fn_order_course_days(uuid, integer);

-- `next_followup_at` goes back to the expression it carried since 004, which
-- reads a `dispatch_date` nothing writes and is therefore null on every row.
drop view if exists public.v_orders_list;
alter table public.orders drop column next_followup_at;
alter table public.orders add column next_followup_at date
  generated always as ((dispatch_date + course_duration_days) - 4) stored;
create view public.v_orders_list with (security_invoker = true) as
 SELECT o.id, o.order_no, o.customer_id, c.full_name, c.phone_e164 AS phone,
    o.amount, o.discount, o.stage, o.payment_state, pm.label_en AS payment_mode,
    cu.label_en AS courier, o.awb, o.dispatch_date, o.course_duration_days,
    o.next_followup_at, o.is_repeat, o.current_owner_id, u.full_name AS owner_name,
    o.created_at, o.shipping_amount, o.delivered_at, ls.label_en AS source,
    o.order_notes, o.ad_code, o.gclid, o.sheet_row_number
   FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN payment_modes pm ON pm.id = o.payment_mode_id
     LEFT JOIN couriers cu ON cu.id = o.courier_id
     LEFT JOIN lead_sources ls ON ls.id = o.source_id
     LEFT JOIN users u ON u.id = o.current_owner_id
  WHERE c.merged_into_id IS NULL;
grant all on public.v_orders_list to authenticated, service_role;
revoke all on public.v_orders_list from anon;

drop function if exists public.fn_course_call_on(timestamptz, timestamptz, integer);
