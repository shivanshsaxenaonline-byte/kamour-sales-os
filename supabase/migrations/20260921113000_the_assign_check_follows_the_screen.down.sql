-- Put the 15/30-day course condition back on the medicine_ending branch.
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef('public.fn_assign_rrr_work(text, uuid[], uuid)'::regprocedure)
    into definition;

  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  needle := '      where o.id = v_id and o.stage = ''delivered'' and o.delivered_at is not null;';

  if position(needle in definition) = 0 then
    raise exception 'RRR work assignment changed; the eligibility rollback requires review';
  end if;

  execute replace(definition, needle, concat(
    '      where o.id = v_id and o.stage = ''delivered'' and o.delivered_at is not null', nl,
    '        and o.course_duration_days in (15,30);'));
end $$;
