-- A call answers the customer, not one of their orders.
--
-- fn_log_assigned_rrr_call looked for the follow-up to close by customer AND
-- order: `f.customer_id = v_work.customer_id and f.order_id = v_work.order_id`.
-- fn_assign_rrr_work hangs an `ai` task on the customer's newest order, while
-- the open follow-up often sits on an older one — the course they were last
-- called about. When the two differ the call matched nothing, inserted its own
-- completed row, and opened a second follow-up beside the first. The original
-- never closed, and nothing could ever close it.
--
-- Eight customers are carrying one today. ANAND's is dated 26 July; Tejasv
-- marked him "not interested" on the 15th and the task is parked to 14 Nov, but
-- the July row keeps him reading as overdue on Due today, where he can be
-- assigned again. That is the second half of "I marked the outcome and he is
-- still on the dashboard": the rep's own list is right, the screens built on
-- open follow-ups are not.
--
-- Two changes:
--
--   * the lookup drops the order condition and prefers the follow-up on the
--     task's own order, falling back to the customer's earliest open one. The
--     outcome still lands on the row the task is about when there is one.
--   * whatever else the customer has open on `order` is closed with it. One
--     call answers one customer; leaving a second row open is what let the
--     pair accumulate in the first place. The next follow-up is inserted
--     afterwards, so the call still books exactly one.
--
-- Down: supabase/migrations/20260921163000_a_call_closes_the_customers_follow_up.down.sql
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef(
    'public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)'::regprocedure)
    into definition;

  -- The stored body keeps whatever line endings its migration was written with.
  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;

  needle := concat(
    '  select f.id, f.attempt_no into v_followup, v_attempt', nl,
    '  from public.followups f where f.customer_id = v_work.customer_id', nl,
    '    and f.order_id = v_work.order_id and f.kind = ''order''', nl,
    '    and f.completed_at is null', nl,
    '  order by f.due_at, f.id limit 1 for update;');

  if position(needle in definition) = 0 then
    raise exception 'RRR call logging changed; the follow-up lookup requires review';
  end if;

  execute replace(definition, needle, concat(
    '  -- The task''s own order first, then the customer''s earliest open', nl,
    '  -- follow-up. Matching on the order as well closed nothing whenever the', nl,
    '  -- task and the follow-up sat on different orders — see 20260921163000.', nl,
    '  select f.id, f.attempt_no into v_followup, v_attempt', nl,
    '  from public.followups f where f.customer_id = v_work.customer_id', nl,
    '    and f.kind = ''order''', nl,
    '    and f.completed_at is null', nl,
    '  order by (f.order_id = v_work.order_id) desc, f.due_at, f.id', nl,
    '  limit 1 for update;'));

  -- Re-read: the body just changed, and the second edit has to land on it.
  select pg_get_functiondef(
    'public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)'::regprocedure)
    into definition;

  needle := concat(
    '  if p_next_due_on is not null then', nl,
    '    insert into public.followups');

  if position(needle in definition) = 0 then
    raise exception 'RRR call logging changed; the next follow-up insert requires review';
  end if;

  -- Placed before the next follow-up is opened, or it would close that too.
  execute replace(definition, needle, concat(
    '  -- One call answers one customer. Any other open repeat-order follow-up', nl,
    '  -- is about the same medicine and has just been answered by this call;', nl,
    '  -- left open it keeps them reading as due for ever.', nl,
    '  update public.followups set completed_at = now(),', nl,
    '    remark = concat_ws('' | '', remark,', nl,
    '      ''Closed by the call logged on '' || to_char(public.ist_today(), ''DD Mon YYYY''))', nl,
    '  where customer_id = v_work.customer_id and kind = ''order''', nl,
    '    and completed_at is null and id is distinct from v_followup;', nl,
    '  if p_next_due_on is not null then', nl,
    '    insert into public.followups'));
end $$;

-- The rows the old lookup left behind: open, dated before today, on a customer
-- who has been called since. The call that answered them is in `followups`
-- already; only this row never learned. Nothing due today or later is touched,
-- so no live task can be closed by this.
update public.followups f
   set completed_at = now(),
       remark = concat_ws(' | ', f.remark,
         'Closed by 20260921163000: the customer was called after this date')
 where f.kind = 'order'
   and f.completed_at is null
   and (f.due_at at time zone 'Asia/Kolkata')::date < public.ist_today()
   and exists (
     select 1 from public.followups f2
      where f2.customer_id = f.customer_id
        and f2.completed_at is not null
        and f2.completed_at > f.due_at);
