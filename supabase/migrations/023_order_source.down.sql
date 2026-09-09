-- Down for 023_order_source.sql
-- The lead_sources rows are left in place: other rows may already reference
-- them, and an unused reference row is harmless.

drop index if exists orders_source_id_idx;
alter table orders drop column if exists source_id;

-- Only safe while no order actually has a NULL owner.
alter table orders drop constraint if exists orders_live_needs_owner;
alter table orders alter column original_owner_id set not null;
alter table orders alter column current_owner_id  set not null;
