-- Drops the trigger. The backfilled rows and any task the trigger closed
-- while it was live are left as they are: they are real history — the order
-- did happen — and un-writing them would only re-create the gap this
-- migration closed.
drop trigger if exists trg_orders_reorder_closes_task on public.orders;
drop function if exists public.fn_reorder_closes_open_task();
