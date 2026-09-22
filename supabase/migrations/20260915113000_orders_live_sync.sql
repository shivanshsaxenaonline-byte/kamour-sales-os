-- Orders get the same live behaviour as consultations: the Medicine Order
-- Record Sheet can sync every 45 seconds instead of 90, and changes to orders
-- are published so an open Orders screen redraws without a manual refresh.

do $$
declare definition text;
begin
  select pg_get_functiondef('public.claim_sheet_order_sync(text, text)'::regprocedure)
    into definition;
  if position('interval ''90 seconds''' in definition) = 0 then
    raise exception 'claim_sheet_order_sync changed; throttle patch requires review';
  end if;
  execute replace(definition, 'interval ''90 seconds''', 'interval ''45 seconds''');
end $$;

-- Postgres Changes only emits rows from tables in this publication. Keep the
-- migration safe on projects where the table was already enabled manually.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;
