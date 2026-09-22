-- Back to resetting every re-assigned task, booked call or not. The rows this
-- migration rebuilt are left as they are: their outcome and date are what the
-- rep actually recorded, and un-rebuilding them would only re-lose it.
do $$
declare
  definition text;
  nl         text;
  needle     text;
  booked     text;
begin
  select pg_get_functiondef('public.fn_assign_rrr_work(text, uuid[], uuid)'::regprocedure)
    into definition;
  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  booked := 'rrr_work_items.last_outcome is not null'
         || ' and rrr_work_items.due_on > public.ist_today()';
  needle := concat(
    '      -- ...unless the previous rep already booked the next call. That date', nl,
    '      -- was given to the customer; a re-assignment moves who holds the task,', nl,
    '      -- not when it is owed. See 20260921160000.', nl,
    '      due_on = case when ', booked, nl,
    '                    then rrr_work_items.due_on else excluded.due_on end,', nl,
    '      last_outcome = case when ', booked, nl,
    '                    then rrr_work_items.last_outcome else null end,', nl,
    '      last_called_at = case when ', booked, nl,
    '                    then rrr_work_items.last_called_at else null end,', nl,
    '      medicine_days_left = case when ', booked, nl,
    '                    then rrr_work_items.medicine_days_left else null end,');
  if position(needle in definition) = 0 then
    raise exception 'RRR work assignment changed; the handover reset requires review';
  end if;
  execute replace(definition, needle, concat(
    '      due_on = excluded.due_on,', nl,
    '      last_outcome = null,', nl,
    '      last_called_at = null,', nl,
    '      medicine_days_left = null,'));
end $$;
