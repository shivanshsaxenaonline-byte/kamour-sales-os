-- 010 · prescription_items
-- Omitted in error from 003. Rows, not columns — adding a SKU to a
-- prescription must never require a migration.
-- Down: supabase/migrations/010_prescription_items.down.sql

create table prescription_items (
  id               uuid primary key default gen_random_uuid(),
  prescription_id  uuid not null references prescriptions(id) on delete cascade,
  product_id       uuid not null references products(id) on delete restrict,
  -- this is a prescription: never auto-filled
  quantity         int not null check (quantity > 0),
  dosage           text,
  created_at       timestamptz not null default now(),
  unique (prescription_id, product_id)
);
create index on prescription_items (prescription_id);
create index on prescription_items (product_id);

alter table prescription_items enable row level security;
alter table prescription_items force row level security;
grant select on prescription_items to authenticated;
