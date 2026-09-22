-- Down: the Log-call dialog stops offering "Order placed".
--
-- Both logging functions go back to the 20260918113000 contract, which refuses
-- the outcome, and the helper that clears a buyer's unworked tasks is dropped.
-- Calls already logged as `order_placed` keep their rows: the outcome has been
-- valid in `followups` since 024 and every screen still reads it.

-- The outcome contract the Log-call dialog posts against.
create or replace function public.fn_log_assigned_rrr_call(
  p_work_id uuid, p_outcome text, p_note text,
  p_next_due_on date, p_contact_number_id uuid,
  p_medicine_days_left integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if p_outcome not in ('will_buy', 'medicine_not_finished',
      'will_update_later', 'no_answer', 'not_interested', 'connected', 'other') then
    raise exception 'Choose a current call outcome.' using errcode = '22023';
  end if;
  if p_outcome = 'medicine_not_finished' then
    if p_medicine_days_left is null or p_medicine_days_left not between 1 and 365 then
      raise exception 'Enter 1 to 365 medicine days remaining.' using errcode = '22023';
    end if;
    if p_next_due_on is distinct from public.ist_today() + p_medicine_days_left then
      raise exception 'Next call must be when the remaining medicine runs out.' using errcode = '22023';
    end if;
  else
    if p_medicine_days_left is not null then
      raise exception 'Medicine days only apply to medicine not finished.' using errcode = '22023';
    end if;
  end if;
  if p_outcome = 'will_buy'
     and p_next_due_on is distinct from public.ist_today() + 1 then
    raise exception 'Interested customers are due the next day.' using errcode = '22023';
  end if;
  -- "Other" says nothing on its own: the note is the outcome, and tomorrow is
  -- when somebody reads it.
  if p_outcome = 'other' then
    if nullif(trim(coalesce(p_note, '')), '') is null then
      raise exception 'Write what happened on this call.' using errcode = '22023';
    end if;
    if p_next_due_on is distinct from public.ist_today() + 1 then
      raise exception 'Other follow-ups are due the next day.' using errcode = '22023';
    end if;
  end if;
  if p_outcome in ('will_update_later', 'connected')
     and p_next_due_on is null then
    raise exception 'Ask the customer when to call again and choose a date.' using errcode = '22023';
  end if;

  -- The existing five-argument function still enforces assignment, DND,
  -- contact number, and atomic follow-up creation. Direct execution is revoked,
  -- so callers cannot bypass these outcome checks.
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

-- The same contract for a WATI Interested hand-over, so the one dialog still
-- behaves identically whichever list the task came from.
create or replace function public.fn_log_wati_call(
  p_work_id uuid, p_outcome text, p_note text,
  p_next_due_on date, p_contact_number_id uuid, p_medicine_days_left integer
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_work public.wati_work_items%rowtype;
  v_attempt int;
begin
  if p_outcome not in ('will_buy', 'medicine_not_finished',
      'will_update_later', 'no_answer', 'not_interested', 'connected', 'other') then
    raise exception 'Choose a current call outcome.' using errcode = '22023';
  end if;
  if p_outcome = 'medicine_not_finished' then
    if p_medicine_days_left is null or p_medicine_days_left not between 1 and 365 then
      raise exception 'Enter 1 to 365 medicine days remaining.' using errcode = '22023';
    end if;
    if p_next_due_on is distinct from public.ist_today() + p_medicine_days_left then
      raise exception 'Next call must be when the remaining medicine runs out.'
        using errcode = '22023';
    end if;
  elsif p_medicine_days_left is not null then
    raise exception 'Medicine days only apply to medicine not finished.'
      using errcode = '22023';
  end if;
  if p_outcome = 'will_buy'
     and p_next_due_on is distinct from public.ist_today() + 1 then
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
  if p_outcome in ('will_update_later', 'connected') and p_next_due_on is null then
    raise exception 'Ask the customer when to call again and choose a date.'
      using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 2000 then
    raise exception 'Note is too long.' using errcode = '22023';
  end if;
  if p_next_due_on is not null and p_next_due_on < public.ist_today() then
    raise exception 'Next follow-up date cannot be in the past.' using errcode = '22023';
  end if;
  if p_contact_number_id is not null and not exists (
    select 1 from public.contact_numbers where id = p_contact_number_id and is_active
  ) then
    raise exception 'Choose an active calling number.' using errcode = '22023';
  end if;

  select * into v_work from public.wati_work_items
    where id = p_work_id and completed_at is null for update;
  if v_work.id is null or v_work.assigned_to is distinct from auth.uid()
     or app_role() not in ('sales_exec','sales_manager') then
    raise exception 'This WATI lead is not assigned to you.' using errcode = '42501';
  end if;
  -- An interested chat can turn out to be someone who already asked not to be
  -- called. The golden record is the one that knows.
  if v_work.customer_id is not null and exists (
    select 1 from public.customers c where c.id = v_work.customer_id and c.is_dnd
  ) then
    raise exception 'This customer is DND and cannot be called.' using errcode = '42501';
  end if;

  select coalesce(max(c.attempt_no), 0) + 1 into v_attempt
    from public.wati_work_calls c where c.work_id = p_work_id;
  insert into public.wati_work_calls
    (work_id, owner_id, outcome, note, next_due_on, contact_number_id, attempt_no)
  values (p_work_id, auth.uid(), p_outcome,
    case when p_outcome = 'medicine_not_finished'
      then concat_ws(' | ', nullif(trim(p_note), ''),
        format('Medicine remaining: %s days', p_medicine_days_left))
      else nullif(trim(p_note), '') end,
    p_next_due_on, p_contact_number_id, v_attempt);

  update public.wati_work_items set
    due_on = coalesce(p_next_due_on, due_on),
    last_outcome = p_outcome,
    last_called_at = now(),
    medicine_days_left = case when p_outcome = 'medicine_not_finished'
      then p_medicine_days_left else null end,
    completed_at = case when p_next_due_on is null then now() else null end,
    updated_at = now()
  where id = p_work_id;

  return jsonb_build_object('scheduledNext', p_next_due_on is not null,
                            'attemptNo', v_attempt);
end;
$fn$;

drop function if exists public.fn_drop_unworked_tasks(uuid);
