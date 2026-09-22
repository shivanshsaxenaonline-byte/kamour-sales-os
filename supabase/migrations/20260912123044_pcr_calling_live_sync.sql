-- Live PCR Calling sheet mirror. Sheet-owned fields are refreshed by the
-- service role; dashboard ownership is intentionally kept in separate columns.

create table pcr_leads (
  id                    uuid primary key default gen_random_uuid(),
  source_sheet_id       text not null,
  source_tab            text not null,
  source_row_number     int not null check (source_row_number >= 2),
  source_identity       text not null,
  booking_date          date,
  customer_name         text not null,
  phone_raw             text,
  phone_e164            text,
  followups             jsonb not null default '[]'::jsonb,
  followup_count        smallint not null default 0 check (followup_count between 0 and 5),
  last_followup_on      date,
  last_followup_summary text,
  next_followup_on      date,
  next_followup_attempt smallint check (next_followup_attempt between 1 and 5),
  priority_rank         smallint not null default 2 check (priority_rank between 0 and 4),
  text_message_date     text,
  text_message_status   text,
  converted             boolean not null default false,
  is_active             boolean not null default true,
  source_snapshot       jsonb not null default '{}'::jsonb,
  owner_id              uuid references users(id),
  assigned_by           uuid references users(id),
  assigned_at           timestamptz,
  last_synced_at        timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (source_sheet_id, source_tab, source_identity)
);

create index pcr_leads_queue_idx
  on pcr_leads (priority_rank, booking_date desc, source_row_number desc)
  where is_active;
create index pcr_leads_owner_queue_idx
  on pcr_leads (owner_id, priority_rank, booking_date desc)
  where is_active;
create index pcr_leads_phone_idx on pcr_leads (phone_e164)
  where phone_e164 is not null;

create table pcr_assignment_log (
  id          bigint generated always as identity primary key,
  lead_id     uuid not null references pcr_leads(id) on delete cascade,
  from_owner  uuid references users(id),
  to_owner    uuid references users(id),
  changed_by  uuid not null references users(id),
  changed_at  timestamptz not null default now()
);
create index pcr_assignment_log_lead_idx
  on pcr_assignment_log (lead_id, changed_at desc);

create table pcr_sheet_sync_state (
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

alter table pcr_leads enable row level security;
alter table pcr_leads force row level security;
alter table pcr_assignment_log enable row level security;
alter table pcr_assignment_log force row level security;
alter table pcr_sheet_sync_state enable row level security;
alter table pcr_sheet_sync_state force row level security;

revoke all on pcr_leads, pcr_assignment_log, pcr_sheet_sync_state from anon, authenticated;
grant select on pcr_leads to authenticated;
grant select, insert, update, delete on pcr_leads to service_role;
grant select, insert on pcr_assignment_log to service_role;
grant select, insert, update on pcr_sheet_sync_state to service_role;
grant usage, select on sequence pcr_assignment_log_id_seq to service_role;

create policy pcr_leads_read on pcr_leads for select to authenticated
  using (
    (select app_can_read_all())
    or owner_id = (select auth.uid())
  );

create or replace function claim_pcr_sheet_sync(p_sheet_id text, p_tab_name text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into pcr_sheet_sync_state (
    sheet_id, tab_name, last_started_at, lock_until, last_error
  ) values (
    p_sheet_id, p_tab_name, now(), now() + interval '5 minutes', null
  )
  on conflict (sheet_id, tab_name) do update set
    last_started_at = excluded.last_started_at,
    lock_until = excluded.lock_until,
    last_error = null
  where (
      pcr_sheet_sync_state.lock_until is null
      or pcr_sheet_sync_state.lock_until < now()
    ) and (
      pcr_sheet_sync_state.last_success_at is null
      or pcr_sheet_sync_state.last_success_at < now() - interval '60 seconds'
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;
revoke all on function claim_pcr_sheet_sync(text, text) from public, anon, authenticated;
grant execute on function claim_pcr_sheet_sync(text, text) to service_role;

create or replace function fn_assign_pcr_leads(p_lead_ids uuid[], p_owner_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role user_role := app_role();
  v_owner_role user_role;
  v_owner_active boolean;
  v_count int := 0;
begin
  if v_actor_role is null or v_actor_role not in ('admin','ceo','coo','sales_manager','auditor') then
    raise exception 'Not permitted to assign PCR leads.' using errcode = '42501';
  end if;

  if p_lead_ids is null or array_length(p_lead_ids, 1) is null then
    return 0;
  end if;
  if array_length(p_lead_ids, 1) > 100 then
    raise exception 'Assign at most 100 PCR leads at a time.' using errcode = '22023';
  end if;

  select role, is_active into v_owner_role, v_owner_active
  from users where id = p_owner_id;
  if v_owner_role is null or not coalesce(v_owner_active, false) then
    raise exception 'Choose an active salesperson.' using errcode = '22023';
  end if;
  if v_owner_role not in ('sales_exec','sales_manager') then
    raise exception 'PCR leads can only be assigned to a salesperson.' using errcode = '22023';
  end if;

  insert into pcr_assignment_log (lead_id, from_owner, to_owner, changed_by)
  select id, owner_id, p_owner_id, auth.uid()
  from pcr_leads
  where id = any(p_lead_ids)
    and is_active
    and owner_id is distinct from p_owner_id;

  update pcr_leads
  set owner_id = p_owner_id,
      assigned_by = auth.uid(),
      assigned_at = now(),
      updated_at = now()
  where id = any(p_lead_ids)
    and is_active
    and owner_id is distinct from p_owner_id;
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;
revoke all on function fn_assign_pcr_leads(uuid[], uuid) from public, anon;
grant execute on function fn_assign_pcr_leads(uuid[], uuid) to authenticated;

comment on table pcr_leads is
  'Live normalized mirror of the PCR Calling Google Sheet. owner_id and assignment audit fields are dashboard-owned.';
comment on function fn_assign_pcr_leads(uuid[], uuid) is
  'Narrow audited bulk assignment path for PCR leads; permits oversight roles including auditor.';
