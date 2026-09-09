-- Down for 027_rrr_customer_history.sql
-- Leaves v_rrr_queue dropped; re-running 026 restores its previous shape.

drop view if exists v_rrr_customer_followups;
drop view if exists v_rrr_customer_orders;
drop view if exists v_rrr_queue;
