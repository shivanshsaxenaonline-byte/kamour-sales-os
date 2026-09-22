-- The floor records the customer's stated remaining medicine days. New calls
-- use a narrow RPC contract; historical outcomes remain readable unchanged.
alter table public.rrr_work_items
  add column medicine_days_left integer
  check (medicine_days_left between 1 and 365);

create function public.fn_log_assigned_rrr_call(
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

  -- The existing five-argument function still enforces assignment, DND,
  -- contact number, and atomic follow-up creation. Direct execution is revoked
  -- below, so callers cannot bypass these new outcome checks.
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
revoke all on function public.fn_log_assigned_rrr_call(uuid,text,text,date,uuid,integer)
  from public, anon;
grant execute on function public.fn_log_assigned_rrr_call(uuid,text,text,date,uuid,integer)
  to authenticated;
revoke execute on function public.fn_log_assigned_rrr_call(uuid,text,text,date,uuid)
  from authenticated;
