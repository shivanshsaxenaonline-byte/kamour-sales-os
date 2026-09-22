-- Restores the two-source assign function from 20260915090000. Due tasks must
-- be removed first or the constraint cannot be restored.
delete from public.rrr_work_items where source = 'due';
alter table public.rrr_work_items drop constraint rrr_work_items_source_check;
alter table public.rrr_work_items add constraint rrr_work_items_source_check
  check (source in ('ai', 'medicine_ending'));
