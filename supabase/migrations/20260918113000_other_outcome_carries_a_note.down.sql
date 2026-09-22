-- Down for 20260918113000_other_outcome_carries_a_note.sql
--
-- Calls already logged as 'other' cannot stay: the old constraint has no such
-- value. Their remark is the record and is left untouched, so nothing a rep
-- typed is lost — only the label goes back to null, the way any outcome the
-- floor had no word for used to look.

update followups set outcome = null where outcome = 'other';

alter table followups drop constraint if exists followups_outcome_check;

alter table followups add constraint followups_outcome_check check (
  outcome is null or outcome in (
    'connected','no_answer','busy','wrong_number','not_interested','will_buy',
    'order_placed','medicine_not_finished','will_update_later'
  )
);

comment on column followups.outcome is
  'Controlled call outcome. order_placed is the conversion signal — it means an order was actually placed on this call, not that one was promised (will_buy).';

create or replace function public.fn_log_assigned_rrr_call(
  p_work_id uuid, p_outcome text, p_note text,
  p_next_due_on date, p_contact_number_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_work public.rrr_work_items%rowtype;
  v_followup uuid;
  v_attempt int;
  v_next_at timestamptz;
begin
  select * into v_work from public.rrr_work_items
    where id = p_work_id and completed_at is null for update;
  if v_work.id is null or v_work.assigned_to is distinct from auth.uid()
     or app_role() not in ('sales_exec','sales_manager') then
    raise exception 'This follow-up is not assigned to you.' using errcode = '42501';
  end if;
  if p_outcome not in ('order_placed','will_buy','medicine_not_finished',
      'will_update_later','no_answer','not_interested','wrong_number','connected','busy') then
    raise exception 'Choose a valid call outcome.' using errcode = '22023';
  end if;
  if length(coalesce(p_note,'')) > 2000 then
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
  if not exists (select 1 from public.orders o where o.id = v_work.order_id
                 and o.customer_id = v_work.customer_id) then
    raise exception 'The task order does not belong to this customer.' using errcode = '23514';
  end if;
  if exists (select 1 from public.customers c where c.id = v_work.customer_id
             and (c.is_dnd or c.merged_into_id is not null)) then
    raise exception 'This customer is DND or merged and cannot be called.' using errcode = '42501';
  end if;
  v_next_at := p_next_due_on::timestamp at time zone 'Asia/Kolkata';
  select f.id, f.attempt_no into v_followup, v_attempt
  from public.followups f where f.customer_id = v_work.customer_id
    and f.order_id = v_work.order_id and f.kind = 'order'
    and f.completed_at is null
  order by f.due_at, f.id limit 1 for update;
  if v_followup is not null then
    update public.followups set outcome = p_outcome, remark = nullif(trim(p_note),''),
      completed_at = now(), next_due_at = v_next_at,
      contact_number_id = p_contact_number_id, owner_id = auth.uid()
    where id = v_followup;
  else
    select coalesce(max(f.attempt_no),0) + 1 into v_attempt
      from public.followups f where f.customer_id = v_work.customer_id and f.kind = 'order';
    insert into public.followups
      (customer_id, kind, order_id, due_at, owner_id, outcome, remark,
       next_due_at, completed_at, attempt_no, contact_number_id)
    values (v_work.customer_id, 'order', v_work.order_id, now(), auth.uid(),
      p_outcome, nullif(trim(p_note),''), v_next_at, now(), v_attempt, p_contact_number_id)
    returning id into v_followup;
  end if;
  if p_next_due_on is not null then
    insert into public.followups
      (customer_id, kind, order_id, due_at, owner_id, attempt_no, contact_number_id)
    values (v_work.customer_id, 'order', v_work.order_id, v_next_at,
      auth.uid(), v_attempt + 1, p_contact_number_id);
  end if;
  update public.rrr_work_items set
    due_on = coalesce(p_next_due_on, due_on),
    last_outcome = p_outcome,
    last_called_at = now(),
    completed_at = case when p_next_due_on is null then now() else null end,
    updated_at = now()
  where id = p_work_id;
  return jsonb_build_object('scheduledNext', p_next_due_on is not null,
                            'followupId', v_followup);
end;
$$;

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
      'will_update_later', 'no_answer', 'not_interested', 'connected') then
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
  if p_outcome in ('will_update_later', 'connected')
     and p_next_due_on is null then
    raise exception 'Ask the customer when to call again and choose a date.' using errcode = '22023';
  end if;

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
      'will_update_later', 'no_answer', 'not_interested', 'connected') then
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
