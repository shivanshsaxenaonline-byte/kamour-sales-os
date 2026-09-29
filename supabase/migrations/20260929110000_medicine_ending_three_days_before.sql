-- Medicine Ending is a three-day pre-end queue, not the catch-all follow-up
-- queue. A 15-day course enters on delivery + 12; a 30-day course on delivery
-- + 27. When a customer says medicine remains, retain that stated end date and
-- let Medicine Ending pick them up three days before it.

create or replace function public.fn_log_assigned_rrr_call(
  p_work_id uuid, p_outcome text, p_note text,
  p_next_due_on date, p_contact_number_id uuid,
  p_medicine_days_left integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if p_outcome not in ('order_placed', 'will_buy', 'medicine_not_finished',
      'will_update_later', 'no_answer', 'not_interested', 'connected', 'other') then
    raise exception 'Choose a current call outcome.' using errcode = '22023';
  end if;
  if p_outcome = 'medicine_not_finished' then
    if p_medicine_days_left is null or p_medicine_days_left not between 1 and 365 then
      raise exception 'Enter 1 to 365 medicine days remaining.' using errcode = '22023';
    end if;
    if p_next_due_on is not null then
      raise exception 'Medicine Ending schedules this customer three days before the stated end date.'
        using errcode = '22023';
    end if;
  elsif p_medicine_days_left is not null then
    raise exception 'Medicine days only apply to medicine not finished.' using errcode = '22023';
  end if;
  if p_outcome = 'will_buy' and p_next_due_on is distinct from public.ist_today() + 1 then
    raise exception 'Interested customers are due the next day.' using errcode = '22023';
  end if;
  if p_outcome = 'other' then
    if nullif(trim(coalesce(p_note, '')), '') is null then
      raise exception 'Write what happened on this call.' using errcode = '22023';
    end if;
    if p_next_due_on is distinct from public.ist_today() + 1 then
      raise exception 'Other follow-ups are due the next day.' using errcode = '22023';
    end if;
  end if;
  if p_outcome = 'order_placed' then
    if nullif(trim(coalesce(p_note, '')), '') is null then
      raise exception 'Write what was ordered.' using errcode = '22023';
    end if;
    if p_next_due_on is not null then
      raise exception 'An order placed closes this task; the next call comes from the new order.'
        using errcode = '22023';
    end if;
  end if;
  if p_outcome in ('will_update_later', 'connected') and p_next_due_on is null then
    raise exception 'Ask the customer when to call again and choose a date.' using errcode = '22023';
  end if;

  -- The five-argument function remains the one atomic writer for the call,
  -- any ordinary follow-up, and the assignment state.
  v_result := public.fn_log_assigned_rrr_call(
    p_work_id, p_outcome, p_note, p_next_due_on, p_contact_number_id);
  update public.rrr_work_items
     set medicine_days_left = case when p_outcome = 'medicine_not_finished'
       then p_medicine_days_left else null end
   where id = p_work_id;
  if p_outcome = 'medicine_not_finished' then
    update public.followups
       set remark = concat_ws(' | ', nullif(trim(p_note), ''),
         format('Medicine remaining: %s days', p_medicine_days_left))
     where id = (v_result->>'followupId')::uuid;
  end if;
  return v_result;
end;
$$;

-- Old medicine-not-finished calls scheduled an open follow-up on the stated
-- end date. They now belong to the Medicine Ending calendar instead, so close
-- that obsolete reminder and release its already-called work assignment.
update public.followups f
   set completed_at = now(),
       remark = concat_ws(' | ', f.remark,
         'Superseded: Medicine Ending returns this customer three days before the stated end date')
 where f.kind = 'order'
   and f.completed_at is null
   and exists (
     select 1
       from public.followups prior
      where prior.customer_id = f.customer_id
        and prior.completed_at is not null
        and prior.outcome = 'medicine_not_finished'
        and prior.next_due_at = f.due_at
   );

update public.rrr_work_items
   set completed_at = now(), updated_at = now()
 where completed_at is null
   and last_outcome = 'medicine_not_finished';
