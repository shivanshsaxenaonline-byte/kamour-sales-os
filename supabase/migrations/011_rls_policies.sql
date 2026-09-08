-- 011 · RLS policies — Phase 0 step 4
--
-- Enforced at the database, not the UI. A sales exec must not be able to read
-- another exec's rows even with a crafted PostgREST call. Tests in
-- scripts/test-rls.mjs prove it.
--
-- Down: supabase/migrations/011_rls_policies.down.sql

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER so that reading `users` inside a policy on `users`
-- does not recurse infinitely — the classic RLS footgun.
-- ---------------------------------------------------------------------------
create or replace function app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from users where id = auth.uid()
$$;

create or replace function app_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app_role() = 'admin', false)
$$;

-- read-only oversight roles
create or replace function app_can_read_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app_role() in ('admin','ceo','coo','sales_manager'), false)
$$;

-- a manager sees their own team; managers are not nested deeper than one level
create or replace function app_manages(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users u
    where u.id = target and u.manager_id = auth.uid()
  ) or target = auth.uid()
$$;

-- Cross-table reachability checks MUST live in SECURITY DEFINER functions.
-- Putting `exists (select 1 from consultations ...)` directly in the customers
-- policy makes Postgres evaluate the consultations policy, which itself reads
-- customers -> "infinite recursion detected in policy for relation customers".
-- A definer function bypasses RLS on the inner read and breaks the cycle.
create or replace function app_owns_customer(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from customers c
    where c.id = cid
      and (c.current_owner_id = auth.uid() or c.original_owner_id = auth.uid())
  )
$$;

create or replace function app_doctor_sees_customer(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from consultations k
    where k.customer_id = cid and k.doctor_id = auth.uid()
  )
$$;

create or replace function app_ops_sees_customer(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from orders o
    where o.customer_id = cid
      and o.stage in ('confirmed','dispatched','delivered','rto')
  )
$$;

revoke execute on function app_role(), app_is_admin(), app_can_read_all(),
  app_manages(uuid), app_owns_customer(uuid), app_doctor_sees_customer(uuid),
  app_ops_sees_customer(uuid) from anon;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create policy users_read on users for select to authenticated
  using (id = auth.uid() or app_manages(id) or app_can_read_all());

create policy users_self_update on users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = app_role());

create policy users_admin_all on users for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------------
-- customers
-- A doctor reaches a customer through a consultation assigned to them; ops
-- through an order that has left the sales floor.
-- ---------------------------------------------------------------------------
create policy customers_read on customers for select to authenticated
  using (
    app_can_read_all()
    or current_owner_id = auth.uid()
    or original_owner_id = auth.uid()
    or (app_role() = 'doctor' and app_doctor_sees_customer(id))
    or (app_role() = 'ops'    and app_ops_sees_customer(id))
  );

create policy customers_write on customers for update to authenticated
  using (current_owner_id = auth.uid() or app_can_read_all())
  with check (current_owner_id = auth.uid() or app_can_read_all());

create policy customers_insert on customers for insert to authenticated
  with check (app_role() in ('sales_exec','sales_manager','admin'));

-- ---------------------------------------------------------------------------
-- leads
-- Pool rows (owner_id is null) are deliberately NOT readable here. They are
-- exposed through v_pool_leads with the phone masked, per PROJECT.md.
-- ---------------------------------------------------------------------------
create policy leads_read on leads for select to authenticated
  using (owner_id = auth.uid() or app_can_read_all());

create policy leads_write on leads for update to authenticated
  using (owner_id = auth.uid() or app_can_read_all())
  with check (owner_id = auth.uid() or app_can_read_all());

create policy leads_insert on leads for insert to authenticated
  with check (app_role() in ('sales_exec','sales_manager','admin'));

-- ---------------------------------------------------------------------------
-- consultations / prescriptions
-- ---------------------------------------------------------------------------
create policy consultations_read on consultations for select to authenticated
  using (
    app_can_read_all()
    or doctor_id = auth.uid()
    or app_owns_customer(customer_id)
  );

create policy consultations_write on consultations for update to authenticated
  using (doctor_id = auth.uid() or app_can_read_all())
  with check (doctor_id = auth.uid() or app_can_read_all());

create policy consultations_insert on consultations for insert to authenticated
  with check (app_role() in ('sales_exec','sales_manager','doctor','admin'));

create policy prescriptions_read on prescriptions for select to authenticated
  using (
    app_can_read_all()
    or doctor_id = auth.uid()
    or app_owns_customer(customer_id)
  );

