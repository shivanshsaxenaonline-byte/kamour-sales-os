-- down 013
drop policy if exists auditor_no_followup_writes on followups;
drop policy if exists auditor_no_lead_writes on leads;
drop policy if exists auditor_no_customer_writes on customers;
drop policy if exists auditor_no_order_writes on orders;
drop function if exists app_can_write();
create or replace function app_can_read_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app_role() in ('admin','ceo','coo','sales_manager'), false)
$$;
