-- 019 · two RLS defects found by running the app against real data
--
-- (a) PERFORMANCE. Policies called app_can_read_all() / auth.uid() directly, so
--     Postgres re-evaluated them FOR EVERY ROW. Across 51,927 leads joined to
--     51,316 customers, Aaj Ka Kaam hit the statement timeout (57014) for every
--     sales user. Wrapping each call in a scalar subquery — (select f()) —
--     makes it an InitPlan evaluated once per query. Same semantics, and the
--     difference is a timeout versus milliseconds.
--
-- (b) THE AUDITOR COULD NOT READ. Migration 013 added RESTRICTIVE policies
--     `for all using (app_can_write())` to stop an auditor writing. `for all`
--     includes SELECT, so it denied reads as well — Alka saw zero rows on a
--     read-everything role. Restrictions now target INSERT/UPDATE/DELETE only.
--
-- Down: supabase/migrations/019_rls_perf_and_auditor_read.down.sql

-- ---- (b) the auditor's write block, minus SELECT ----
drop policy if exists auditor_no_order_writes    on orders;
drop policy if exists auditor_no_customer_writes on customers;
drop policy if exists auditor_no_lead_writes     on leads;
drop policy if exists auditor_no_followup_writes on followups;

do $$
declare t text; op text;
begin
  foreach t in array array['orders','customers','leads','followups'] loop
    foreach op in array array['insert','update','delete'] loop
      execute format(
        'create policy %I on public.%I as restrictive for %s to authenticated %s',
        format('auditor_no_%s_%s', t, op), t, op,
        case when op = 'insert'
             then 'with check ((select app_can_write()))'
             else 'using ((select app_can_write()))' end);
    end loop;
  end loop;
end $$;

-- ---- (a) re-state the hot policies with InitPlan-friendly subqueries ----
drop policy if exists leads_read  on leads;
drop policy if exists leads_write on leads;
create policy leads_read on leads for select to authenticated
  using (owner_id = (select auth.uid()) or (select app_can_read_all()));
create policy leads_write on leads for update to authenticated
  using (owner_id = (select auth.uid()) or (select app_can_read_all()))
  with check (owner_id = (select auth.uid()) or (select app_can_read_all()));

drop policy if exists customers_read  on customers;
drop policy if exists customers_write on customers;
create policy customers_read on customers for select to authenticated
  using (
    (select app_can_read_all())
    or current_owner_id  = (select auth.uid())
    or original_owner_id = (select auth.uid())
    or ((select app_role()) = 'doctor' and app_doctor_sees_customer(id))
    or ((select app_role()) = 'ops'    and app_ops_sees_customer(id))
  );
create policy customers_write on customers for update to authenticated
  using (current_owner_id = (select auth.uid()) or (select app_can_read_all()))
  with check (current_owner_id = (select auth.uid()) or (select app_can_read_all()));

drop policy if exists followups_read  on followups;
drop policy if exists followups_write on followups;
create policy followups_read on followups for select to authenticated
  using (owner_id = (select auth.uid()) or (select app_can_read_all()));
create policy followups_write on followups for all to authenticated
  using (owner_id = (select auth.uid()) or (select app_can_read_all()))
  with check (owner_id = (select auth.uid()) or (select app_can_read_all()));

drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated
  using (
    (select app_can_read_all())
    or current_owner_id  = (select auth.uid())
    or original_owner_id = (select auth.uid())
    or ((select app_role()) = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
  );

-- ---- indexes matching what the queue actually filters on ----
create index if not exists leads_queue_sla_idx on leads (owner_id, sla_due_at)
  where first_contacted_at is null and is_junk = false;
create index if not exists leads_queue_open_idx on leads (owner_id, payment_state, created_at)
  where first_contacted_at is null and is_junk = false;
