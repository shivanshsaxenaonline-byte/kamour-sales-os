alter table public.leads
  add column if not exists zoho_connection_status text,
  add column if not exists zoho_lead_insight text,
  add column if not exists zoho_contacted_person text;
