-- A call nobody picked comes back in three days, not the next morning.
--
-- The AI generator has treated a missed call as a one-day gap since 029: not a
-- cooldown, ring again tomorrow. In practice that spends a daily slot on
-- somebody who is simply not picking up this week — and the sheet the floor
-- worked from before the cutover left three days between attempts, which is
-- the number every imported not-picked call in the database carries.
--
-- The retry window (14 days) and the cap (3 attempts) are unchanged: at three
-- days apart, three attempts still fit inside the window with room to spare.
-- The rep's own follow-up date moves to three days in the same change, so a
-- missed call comes back on the same day whichever route brings it.
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
    '  -- A missed call is not a cooldown. One day, up to three attempts, then the', nl,
    '  -- ordinary rules take over again.', nl,
    '  v_retry_gap  int := 1;');

  if position(needle in definition) = 0 then
    raise exception 'AI generator changed; the not-picked retry gap requires review';
  end if;

  execute replace(definition, needle, concat(
    '  -- A missed call is not a cooldown, but it is not tomorrow either: three', nl,
    '  -- days, up to three attempts, then the ordinary rules take over again.', nl,
    '  v_retry_gap  int := 3;'));
end $$;
