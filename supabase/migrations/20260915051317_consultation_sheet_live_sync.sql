-- Idempotent bridge from the authoritative Consultation Record Google Sheet.
-- The link snapshot lets the importer update only cells that changed in the
-- Sheet, so later edits made in the CRM are not overwritten by stale values.

create table public.sheet_consultation_sync_sources (
  sheet_id          text not null,
  tab_name          text not null,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_success_at   timestamptz,
  lock_until        timestamptz,
  rows_seen         int not null default 0,
  rows_created      int not null default 0,
  rows_updated      int not null default 0,
  rows_skipped      int not null default 0,
  last_error        text,
  primary key (sheet_id, tab_name)
);

create table public.sheet_consultation_links (
  id                uuid primary key default gen_random_uuid(),
  sheet_id          text not null,
  tab_name          text not null,
  source_row_number int not null check (source_row_number >= 2),
  consultation_id   uuid not null references public.consultations(id) on delete cascade,
  identity_key      text not null,
  source_snapshot   jsonb not null,
  last_synced_at    timestamptz not null default now(),
  unique (sheet_id, tab_name, source_row_number),
  unique (consultation_id)
);

create index sheet_consultation_links_source_idx
  on public.sheet_consultation_links (sheet_id, tab_name, source_row_number);

alter table public.sheet_consultation_sync_sources enable row level security;
alter table public.sheet_consultation_sync_sources force row level security;
alter table public.sheet_consultation_links enable row level security;
alter table public.sheet_consultation_links force row level security;

revoke all on public.sheet_consultation_sync_sources from anon, authenticated;
revoke all on public.sheet_consultation_links from anon, authenticated;
grant select, insert, update on public.sheet_consultation_sync_sources to service_role;
grant select, insert, update, delete on public.sheet_consultation_links to service_role;

create or replace function public.claim_sheet_consultation_sync(
  p_sheet_id text,
  p_tab_name text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into public.sheet_consultation_sync_sources (
    sheet_id, tab_name, last_started_at, lock_until, last_error
  ) values (
    p_sheet_id, p_tab_name, now(), now() + interval '5 minutes', null
  )
  on conflict (sheet_id, tab_name) do update set
    last_started_at = excluded.last_started_at,
    lock_until = excluded.lock_until,
    last_error = null
  where (
      sheet_consultation_sync_sources.lock_until is null
      or sheet_consultation_sync_sources.lock_until < now()
    ) and (
      sheet_consultation_sync_sources.last_success_at is null
      or sheet_consultation_sync_sources.last_success_at < now() - interval '45 seconds'
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_sheet_consultation_sync(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_sheet_consultation_sync(text, text)
  to service_role;

-- Postgres Changes only emits rows from tables in this publication. Keep the
-- migration safe on projects where the table was already enabled manually.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'consultations'
  ) then
    alter publication supabase_realtime add table public.consultations;
  end if;
end;
$$;

comment on table public.sheet_consultation_links is
  'Maps authoritative Consultation Record Sheet rows to CRM consultations for idempotent live sync.';
