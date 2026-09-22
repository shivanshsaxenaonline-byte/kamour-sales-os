-- The previous migration said `grant select`, but this project's default
-- privileges hand anon and authenticated ALL on every new table in public, so
-- both ended up with insert/update/delete as well. RLS denies them — neither
-- table has a policy for any command except select — but a grant that does not
-- match its intent is a trap for whoever reads it next, and `anon` should not
-- even appear on a table about named salespeople.
--
-- Writes reach these tables only through fn_assign_wati_work and
-- fn_log_wati_call, which are SECURITY DEFINER, so nothing loses access.
--
-- Down: supabase/migrations/20260916071500_wati_work_grants.down.sql

revoke all on public.wati_work_items from anon;
revoke all on public.wati_work_calls from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.wati_work_items from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.wati_work_calls from authenticated;
