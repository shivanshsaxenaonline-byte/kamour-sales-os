-- A fifth handset on the floor: 9045599290.
--
-- `Kis number se call hui?` lists contact_numbers, active ones in sort_order,
-- and 026 seeded the four numbers that were in the team's own Apps Script.
-- This one came later, so a call made from it had no honest answer in the
-- dialog — the rep had to pick a number they had not dialled, and the customer
-- who rings back reaches a different handset.
--
-- Seed data, not schema: nothing in the app changes, the select simply has one
-- more option the next time a page loads.
--
-- Down: supabase/migrations/20260918123000_one_more_calling_number.down.sql

insert into contact_numbers (code, label_en, sort_order) values
  ('9045599290', '9045599290', 50)
on conflict (code) do nothing;
