-- A follow-up booked for today is a task in neither list.
--
-- The rep's own screen has two tabs and they are meant to cover everything
-- open: "Aaj ke calls" is due-and-not-yet-called, Upcoming is the rest. A task
-- dated today by the call that just ended is both called-today and due-today,
-- so it fell out of the first for having been called and out of the second for
-- not being later, and the customer was off the rep's screen until tomorrow.
--
-- The date pickers for "Baat hui", "Baad mein batayenge", "Call not picked" and
-- "Not interested" all had a floor of today, so "shaam ko ring back karunga"
-- put a task there every time it was taken literally. The screen now treats the
-- two tabs as a partition so nothing can be lost even with an old row, the
-- pickers start at tomorrow, and the date itself is refused here: the floor for
-- a next call is the next day, in every path that can write one.
--
-- Down: supabase/migrations/20260921170000_today_is_not_a_next_call.down.sql
do $$
declare
  fn         text;
  definition text;
  nl         text;
  needle     text;
begin
  foreach fn in array array[
    'public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)',
    'public.fn_log_wati_call(uuid, text, text, date, uuid, integer)'
  ] loop
    select pg_get_functiondef(fn::regprocedure) into definition;
    nl := case when position(concat(chr(13), chr(10)) in definition) > 0
               then concat(chr(13), chr(10)) else chr(10) end;
    needle := 'p_next_due_on is not null and p_next_due_on < public.ist_today() then';

    if position(needle in definition) = 0 then
      raise exception 'Call logging changed in %; the date floor requires review', fn;
    end if;

    execute replace(definition, concat(
      needle, nl,
      '    raise exception ''Next follow-up date cannot be in the past.'' using errcode = ''22023'';'),
      concat(
      'p_next_due_on is not null and p_next_due_on <= public.ist_today() then', nl,
      '    raise exception ''The next call is tomorrow at the earliest.'' using errcode = ''22023'';'));
  end loop;
end $$;
