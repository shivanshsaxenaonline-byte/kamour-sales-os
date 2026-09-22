-- Salespeople can already read their own open RRR tasks. Keep today's tasks
-- readable after a terminal outcome closes them so the shared header can show
-- an accurate daily completed/left progress count. Older completed work stays
-- hidden; oversight roles retain their existing read access.
drop policy if exists rrr_work_read on public.rrr_work_items;
create policy rrr_work_read on public.rrr_work_items for select to authenticated
  using (
    (
      assigned_to = (select auth.uid())
      and (
        completed_at is null
        or (
          last_called_at is not null
          and (last_called_at at time zone 'Asia/Kolkata')::date = public.ist_today()
        )
      )
    )
    or (
      (select app_can_read_all())
      and (select app_role()) not in ('sales_exec', 'sales_manager')
    )
  );

create index if not exists rrr_work_progress_by_rep
  on public.rrr_work_items (assigned_to, last_called_at desc)
  where last_called_at is not null;
