-- A call the customer has already been promised is not stale state.
--
-- 20260916091500 made a handover a fresh task: assigning a lead resets due_on,
-- last_outcome, last_called_at and medicine_days_left, because "handing a lead
-- to a rep is an instruction to call it" and an inherited outcome made the Due
-- today screen read a just-assigned task as already worked. That is right for
-- the case it was written for — a task sitting at its due date, waiting.
--
-- It is wrong for a task the rep has already answered. Tejasv rang Shrikant on
-- 16 Sep, was told the medicine runs to the 25th, and the call booked the 25th.
-- Medicine Ending suppresses a customer for two days, so on the 18th Shrikant
-- was back on that screen, was assigned in the morning's batch, and the reset
-- pulled him to due-today with the outcome erased. The rep's own list then
-- showed him in "Aaj ke calls" reading "Not called yet" — the call he had made
-- two days earlier gone from the row, about a course with a week still to run.
-- Six tasks are in that state today; three of them are Tejasv's, which is the
-- complaint that started this.
--
-- So the reset keeps its job and learns one exception: a task whose rep has
-- already logged an outcome and booked a date still ahead keeps that date and
-- that outcome. It can change hands — source, order and owner all move — but
-- the promise made to the customer is not a handover's to withdraw. A task due
-- today or overdue resets exactly as before.
--
-- Down: supabase/migrations/20260921160000_a_call_already_booked_is_not_a_fresh_task.down.sql
do $$
declare
  definition text;
  nl         text;
  needle     text;
  booked     text;
begin
  select pg_get_functiondef('public.fn_assign_rrr_work(text, uuid[], uuid)'::regprocedure)
    into definition;

  -- The stored body keeps whatever line endings its migration was written with.
  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  needle := concat(
    '      due_on = excluded.due_on,', nl,
    '      last_outcome = null,', nl,
    '      last_called_at = null,', nl,
    '      medicine_days_left = null,');

  if position(needle in definition) = 0 then
    raise exception 'RRR work assignment changed; the handover reset requires review';
  end if;

  -- The existing row, not the one being inserted: rrr_work_items.* is what the
  -- previous rep left behind.
  booked := 'rrr_work_items.last_outcome is not null'
         || ' and rrr_work_items.due_on > public.ist_today()';

  execute replace(definition, needle, concat(
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
    '                    then rrr_work_items.medicine_days_left else null end,'));
end $$;

-- The six tasks the reset has already emptied. Their call is still in
-- `followups` — it always was, which is why the history survived the wipe —
-- so the row is rebuilt from the last completed call that booked a date still
-- ahead of today. medicine_days_left comes back out of the remark the call
-- wrote it into ("… | Medicine remaining: 9 days").
with last_call as (
  select distinct on (f.customer_id)
         f.customer_id, f.outcome, f.completed_at, f.next_due_at, f.remark
    from public.followups f
   where f.completed_at is not null and f.next_due_at is not null
   order by f.customer_id, f.completed_at desc
)
update public.rrr_work_items w
   set last_outcome   = lc.outcome,
       last_called_at = lc.completed_at,
       due_on         = (lc.next_due_at at time zone 'Asia/Kolkata')::date,
       medicine_days_left = case when lc.outcome = 'medicine_not_finished'
         then substring(lc.remark from 'Medicine remaining: ([0-9]+) days')::int end,
       updated_at     = now()
  from last_call lc
 where lc.customer_id = w.customer_id
   and w.completed_at is null
   and w.last_outcome is null          -- only the rows the reset emptied
   and lc.completed_at < w.assigned_at -- the call came before the handover
   and (lc.next_due_at at time zone 'Asia/Kolkata')::date > public.ist_today();
