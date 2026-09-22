drop policy if exists followups_write on public.followups;
create policy followups_write on public.followups for all to authenticated
  using (owner_id = (select auth.uid()) or (select app_can_read_all()))
  with check (owner_id = (select auth.uid()) or (select app_can_read_all()));
