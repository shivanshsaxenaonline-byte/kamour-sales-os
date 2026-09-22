-- Back to accepting today as a next-call date. The screen's two tabs are a
-- partition either way, so a task dated today is still reachable; it simply
-- shows up under Upcoming again, as "Called today".
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
    needle := 'p_next_due_on is not null and p_next_due_on <= public.ist_today() then';

    if position(needle in definition) = 0 then
      raise exception 'Call logging changed in %; the date floor requires review', fn;
    end if;

    execute replace(definition, concat(
      needle, nl,
      '    raise exception ''The next call is tomorrow at the earliest.'' using errcode = ''22023'';'),
      concat(
      'p_next_due_on is not null and p_next_due_on < public.ist_today() then', nl,
      '    raise exception ''Next follow-up date cannot be in the past.'' using errcode = ''22023'';'));
  end loop;
end $$;
