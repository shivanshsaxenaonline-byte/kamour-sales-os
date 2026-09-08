-- 006 · attendance, assignments, absence, WhatsApp, ad spend, audit, webhooks
-- Down: supabase/migrations/006_ops_audit.down.sql

create table attendance (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  work_date  date not null,
  status     text not null check (status in ('present','absent','half','leave')),
  marked_by  uuid references users(id),
  created_at timestamptz not null default now(),
  unique (user_id, work_date)
);
create index on attendance (work_date, status);

create table absence_events (
  id              uuid primary key default gen_random_uuid(),
  absent_user_id  uuid not null references users(id) on delete cascade,
  strategy        text not null check (strategy in ('assign_one','round_robin','by_load','pool')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  created_by      uuid references users(id)
);
create index on absence_events (absent_user_id, started_at desc);

-- Append-only ownership history. This is how "on return, untouched leads
-- revert" is possible, and how incentive credit is proven.
create table assignments (
  id                uuid primary key default gen_random_uuid(),
  entity_type       text not null check (entity_type in ('lead','customer','order','followup')),
  entity_id         uuid not null,
  from_user_id      uuid references users(id),
  to_user_id        uuid references users(id),
  reason            text not null check (reason in
                      ('manual','round_robin','absence','rrr_pool','import')),
  absence_event_id  uuid references absence_events(id),
  touched           boolean not null default false,
  assigned_at       timestamptz not null default now()
);
create index on assignments (entity_type, entity_id, assigned_at desc);
create index on assignments (absence_event_id) where absence_event_id is not null;
create index on assignments (to_user_id, assigned_at desc);

-- Phase 2 UI. Never joined into a list view; loaded on row expand only.
create table wa_conversations (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid references customers(id) on delete cascade,
  wa_id            text,
  direction        text not null check (direction in ('in','out')),
  template_name    text,
  body             text,
  status           text,
  sent_at          timestamptz,
  wati_message_id  text unique,
  created_at       timestamptz not null default now()
);
create index on wa_conversations (customer_id, sent_at desc);

-- Phase 4, for CAC.
create table ad_spend (
  id          uuid primary key default gen_random_uuid(),
  spend_date  date not null,
  platform    text not null,
  campaign    text not null,
  amount      numeric(12,2) not null check (amount >= 0),
  leads       int,
  created_at  timestamptz not null default now(),
  unique (spend_date, platform, campaign)
);
create index on ad_spend (spend_date desc);

-- ---------------------------------------------------------------------------
-- Audit: ONLY the six fields PROJECT.md names. The allowlist is a CHECK
-- constraint rather than a convention, so an over-eager future trigger fails
-- loudly instead of quietly burning the 5 GB/month quota. (decisions.md D-005)
-- ---------------------------------------------------------------------------
create table audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   uuid not null,
  field       text not null,
  old_value   text,
  new_value   text,
  changed_by  uuid references users(id),
  changed_at  timestamptz not null default now(),
  constraint audit_field_allowlist check (field in
    ('amount','status','owner_id','address','payment_status','order_items'))
);
create index on audit_log (record_id, changed_at desc);
create index on audit_log (changed_by, changed_at desc);

create or replace function fn_audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
begin
  if tg_table_name = 'orders' then
    if new.amount is distinct from old.amount then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'amount', old.amount::text, new.amount::text, actor);
    end if;
    if new.stage is distinct from old.stage then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'status', old.stage::text, new.stage::text, actor);
    end if;
    if new.payment_state is distinct from old.payment_state then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'payment_status', old.payment_state::text, new.payment_state::text, actor);
    end if;
    if new.current_owner_id is distinct from old.current_owner_id then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'owner_id', old.current_owner_id::text, new.current_owner_id::text, actor);
    end if;
    if new.ship_address is distinct from old.ship_address then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'address', old.ship_address, new.ship_address, actor);
    end if;
  elsif tg_table_name = 'customers' then
    if new.address is distinct from old.address then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'address', old.address, new.address, actor);
    end if;
    if new.current_owner_id is distinct from old.current_owner_id then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'owner_id', old.current_owner_id::text, new.current_owner_id::text, actor);
    end if;
  elsif tg_table_name = 'leads' then
    if new.owner_id is distinct from old.owner_id then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'owner_id', old.owner_id::text, new.owner_id::text, actor);
    end if;
    if new.payment_state is distinct from old.payment_state then
      insert into audit_log(table_name, record_id, field, old_value, new_value, changed_by)
      values (tg_table_name, new.id, 'payment_status', old.payment_state::text, new.payment_state::text, actor);
    end if;
  end if;
  return null;
end;
$$;

create trigger trg_audit_orders after update on orders
  for each row execute function fn_audit_row();
create trigger trg_audit_customers after update on customers
  for each row execute function fn_audit_row();
create trigger trg_audit_leads after update on leads
  for each row execute function fn_audit_row();

-- Idempotency for inbound webhooks. A retried Razorpay delivery must never
-- double-mark a lead paid.
create table webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('razorpay','elementor','wati')),
  event_id      text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  unique (provider, event_id)
);
create index on webhook_events (provider, received_at desc) where processed_at is null;

-- The import's honest output. A clean import with 400 rejects is a success;
-- an import with zero rejects means the importer guessed. (decisions.md D-011)
create table import_rejects (
  id             bigint generated always as identity primary key,
  source         text not null,
  source_row_no  int,
  reason         text not null,
  payload        jsonb,
  created_at     timestamptz not null default now()
);
create index on import_rejects (source, reason);
