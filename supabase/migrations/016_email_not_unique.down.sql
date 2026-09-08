-- down 016
-- Will fail if duplicate emails exist, which is the point: restoring the unique
-- index requires deciding what to do with the real duplicates first.
drop index if exists customers_email_idx;
create unique index customers_email_live_uidx
  on customers (lower(email)) where email is not null and merged_into_id is null;
