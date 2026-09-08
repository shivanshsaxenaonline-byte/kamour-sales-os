-- down 015
-- Legacy rows violate the restored constraint, so they are removed first.
-- This deletes imported order data. Re-run the importer to restore it.
delete from order_items where order_id in (select id from orders where is_legacy);
delete from followups   where order_id in (select id from orders where is_legacy);
delete from orders where is_legacy;
alter table orders drop constraint orders_dispatched_needs_date;
alter table orders add constraint orders_dispatched_needs_date check (
  stage not in ('dispatched','delivered','rto') or dispatch_date is not null
);
alter table orders drop column is_legacy;
