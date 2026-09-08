-- 015 · allow imported legacy orders to be delivered without a dispatch date
--
-- `orders_dispatched_needs_date` says you cannot be delivered without having
-- dispatched. Correct for anything the app creates. But the July sheet records
-- a Delivered Date and no dispatch date at all (D-022), and we deliberately do
-- not invent one (D-023), so 166 delivered orders would fail the constraint.
--
-- Rather than weaken the rule for everyone, legacy rows are marked and exempted.
-- New orders keep the original guarantee.
--
-- Down: supabase/migrations/015_legacy_orders.down.sql

alter table orders add column is_legacy boolean not null default false;

comment on column orders.is_legacy is
  'True only for rows loaded from the 2026 sheet import. Exempt from the dispatch-date rule because the source has no dispatch date. Never set on an order created in the app.';

alter table orders drop constraint orders_dispatched_needs_date;

alter table orders add constraint orders_dispatched_needs_date check (
  is_legacy
  or stage not in ('dispatched','delivered','rto')
  or dispatch_date is not null
);

create index on orders (is_legacy) where is_legacy;
