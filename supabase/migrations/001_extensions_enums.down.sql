-- down 001
-- Extensions are intentionally NOT dropped: pgcrypto/citext/pg_cron may be in
-- use by other objects, and dropping them is not reversible in a useful sense.
drop function if exists mask_phone(text);
drop function if exists to_e164(text);
drop function if exists set_updated_at();
drop type if exists channel;
drop type if exists segment_code;
drop type if exists rrr_touch;
drop type if exists followup_kind;
drop type if exists consultation_state;
drop type if exists order_stage;
drop type if exists payment_state;
drop type if exists user_role;
