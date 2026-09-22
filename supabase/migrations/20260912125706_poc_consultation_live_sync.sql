-- POC queue: consultation records where a prescription exists but medicine
-- has not been purchased. The Sheet remains the input while Supabase provides
-- the indexed dashboard read model.

create table poc_leads (
  id                    uuid primary key default gen_random_uuid(),
  source_sheet_id       text not null,
  source_tab            text not null,
  source_row_number     int not null check (source_row_number >= 2),
  source_identity       text not null,
  record_no             text,
  payment_date          date,
  consultation_date     date,
  customer_name         text not null,
  phone_raw             text,
  phone_e164            text,
  consultation_status   text,
  doctor_name           text,
  consultation_taken_by text,
  prescription_status   text not null,
  customer_type         text,
  age                    int,
  profession             text,
  state                  text,
  concern                text,
  medicine_remark        text,
  conversion_type        text,
  amount                 text,
  payment_method         text,
  lead_source            text,
  joined_by              text,
  consultation_mode      text,
  cart_link              text,
  cart_value             text,
  medicine_purchased     text not null,
  saved_in_crm_by        text,
  medicine_nature_status text,
  followups               jsonb not null default '[]'::jsonb,
  followup_count          smallint not null default 0 check (followup_count between 0 and 5),
  last_followup_on        date,
  last_followup_summary   text,
  owner_id                uuid references users(id),
  source_snapshot         jsonb not null default '{}'::jsonb,
  is_active               boolean not null default true,
  last_synced_at          timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (source_sheet_id, source_tab, source_identity)
);

create index poc_leads_recent_idx
  on poc_leads (consultation_date desc, payment_date desc, source_row_number desc)
  where is_active;
create index poc_leads_owner_recent_idx
  on poc_leads (owner_id, consultation_date desc, source_row_number desc)
  where is_active;
create index poc_leads_phone_idx on poc_leads (phone_e164)
  where phone_e164 is not null;

create table poc_sheet_sync_state (
  sheet_id         text not null,
  tab_name         text not null,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_success_at  timestamptz,
  lock_until       timestamptz,
  rows_seen        int not null default 0,
  rows_active      int not null default 0,
  last_error       text,
  primary key (sheet_id, tab_name)
);

alter table poc_leads enable row level security;
alter table poc_leads force row level security;
alter table poc_sheet_sync_state enable row level security;
alter table poc_sheet_sync_state force row level security;

revoke all on poc_leads, poc_sheet_sync_state from anon, authenticated;
grant select on poc_leads to authenticated;
grant select, insert, update, delete on poc_leads to service_role;
grant select, insert, update on poc_sheet_sync_state to service_role;

create policy poc_leads_read on poc_leads for select to authenticated
  using (
    (select app_can_read_all())
    or owner_id = (select auth.uid())
  );

create or replace function claim_poc_sheet_sync(p_sheet_id text, p_tab_name text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into poc_sheet_sync_state (
    sheet_id, tab_name, last_started_at, lock_until, last_error
  ) values (
    p_sheet_id, p_tab_name, now(), now() + interval '5 minutes', null
  )
  on conflict (sheet_id, tab_name) do update set
    last_started_at = excluded.last_started_at,
    lock_until = excluded.lock_until,
    last_error = null
  where (
      poc_sheet_sync_state.lock_until is null
      or poc_sheet_sync_state.lock_until < now()
    ) and (
      poc_sheet_sync_state.last_success_at is null
      or poc_sheet_sync_state.last_success_at < now() - interval '60 seconds'
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;
revoke all on function claim_poc_sheet_sync(text, text) from public, anon, authenticated;
grant execute on function claim_poc_sheet_sync(text, text) to service_role;

comment on table poc_leads is
  'Live POC queue sourced from Consultation Record rows with prescription Yes and medicine purchased No.';
