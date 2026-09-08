-- down 009 · remove seeded reference data (leaves user-added rows alone)
delete from course_plans where (course_days, touch::text) in (
  (7,'response'),(7,'repeat_pitch'),(7,'last_chance'),
  (15,'response'),(15,'mid'),(15,'repeat_pitch'),(15,'last_chance'),
  (30,'response'),(30,'mid'),(30,'repeat_pitch'),(30,'last_chance'),
  (60,'response'),(60,'mid'),(60,'repeat_pitch'),(60,'last_chance'),
  (90,'response'),(90,'mid'),(90,'repeat_pitch'),(90,'last_chance'));
delete from products where sku in
  ('GP60','GP30','DC60','DC30','PD','BUO','SGR','CMB-CONF','CMB-START','CMB-B7');
delete from cancel_reasons where code in
  ('patient_no_show','doctor_unavailable','rescheduled','refund_requested','other','legacy_unknown');
delete from lost_reasons where code in
  ('too_expensive','not_interested','wrong_number','no_response','bought_elsewhere','medical','other');
delete from payment_modes where code in ('gpay','gpay_cod','cod','razorpay','bank_transfer');
delete from couriers where code in ('delhivery','shiprocket');
delete from lead_statuses where code in
  ('new','contacted','interested','consultation_booked','converted','lost','junk');
delete from lead_sources where code in
  ('elementor','wati','meta_ad','google_ad','organic','referral','walkin','repeat','zoho_legacy');
