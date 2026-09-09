-- Down for 022_legacy_course_duration_nullable.sql
-- Only safe while no order actually has a NULL course_duration_days.

alter table orders drop constraint if exists orders_legacy_needs_course_duration;
alter table orders alter column course_duration_days set not null;
comment on column orders.course_duration_days is
  'The RRR clock depends on this: never auto-filled.';
