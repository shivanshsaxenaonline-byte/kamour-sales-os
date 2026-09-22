-- The assign check has to accept what the Medicine Ending screen shows.
--
-- 20260921103000 moved that screen off orders.course_duration_days: the course
-- length now comes from the tablets in the parcel first, so the screen lists
-- every delivered order and works the length out per row. Its old server-side
-- filter, .in('course_duration_days', [15, 30]), was dropped with it.
--
-- fn_assign_rrr_work still carried the same condition in its medicine_ending
-- branch, so a row the screen was now willing to show could be refused with
-- "Selected lead is no longer eligible." on assign. One of the 157 delivered
-- orders is in that state today — small, and a dead button on a screen the
-- floor assigns from every morning is not a defect worth leaving for later.
--
-- The narrower checks stay: delivered, with a delivery date. Those are what
-- make an order a course somebody is actually taking.
--
-- Down: supabase/migrations/20260921113000_the_assign_check_follows_the_screen.down.sql
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
  needle := concat(
    '      where o.id = v_id and o.stage = ''delivered'' and o.delivered_at is not null', nl,
    '        and o.course_duration_days in (15,30);');

  if position(needle in definition) = 0 then
    raise exception 'RRR work assignment changed; the eligibility check requires review';
  end if;

  execute replace(definition, needle, concat(
    '      where o.id = v_id and o.stage = ''delivered'' and o.delivered_at is not null;'));
end $$;

comment on function fn_assign_rrr_work(text, uuid[], uuid) is
  'Hand RRR calling work to a salesperson, or withdraw it when p_owner_id is null. A handover is a fresh task: it is due the day it was handed over and carries no earlier call. Medicine Ending passes order ids and accepts any delivered order, which is what that screen lists; AI Leads and Due today pass customer ids. Never changes permanent customer ownership.';
