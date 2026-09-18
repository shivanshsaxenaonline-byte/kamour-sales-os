-- "Not interested" freezes a customer for twenty days, not for a quarter.
--
-- Two numbers said "no" on this floor, and they disagreed. The rep's dialog
-- scheduled the next follow-up sixty days out; the AI generator refused to
-- deal the customer again for ninety. So a "no" cost a customer between two
-- and three months, depending on which route would have brought them back.
--
-- Twenty days is what the floor asked for, because a "no" on the phone is
-- usually "not this week" — the course is not finished, or the money is not
-- there this month. Sixty days put them back on a list long after the next
-- order was due; ninety put them back after the one following that. The
-- dialog's sixty moves to twenty in the same change, so a rejected customer
-- returns on the same day whichever route brings them.
--
-- The generator still scores them the ordinary way when they come back: an
-- open follow-up that has fallen due is worth +20, so day 20 is when they
-- reappear, not a promise they will be dealt that morning.
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
    '  -- A "no" is worth respecting for a quarter, not for a week.', nl,
    '  v_reject   int := 90;');

  if position(needle in definition) = 0 then
    raise exception 'AI generator changed; the rejection freeze requires review';
  end if;

  execute replace(definition, needle, concat(
    '  -- A "no" is worth respecting for twenty days, not for a quarter: it is', nl,
    '  -- usually "not this week", and the next course runs out long before a', nl,
    '  -- quarter is up.', nl,
    '  v_reject   int := 20;'));
end $$;
