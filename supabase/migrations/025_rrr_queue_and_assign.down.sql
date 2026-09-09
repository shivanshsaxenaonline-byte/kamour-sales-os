-- Down for 025_rrr_queue_and_assign.sql

drop function if exists fn_assign_rrr_customers(uuid[], uuid);
drop view if exists v_rrr_queue;
