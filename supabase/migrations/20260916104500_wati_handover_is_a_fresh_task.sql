-- The same reset RRR got in 20260916091500, for the WATI hand-over.
--
-- fn_assign_wati_work already pulls `due_on` back to today when it upserts onto
-- an open task, but it leaves `last_outcome`, `last_called_at` and
-- `medicine_days_left` as the previous handover left them. So re-assigning a
-- WATI lead that had already been called handed the new rep a task that was
-- already wearing someone else's call — and the Interested screen reads exactly
-- that to decide whether a row is still waiting for its call.
--
-- Nothing live is in that state today (both open WATI tasks have never been
-- called), so there is no backfill here. This closes the door before it is.
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
  needle := concat('      due_on = public.ist_today(),', nl, '      updated_at = now();');

  if position(needle in definition) = 0 then
    raise exception 'WATI work assignment changed; the handover reset requires review';
  end if;

  execute replace(definition, needle, concat(
    '      due_on = public.ist_today(),', nl,
    '      -- A handover is a fresh task: whoever held it before, the call it', nl,
    '      -- is asking for has not been made yet.', nl,
    '      last_outcome = null,', nl,
    '      last_called_at = null,', nl,
    '      medicine_days_left = null,', nl,
    '      updated_at = now();'));
end $$;
