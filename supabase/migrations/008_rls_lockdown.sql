-- 008 · RLS lockdown — DENY ALL by default
--
-- PROJECT.md Phase 0 puts real policies (step 4) after migrations (step 3).
-- Between those two steps the anon and authenticated keys must not be able to
-- read anything, so this migration turns RLS on everywhere and grants nothing.
-- Deny-by-default is the safe intermediate state; step 4 opens the specific
-- doors, per role, with tests.
--
-- Down: supabase/migrations/008_rls_lockdown.down.sql

do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('alter table public.%I force row level security', t.relname);
  end loop;
end $$;

-- No policies are created here on purpose. RLS enabled with zero policies
-- means every read returns zero rows for anon/authenticated, while the
-- service_role key (used by Edge Functions and the importer) bypasses RLS
-- entirely and keeps working.
--
-- WARNING for whoever inspects this DB before step 4 runs: tables will look
-- EMPTY through the API even when they hold data. That is this migration
-- working, not a failed import. `scripts/inspect-db.mjs` connects as postgres
-- and reports the truth.

-- Lookups are reference data with no tenant dimension: every signed-in user
-- may read them. Without this, no dropdown in the UI can populate.
do $$
declare t text;
begin
  foreach t in array array[
    'lead_sources','lead_statuses','concerns','couriers',
    'payment_modes','lost_reasons','cancel_reasons','products','course_plans'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read_all', t);
  end loop;
end $$;

-- Revoke the default-open grants Supabase hands to anon on new tables.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
