-- Permanently remove the customer identified by this exact E.164 phone number
-- and every operational record attached to them. The guard deliberately fails
-- rather than deleting if the phone does not resolve to exactly one customer.
do $$
declare
  v_customer_id uuid;
  v_customer_count integer;
  v_order_ids uuid[];
begin
  select count(*), (array_agg(id))[1]
    into v_customer_count, v_customer_id
    from public.customers
   where phone_e164 = '+919045599283';

  if v_customer_count <> 1 then
    raise exception 'Expected exactly one customer for +919045599283, found %', v_customer_count;
  end if;

  select coalesce(array_agg(id), '{}') into v_order_ids
    from public.orders
   where customer_id = v_customer_id;

  -- These links are nullable in the schema, but "completely remove" means the
  -- customer-specific potential/work/payment records should not remain.
  delete from public.potential_leads
   where customer_id = v_customer_id
      or order_id = any(v_order_ids)
      or phone_e164 = '+919045599283';
  delete from public.wati_work_items where customer_id = v_customer_id;
  delete from public.rrr_work_items where customer_id = v_customer_id;
  delete from public.razorpay_payments
   where customer_id = v_customer_id or order_id = any(v_order_ids);

  -- Cascades remove order items, order-sheet snapshots and order follow-ups.
  delete from public.orders where customer_id = v_customer_id;
  -- Cascades remove identities, leads, consultations, prescriptions,
  -- follow-ups, AI-lead entries and WhatsApp conversations.
  delete from public.customers where id = v_customer_id;
end $$;
