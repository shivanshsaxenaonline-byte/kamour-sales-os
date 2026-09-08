-- down 006
drop trigger if exists trg_audit_leads on leads;
drop trigger if exists trg_audit_customers on customers;
drop trigger if exists trg_audit_orders on orders;
drop function if exists fn_audit_row();
drop table if exists import_rejects;
drop table if exists webhook_events;
drop table if exists audit_log;
drop table if exists ad_spend;
drop table if exists wa_conversations;
drop table if exists assignments;
drop table if exists absence_events;
drop table if exists attendance;
