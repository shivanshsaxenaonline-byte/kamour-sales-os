-- down 004
drop trigger if exists trg_orders_rollup on orders;
drop function if exists fn_sync_customer_rollups();
drop table if exists order_items;
drop table if exists orders;
drop sequence if exists order_no_seq;
drop table if exists combo_items;
drop table if exists products;
