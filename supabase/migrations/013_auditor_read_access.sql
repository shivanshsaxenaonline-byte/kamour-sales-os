-- 013 · give `auditor` read-everything, write-nothing
-- Down: supabase/migrations/013_auditor_read_access.down.sql

create or replace function app_can_read_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app_role() in ('admin','ceo','coo','sales_manager','auditor'), false)
$$;

-- app_can_read_all() also appears in several *write* policies (orders_write,
-- customers_write, followups_write ...). An auditor must not inherit those, so
-- writes are blocked explicitly rather than by rewriting nine policies.
create or replace function app_can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app_role() <> 'auditor', false)
$$;

create policy auditor_no_order_writes on orders as restrictive
  for all to authenticated using (app_can_write()) with check (app_can_write());
create policy auditor_no_customer_writes on customers as restrictive
  for all to authenticated using (app_can_write()) with check (app_can_write());
create policy auditor_no_lead_writes on leads as restrictive
  for all to authenticated using (app_can_write()) with check (app_can_write());
create policy auditor_no_followup_writes on followups as restrictive
  for all to authenticated using (app_can_write()) with check (app_can_write());
