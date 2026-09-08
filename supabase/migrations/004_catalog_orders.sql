-- 004 · products, orders, order_items
-- Products live in a table, never hardcoded. Order items are ROWS, not a column per SKU.
-- Down: supabase/migrations/004_catalog_orders.down.sql

create table products (
  id                   uuid primary key default gen_random_uuid(),
  sku                  text not null unique,
  name                 text not null,
  variant              text,
  is_combo             boolean not null default false,
  mrp                  numeric(12,2),
  sale_price           numeric(12,2),
  default_course_days  int,
  is_active            boolean not null default true,
  sort_order           int not null default 100,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index on products (sort_order) where is_active;
create trigger trg_products_updated before update on products
  for each row execute function set_updated_at();

-- A combo's contents are data, not a hardcoded map.
create table combo_items (
  id                    uuid primary key default gen_random_uuid(),
  combo_product_id      uuid not null references products(id) on delete cascade,
  component_product_id  uuid not null references products(id),
  quantity              int not null check (quantity > 0),
  unique (combo_product_id, component_product_id),
  constraint combo_not_self check (combo_product_id <> component_product_id)
);
create index on combo_items (combo_product_id);

create sequence order_no_seq start 1000;

create table orders (
  id                    uuid primary key default gen_random_uuid(),
  order_no              text not null unique default ('KM-' || nextval('order_no_seq')),
  customer_id           uuid not null references customers(id) on delete restrict,
  consultation_id       uuid references consultations(id) on delete set null,
  prescription_id       uuid references prescriptions(id) on delete set null,
  stage                 order_stage not null default 'pending_confirm',
  payment_state         payment_state not null default 'unpaid',
  payment_mode_id       uuid references payment_modes(id),
  razorpay_payment_id   text unique,

  -- money: never auto-filled
  amount                numeric(12,2) not null check (amount >= 0),
  discount              numeric(12,2) not null default 0 check (discount >= 0),
  shipping_amount       numeric(12,2) not null default 0 check (shipping_amount >= 0),
  cod_amount            numeric(12,2),

  -- the RRR clock depends on this: never auto-filled
  course_duration_days  int not null check (course_duration_days > 0),

  -- shipping: never auto-filled. One wrong character is an RTO.
  ship_name             text,
  ship_address          text,
  ship_pincode          text check (ship_pincode is null or ship_pincode ~ '^[1-9][0-9]{5}$'),
  ship_city             text,
  ship_state            text,

  courier_id            uuid references couriers(id),
  awb                   text,
  dispatch_date         date,
  delivered_at          timestamptz,
  rto_at                timestamptz,
  is_repeat             boolean not null default false,

  original_owner_id     uuid not null references users(id),
  current_owner_id      uuid not null references users(id),

  -- SQL formula, never AI. A stored generated column means no code path,
  -- present or future, can write a different value. (decisions.md D-003)
  next_followup_at      date generated always as
                          (dispatch_date + course_duration_days - 4) stored,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint orders_dispatched_needs_date
    check (stage not in ('dispatched','delivered','rto') or dispatch_date is not null),
  constraint orders_discount_not_over_amount
    check (discount <= amount)
);
create index on orders (customer_id, created_at desc);
create index on orders (stage, created_at desc);
create index on orders (current_owner_id, stage, next_followup_at);
create index on orders (original_owner_id);
create index on orders (next_followup_at) where next_followup_at is not null;
create index on orders (dispatch_date) where dispatch_date is not null;
create trigger trg_orders_updated before update on orders
  for each row execute function set_updated_at();

-- Rows, not a column per SKU. Adding a product must never require a migration.
-- unit_price is nullable so legacy imported rows are not given a fabricated
-- price on what is effectively a prescription record. (decisions.md D-009)
create table order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid not null references products(id) on delete restrict,
  quantity    int not null check (quantity > 0),
  unit_price  numeric(12,2) check (unit_price is null or unit_price >= 0),
  line_total  numeric(12,2) generated always as (quantity * unit_price) stored,
  created_at  timestamptz not null default now()
);
create index on order_items (order_id);
create index on order_items (product_id);

-- Keep the Golden Customer's rollups current so list views never aggregate.
-- (decisions.md D-007 — this is the largest avoidable egress line item.)
create or replace function fn_sync_customer_rollups() returns trigger
language plpgsql as $$
declare cid uuid;
begin
  cid := coalesce(new.customer_id, old.customer_id);
  update customers c set
    lifetime_orders = sub.cnt,
    lifetime_value  = sub.val,
    last_order_at   = sub.last_at,
    course_ends_at  = sub.ends_at,
    updated_at      = now()
  from (
    select count(*) as cnt,
           coalesce(sum(o.amount - o.discount), 0) as val,
           max(o.created_at) as last_at,
           max(o.dispatch_date + o.course_duration_days) as ends_at
    from orders o
    where o.customer_id = cid and o.stage <> 'cancelled'
  ) sub
  where c.id = cid;
  return null;
end;
$$;

create trigger trg_orders_rollup
  after insert or update of amount, discount, stage, dispatch_date, course_duration_days
     or delete on orders
  for each row execute function fn_sync_customer_rollups();
