-- A re-handover kept the previous handover's call on the task.
--
-- Most leads on Due today already have an open work item: the rep called
-- yesterday, said "no answer", and the follow-up came back round. When Alka
-- assigns one of those, fn_assign_rrr_work upserts onto the open row — and the
-- ON CONFLICT list moved assigned_to but left last_outcome, last_called_at and
-- due_on exactly as the previous rep left them. So the freshly handed-over task
-- arrived already wearing yesterday's call.
--
-- Two things broke on that. The Due today screen strikes a row through only
-- while a task is waiting for its call (`!!assigned_to && !task_called`), and
-- an inherited outcome made task_called true the instant it was assigned, so
-- the row never struck through — 23 of the open due tasks were in that state.
-- And the rep's own list keeps a task out of "Aaj ke calls" once it has been
-- called today or dated forward, so an inherited date could park a
-- just-assigned lead in Upcoming instead.
--
-- Handing a lead to a rep is an instruction to call it. Whatever happened on
-- the last handover is history, and history lives in `followups`, which this
-- does not touch.
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef('public.fn_assign_rrr_work(text, uuid[], uuid)'::regprocedure)
    into definition;

  -- The stored body keeps whatever line endings its migration was written with.
  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  needle := concat('      assigned_at = now(),', nl, '      updated_at = now();');

  if position(needle in definition) = 0 then
    raise exception 'RRR work assignment changed; the handover reset requires review';
  end if;

  execute replace(definition, needle, concat(
    '      assigned_at = now(),', nl,
    '      -- A handover is a fresh task: it is due when it was handed over,', nl,
    '      -- and it has not been called yet, whoever held it before.', nl,
    '      due_on = excluded.due_on,', nl,
    '      last_outcome = null,', nl,
    '      last_called_at = null,', nl,
    '      medicine_days_left = null,', nl,
    '      completed_at = null,', nl,
    '      updated_at = now();'));
end $$;

-- The tasks already sitting on a rep's list with a call that predates their
-- handover. Their due date is left alone — every one of them is already due,
-- and moving dates is the rep's business, not a migration's.
update public.rrr_work_items
   set last_outcome = null,
       last_called_at = null,
       medicine_days_left = null,
       updated_at = now()
 where completed_at is null
   and last_called_at < assigned_at
   and due_on <= public.ist_today();
