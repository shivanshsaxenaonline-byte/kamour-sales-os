-- A daily AI assignment can point at an open order follow-up owned by somebody
-- else (or unowned). Let only today's assigned sales rep close that open row.
-- The new row must become theirs; inserts and edits outside this assignment
-- retain the existing owner/oversight rule.
drop policy if exists followups_write on public.followups;
create policy followups_write on public.followups for all to authenticated
  using (
    owner_id = (select auth.uid())
    or (select app_can_read_all())
    or (
      (select app_role()) = 'sales_exec'
      and kind = 'order'
      and completed_at is null
      and app_ai_lead_today(customer_id)
    )
  )
  with check (
    owner_id = (select auth.uid())
    or (select app_can_read_all())
  );
