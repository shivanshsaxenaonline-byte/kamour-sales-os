-- down 008 · lift the lockdown
-- WARNING: this leaves every table world-readable through the API. Only ever
-- run it as part of a full teardown, never on a database holding real data.
do $$
declare t text;
begin
  foreach t in array array[
    'lead_sources','lead_statuses','concerns','couriers',
    'payment_modes','lost_reasons','cancel_reasons','products','course_plans'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_read_all', t);
  end loop;
end $$;

do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I no force row level security', t.relname);
    execute format('alter table public.%I disable row level security', t.relname);
  end loop;
end $$;
