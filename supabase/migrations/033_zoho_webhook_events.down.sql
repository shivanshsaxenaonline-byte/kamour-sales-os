alter table webhook_events drop constraint webhook_events_provider_check;
alter table webhook_events add constraint webhook_events_provider_check
  check (provider in ('razorpay','elementor','wati'));
