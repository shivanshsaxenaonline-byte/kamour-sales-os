-- Down for 20260918123000_one_more_calling_number.sql
--
-- Deactivated, never deleted. followups.contact_number_id points here, so a
-- delete would either fail on the reference or take the record of which
-- handset a call went out from with it. Inactive is what the dialog reads
-- anyway: the number stops being offered and every past call still names it.

update contact_numbers set is_active = false where code = '9045599290';
