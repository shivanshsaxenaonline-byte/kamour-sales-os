-- 024 · the outcomes the sales floor actually records
--
-- `followups.outcome` allowed six values chosen before we had seen a real
-- call log. The team's live RRR queue (AI Daily Queue tab, 1,769 logged
-- follow-ups over 44 days) uses a nine-value dropdown, and three of its
-- values have no home here:
--
--   Order Placed          266 rows — this is the conversion metric itself.
--                         Folding it into `will_buy` would merge "he says
--                         he'll buy" with "he bought", destroying the one
--                         number the whole RRR exercise is measured on.
--   Medicine Not Finished  46 rows — a real Ayurveda-specific outcome: the
--                         course is still running, call back later. Not the
--                         same as "no answer" or "not interested".
--   Will Update Later      20 rows — customer answered but deferred.
--
-- The remaining six map cleanly onto existing values (Not Interested ->
-- not_interested, Contacted -> connected, Interested -> will_buy, Call Not
-- Picked / Busy -> no_answer, Others / Not Contacted -> NULL).
--
-- Down: supabase/migrations/024_followup_outcomes_from_queue.down.sql

alter table followups drop constraint if exists followups_outcome_check;

alter table followups add constraint followups_outcome_check check (
  outcome is null or outcome in (
    'connected','no_answer','busy','wrong_number','not_interested','will_buy',
    'order_placed','medicine_not_finished','will_update_later'
  )
);

comment on column followups.outcome is
  'Controlled call outcome. order_placed is the conversion signal — it means an order was actually placed on this call, not that one was promised (will_buy).';
