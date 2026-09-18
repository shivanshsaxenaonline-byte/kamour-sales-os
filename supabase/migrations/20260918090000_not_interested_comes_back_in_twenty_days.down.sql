-- Back to the ninety-day rejection freeze.
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;

  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  needle := concat(
    '  -- A "no" is worth respecting for twenty days, not for a quarter: it is', nl,
    '  -- usually "not this week", and the next course runs out long before a', nl,
    '  -- quarter is up.', nl,
    '  v_reject   int := 20;');

  if position(needle in definition) = 0 then
    raise exception 'AI generator does not carry the twenty-day rejection freeze';
  end if;

  execute replace(definition, needle, concat(
    '  -- A "no" is worth respecting for a quarter, not for a week.', nl,
    '  v_reject   int := 90;'));
end $$;
