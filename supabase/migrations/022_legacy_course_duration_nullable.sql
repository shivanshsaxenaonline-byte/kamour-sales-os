-- 022 · allow imported legacy orders to have no course_duration_days
--
-- Same shape as 015 (dispatch_date). The KM002 Master Sheet's per-product
-- columns (Gold Plus, Power Drive, ...) appear not to have been tracked
-- before ~Oct 2025, so ~993 real historical orders have no product lines
-- and, almost always in the same rows, no Course Duration either. Rejecting
-- them would throw away real revenue and repeat-buyer history over a column
-- that didn't exist yet in the source (D-062: import without line items
-- rather than skip). course_duration_days > 0 already passes on NULL under
-- normal SQL three-valued logic, so this only needs to drop NOT NULL and add
-- the same is_legacy escape hatch 015 used — no existing check changes.
--
-- The RRR clock is unaffected: fn_create_rrr_followups() joins course_plans
-- on course_duration_days, so NULL simply matches no course_plans row and
-- creates no follow-ups — exactly what already happens for these same rows
-- today because they also have no dispatch_date.
--
-- Down: supabase/migrations/022_legacy_course_duration_nullable.down.sql

alter table orders alter column course_duration_days drop not null;

alter table orders add constraint orders_legacy_needs_course_duration check (
  is_legacy or course_duration_days is not null
);

comment on column orders.course_duration_days is
  'The RRR clock depends on this: never auto-filled. NULL only ever appears on is_legacy rows imported from a source sheet that had no course-length data for that order.';
