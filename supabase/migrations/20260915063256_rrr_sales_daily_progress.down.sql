drop index if exists public.rrr_work_progress_by_rep;

drop policy if exists rrr_work_read on public.rrr_work_items;
create policy rrr_work_read on public.rrr_work_items for select to authenticated
  using (
    (assigned_to = (select auth.uid()) and completed_at is null)
    or (
      (select app_can_read_all())
      and (select app_role()) not in ('sales_exec', 'sales_manager')
    )
  );
