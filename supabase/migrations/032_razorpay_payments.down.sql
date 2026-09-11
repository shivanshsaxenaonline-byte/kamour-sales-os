-- Down for 032 · Razorpay ingestion
--
-- Drops the gateway's own copy of the payment record. Nothing else references
-- these tables, so this is a clean removal — but note that razorpay_payments
-- is the only place a payment can be traced back to Razorpay, and a rollback
-- throws away every delivery received since it was applied.

drop view if exists v_razorpay_unmatched;
drop table if exists razorpay_events;
drop table if exists razorpay_payments;
