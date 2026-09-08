-- down 011
drop view if exists v_pool_leads;

do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public'
             and policyname not like '%\_read\_all'   -- keep the lookup grants from 008
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

drop function if exists app_ops_sees_customer(uuid);
drop function if exists app_doctor_sees_customer(uuid);
drop function if exists app_owns_customer(uuid);
drop function if exists app_manages(uuid);
drop function if exists app_can_read_all();
drop function if exists app_is_admin();
drop function if exists app_role();
