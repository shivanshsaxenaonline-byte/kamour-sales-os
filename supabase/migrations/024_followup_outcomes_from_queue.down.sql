-- Down for 024_followup_outcomes_from_queue.sql
-- Rows already carrying one of the three new values would violate the old
-- constraint, so they are cleared first rather than blocking the rollback.

update followups set outcome = null
 where outcome in ('order_placed','medicine_not_finished','will_update_later');

alter table followups drop constraint if exists followups_outcome_check;

alter table followups add constraint followups_outcome_check check (
  outcome is null or outcome in
    ('connected','no_answer','busy','wrong_number','not_interested','will_buy')
);

comment on column followups.outcome is null;
