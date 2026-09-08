-- down 019
drop index if exists leads_queue_open_idx;
drop index if exists leads_queue_sla_idx;
do $$
declare t text; op text;
begin
  foreach t in array array['orders','customers','leads','followups'] loop
    foreach op in array array['insert','update','delete'] loop
      execute format('drop policy if exists %I on public.%I',
                     format('auditor_no_%s_%s', t, op), t);
    end loop;
  end loop;
end $$;
-- policies from 011/013 are restored by re-running those migrations
