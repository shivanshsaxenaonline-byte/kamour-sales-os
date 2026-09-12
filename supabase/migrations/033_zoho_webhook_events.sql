-- 033 · accept Zoho CRM instant-notification webhook deliveries
--
-- Down: supabase/migrations/033_zoho_webhook_events.down.sql

alter table webhook_events drop constraint webhook_events_provider_check;
alter table webhook_events add constraint webhook_events_provider_check
  check (provider in ('razorpay','elementor','wati','zoho'));
