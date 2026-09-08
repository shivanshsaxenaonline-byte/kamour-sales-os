-- 002 · users, lookups, Golden Customer
-- Down: supabase/migrations/002_core_tables.down.sql

create table users (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null,
  phone           text,
  role            user_role not null default 'sales_exec',
  manager_id      uuid references users(id),
  is_active       boolean not null default true,
  daily_lead_cap  int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on users (manager_id);
create index on users (role) where is_active;
create trigger trg_users_updated before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Lookups. All identical in shape; free text is never stored in their place.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'lead_sources','lead_statuses','concerns','couriers',
    'payment_modes','lost_reasons','cancel_reasons'
  ] loop
    execute format($f$
      create table %I (
        id          uuid primary key default gen_random_uuid(),
        code        text not null unique,
        label_en    text not null,
        label_hi    text,
        sort_order  int not null default 100,
        is_active   boolean not null default true,
        created_at  timestamptz not null default now()
      )$f$, t);
    execute format('create index on %I (sort_order) where is_active', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Golden Customer: one human = one row across every channel.
-- ---------------------------------------------------------------------------
create table customers (
  id                  uuid primary key default gen_random_uuid(),
  phone_e164          text not null,
  phone_raw           text,
  alt_phone_e164      text,
  full_name           text not null,
  email               citext,
  gender              text,
  age                 int check (age is null or age between 1 and 120),
  city                text,
  state               text,
  -- never auto-filled: one wrong character is an RTO
  address             text,
  pincode             text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  primary_concern_id  uuid references concerns(id),
  first_source_id     uuid references lead_sources(id),
  -- incentive credit follows original_owner_id, forever
  original_owner_id   uuid references users(id),
  current_owner_id    uuid references users(id),
  lifetime_orders     int not null default 0,
  lifetime_value      numeric(12,2) not null default 0,
  last_order_at       timestamptz,
  course_ends_at      date,
  segment             segment_code,
  is_dnd              boolean not null default false,
  merged_into_id      uuid references customers(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint customers_phone_e164_format check (phone_e164 ~ '^\+91[6-9][0-9]{9}$'),
  constraint customers_not_merged_into_self check (merged_into_id is null or merged_into_id <> id)
);

-- Uniqueness applies to live rows only; merge losers survive so legacy
-- Zoho/WATI ids keep resolving (decisions.md D-008).
create unique index customers_phone_live_uidx
  on customers (phone_e164) where merged_into_id is null;
create index on customers (alt_phone_e164) where alt_phone_e164 is not null;
create index on customers (current_owner_id);
create index on customers (original_owner_id);
create index on customers (segment, course_ends_at);
create unique index customers_email_live_uidx
  on customers (lower(email)) where email is not null and merged_into_id is null;
create trigger trg_customers_updated before update on customers
  for each row execute function set_updated_at();

-- Every external key that ever pointed at this human. Makes the import idempotent.
create table customer_identities (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  system       text not null check (system in ('zoho','wati','elementor','razorpay','sheet')),
  external_id  text not null,
  created_at   timestamptz not null default now(),
  unique (system, external_id)
);
create index on customer_identities (customer_id);
