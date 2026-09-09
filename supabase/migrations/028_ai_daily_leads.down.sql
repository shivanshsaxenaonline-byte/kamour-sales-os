-- Down for 028 · AI daily leads
--
-- The three policies widened here are put back exactly as migration 019 left
-- them, not merely dropped — dropping customers_read would deny every read.

select cron.unschedule('generate-ai-daily-leads');

drop view if exists v_rrr_ai_leads;

drop policy if exists followups_read on followups;
create policy followups_read on followups for select to authenticated
  using (owner_id = (select auth.uid()) or (select app_can_read_all()));

drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated
  using (
    (select app_can_read_all())
    or current_owner_id  = (select auth.uid())
    or original_owner_id = (select auth.uid())
    or ((select app_role()) = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
  );

drop policy if exists customers_read on customers;
create policy customers_read on customers for select to authenticated
  using (
    (select app_can_read_all())
    or current_owner_id  = (select auth.uid())
    or original_owner_id = (select auth.uid())
    or ((select app_role()) = 'doctor' and app_doctor_sees_customer(id))
    or ((select app_role()) = 'ops'    and app_ops_sees_customer(id))
  );

drop function if exists fn_generate_ai_daily_leads(date, boolean);
drop function if exists app_ai_lead_today(uuid);

drop table if exists ai_daily_leads;
drop table if exists ai_lead_runs;
drop table if exists ai_lead_rules;

-- ist_today() is left in place: it is a general-purpose helper with no state,
-- and dropping it would break anything added later that leans on it.
