do $$
declare definition text;
begin
  select pg_get_functiondef('public.claim_sheet_order_sync(text, text)'::regprocedure)
    into definition;
  execute replace(definition, 'interval ''45 seconds''', 'interval ''90 seconds''');
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
  ) then
    alter publication supabase_realtime drop table public.orders;
  end if;
end $$;
