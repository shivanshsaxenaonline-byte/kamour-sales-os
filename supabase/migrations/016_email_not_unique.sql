-- 016 · email is not an identity key; phone is
--
-- 002 put a unique index on lower(email). The Zoho export disproves it: 6
-- addresses are shared by 12 different people, including `hello@kapeefit.com`
-- (the company's own address, typed in when the customer had none).
--
-- The Golden Customer rule in PROJECT.md is "one human = one row", keyed on the
-- E.164 phone. Email was never part of that and must not be able to reject or
-- silently skip a customer.
--
-- Down: supabase/migrations/016_email_not_unique.down.sql

drop index if exists customers_email_live_uidx;

create index customers_email_idx on customers (lower(email))
  where email is not null and merged_into_id is null;
