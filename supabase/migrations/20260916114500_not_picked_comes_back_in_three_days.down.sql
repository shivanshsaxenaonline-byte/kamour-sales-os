-- Back to the one-day retry gap.
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
    '  -- A missed call is not a cooldown, but it is not tomorrow either: three', nl,
    '  -- days, up to three attempts, then the ordinary rules take over again.', nl,
    '  v_retry_gap  int := 3;');

  if position(needle in definition) = 0 then
    raise exception 'AI generator does not carry the three-day retry gap';
  end if;

  execute replace(definition, needle, concat(
    '  -- A missed call is not a cooldown. One day, up to three attempts, then the', nl,
    '  -- ordinary rules take over again.', nl,
    '  v_retry_gap  int := 1;'));
end $$;
