drop index if exists leads_zoho_record_id_key;
alter table leads drop column if exists zoho_record_id;
drop table if exists integration_settings;