-- only a doctor writes a prescription
create policy prescriptions_write on prescriptions for all to authenticated
  using (doctor_id = auth.uid() or app_is_admin())
  with check (doctor_id = auth.uid() or app_is_admin());

create policy prescription_items_read on prescription_items for select to authenticated
  using (exists (select 1 from prescriptions p where p.id = prescription_items.prescription_id));

create policy prescription_items_write on prescription_items for all to authenticated
  using (exists (select 1 from prescriptions p
                 where p.id = prescription_items.prescription_id
                   and (p.doctor_id = auth.uid() or app_is_admin())))
  with check (exists (select 1 from prescriptions p
                 where p.id = prescription_items.prescription_id
                   and (p.doctor_id = auth.uid() or app_is_admin())));

-- ---------------------------------------------------------------------------
-- orders / order_items
-- ---------------------------------------------------------------------------
create policy orders_read on orders for select to authenticated
  using (
    app_can_read_all()
    or current_owner_id = auth.uid()
    or original_owner_id = auth.uid()
    or (app_role() = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
  );

create policy orders_write on orders for update to authenticated
  using (
    current_owner_id = auth.uid()
    or app_can_read_all()
    or (app_role() = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
  )
  with check (
    current_owner_id = auth.uid()
    or app_can_read_all()
    or app_role() = 'ops'
  );

create policy orders_insert on orders for insert to authenticated
  with check (app_role() in ('sales_exec','sales_manager','admin'));

create policy order_items_read on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_items.order_id));

create policy order_items_write on order_items for all to authenticated
  using (exists (select 1 from orders o
                 where o.id = order_items.order_id
                   and (o.current_owner_id = auth.uid() or app_can_read_all())))
  with check (exists (select 1 from orders o
                 where o.id = order_items.order_id
                   and (o.current_owner_id = auth.uid() or app_can_read_all())));

-- ---------------------------------------------------------------------------
-- followups
-- ---------------------------------------------------------------------------
create policy followups_read on followups for select to authenticated
  using (owner_id = auth.uid() or app_can_read_all());

create policy followups_write on followups for all to authenticated
  using (owner_id = auth.uid() or app_can_read_all())
  with check (owner_id = auth.uid() or app_can_read_all());

-- ---------------------------------------------------------------------------
-- operational tables
-- ---------------------------------------------------------------------------
create policy attendance_read on attendance for select to authenticated
  using (user_id = auth.uid() or app_can_read_all());
create policy attendance_manage on attendance for all to authenticated
  using (app_can_read_all()) with check (app_can_read_all());

create policy assignments_read on assignments for select to authenticated
  using (to_user_id = auth.uid() or from_user_id = auth.uid() or app_can_read_all());

create policy absence_read on absence_events for select to authenticated
  using (absent_user_id = auth.uid() or app_can_read_all());
create policy absence_manage on absence_events for all to authenticated
  using (app_can_read_all()) with check (app_can_read_all());

create policy wa_read on wa_conversations for select to authenticated
  using (app_can_read_all() or app_owns_customer(customer_id));

create policy ad_spend_read on ad_spend for select to authenticated
  using (app_can_read_all());
create policy ad_spend_write on ad_spend for all to authenticated
  using (app_role() in ('coo','ceo','admin')) with check (app_role() in ('coo','ceo','admin'));

-- audit_log is append-only from triggers; readable by oversight roles only.
create policy audit_read on audit_log for select to authenticated
  using (app_can_read_all());

-- webhook_events and import_rejects stay service_role-only: no policies.

-- ---------------------------------------------------------------------------
-- The pool, with phones masked.
--
-- SECURITY DEFINER (the default) on purpose: this view must reach rows the
-- caller's own policies deny, and it hands back only the masked phone. It is
-- the single sanctioned way to see an unassigned lead.
-- ---------------------------------------------------------------------------
create view v_pool_leads as
select
  l.id,
  l.customer_id,
  c.full_name,
  mask_phone(c.phone_e164)  as phone_masked,
  src.label_en              as source,
  l.payment_state,
  l.sla_due_at,
  l.created_at
from leads l
join customers c      on c.id = l.customer_id
join lead_sources src on src.id = l.source_id
where l.owner_id is null
  and l.is_junk = false
  and c.merged_into_id is null;

revoke all on v_pool_leads from anon;
grant select on v_pool_leads to authenticated;

comment on view v_pool_leads is
  'Unassigned leads with the phone masked. The base leads table denies these rows outright.';
