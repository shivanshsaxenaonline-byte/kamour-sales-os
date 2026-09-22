-- Restores the ON CONFLICT list that carried the previous handover's call over.
-- The cleared outcomes are not restored: they were wrong on those rows.
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
  needle := concat(
    '      -- A handover is a fresh task: it is due when it was handed over,', nl,
    '      -- and it has not been called yet, whoever held it before.', nl,
    '      due_on = excluded.due_on,', nl,
    '      last_outcome = null,', nl,
    '      last_called_at = null,', nl,
    '      medicine_days_left = null,', nl,
    '      completed_at = null,', nl);

  if position(needle in definition) = 0 then
    raise exception 'RRR work assignment does not carry the handover reset';
  end if;

  execute replace(definition, needle, '');
end $$;
