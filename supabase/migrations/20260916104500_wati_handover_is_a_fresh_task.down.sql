-- Restores the ON CONFLICT list that carried the previous handover's call over.
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef('public.fn_assign_wati_work(text, jsonb)'::regprocedure)
    into definition;

  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  needle := concat(
    '      -- A handover is a fresh task: whoever held it before, the call it', nl,
    '      -- is asking for has not been made yet.', nl,
    '      last_outcome = null,', nl,
    '      last_called_at = null,', nl,
    '      medicine_days_left = null,', nl);

  if position(needle in definition) = 0 then
    raise exception 'WATI work assignment does not carry the handover reset';
  end if;

  execute replace(definition, needle, '');
end $$;
