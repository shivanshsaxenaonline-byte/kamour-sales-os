-- Order timestamps are instants; RRR reports and AI scoring use IST calendar
-- days. The previous date fix covered delivery/follow-up timestamps but left
-- last order and ordered-on dates cast in the database's UTC session.
do $$
declare
  definition text;
  old_order_day text := $needle$c.last_order_at::date$needle$;
  new_order_day text := $needle$(c.last_order_at AT TIME ZONE 'Asia/Kolkata')::date$needle$;
  old_created_day text := $needle$o.created_at::date$needle$;
  new_created_day text := $needle$(o.created_at AT TIME ZONE 'Asia/Kolkata')::date$needle$;
begin
  select pg_get_viewdef('public.v_rrr_queue'::regclass, true) into definition;
  if position(old_order_day in definition) = 0 or position('CURRENT_DATE' in definition) = 0 then
    raise exception 'RRR queue view changed; order-day patch requires review';
  end if;
  definition := replace(definition, old_order_day, new_order_day);
  definition := replace(definition, 'CURRENT_DATE', 'public.ist_today()');
  execute 'create or replace view public.v_rrr_queue with (security_invoker=true) as ' || definition;

  select pg_get_viewdef('public.v_rrr_customer_orders'::regclass, true) into definition;
  if position(old_created_day in definition) = 0 then
    raise exception 'RRR order-history view changed; order-day patch requires review';
  end if;
  definition := replace(definition, old_created_day, new_created_day);
  execute 'create or replace view public.v_rrr_customer_orders with (security_invoker=true) as ' || definition;

  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;
  if position(old_order_day in definition) = 0 then
    raise exception 'AI generator changed; order-day patch requires review';
  end if;
  definition := replace(definition, old_order_day, new_order_day);
  execute definition;
end $$;
