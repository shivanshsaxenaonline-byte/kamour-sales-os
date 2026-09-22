drop function if exists fn_assign_pcr_leads(uuid[], uuid);
drop function if exists claim_pcr_sheet_sync(text, text);
drop table if exists pcr_assignment_log;
drop table if exists pcr_leads;
drop table if exists pcr_sheet_sync_state;
