-- Down for 20260918140000_discard_unconfirmed_sheet_orders.sql
--
-- Only the function goes. Orders it removed are not restored here — the sheet
-- is the source, and a row whose tick comes off imports again on the next sync.

drop function if exists public.fn_discard_sheet_order(uuid);
