-- Down for 026_log_a_call.sql
-- The view is restored to its 025 shape (without open_followup_id /
-- last_order_id) by re-running that migration's definition.

alter table followups drop column if exists contact_number_id;
drop policy if exists contact_numbers_read on contact_numbers;
drop table if exists contact_numbers;
drop view if exists v_rrr_queue;
