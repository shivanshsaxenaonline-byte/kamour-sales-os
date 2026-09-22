grant execute on function public.fn_log_assigned_rrr_call(uuid,text,text,date,uuid)
  to authenticated;
drop function if exists public.fn_log_assigned_rrr_call(uuid,text,text,date,uuid,integer);
alter table public.rrr_work_items drop column if exists medicine_days_left;
