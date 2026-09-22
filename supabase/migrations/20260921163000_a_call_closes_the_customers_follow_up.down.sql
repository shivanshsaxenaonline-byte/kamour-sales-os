-- Back to matching the follow-up on customer AND order, and to leaving the
-- customer's other open follow-ups alone. The rows closed by the repair above
-- stay closed: the calls that answered them are real, and re-opening them
-- would only put those customers back on Due today over courses long finished.
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef(
    'public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)'::regprocedure)
    into definition;
  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;

  needle := concat(
    '  -- One call answers one customer. Any other open repeat-order follow-up', nl,
    '  -- is about the same medicine and has just been answered by this call;', nl,
    '  -- left open it keeps them reading as due for ever.', nl,
    '  update public.followups set completed_at = now(),', nl,
    '    remark = concat_ws('' | '', remark,', nl,
    '      ''Closed by the call logged on '' || to_char(public.ist_today(), ''DD Mon YYYY''))', nl,
    '  where customer_id = v_work.customer_id and kind = ''order''', nl,
    '    and completed_at is null and id is distinct from v_followup;', nl);

  if position(needle in definition) = 0 then
    raise exception 'RRR call logging changed; the sibling close requires review';
  end if;
  execute replace(definition, needle, '');

  select pg_get_functiondef(
    'public.fn_log_assigned_rrr_call(uuid, text, text, date, uuid)'::regprocedure)
    into definition;

  needle := concat(
    '  -- The task''s own order first, then the customer''s earliest open', nl,
    '  -- follow-up. Matching on the order as well closed nothing whenever the', nl,
    '  -- task and the follow-up sat on different orders — see 20260921163000.', nl,
    '  select f.id, f.attempt_no into v_followup, v_attempt', nl,
    '  from public.followups f where f.customer_id = v_work.customer_id', nl,
    '    and f.kind = ''order''', nl,
    '    and f.completed_at is null', nl,
    '  order by (f.order_id = v_work.order_id) desc, f.due_at, f.id', nl,
    '  limit 1 for update;');

  if position(needle in definition) = 0 then
    raise exception 'RRR call logging changed; the follow-up lookup requires review';
  end if;
  execute replace(definition, needle, concat(
    '  select f.id, f.attempt_no into v_followup, v_attempt', nl,
    '  from public.followups f where f.customer_id = v_work.customer_id', nl,
    '    and f.order_id = v_work.order_id and f.kind = ''order''', nl,
    '    and f.completed_at is null', nl,
    '  order by f.due_at, f.id limit 1 for update;'));
end $$;
