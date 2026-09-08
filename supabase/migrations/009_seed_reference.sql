-- 009 · reference data
--
-- Only values PROJECT.md states outright. Nothing here is invented — where a
-- value is unknown (prices, course lengths per SKU, the concern list) the row
-- is seeded without it rather than with a guess. See docs/open-questions.md.
--
-- Down: supabase/migrations/009_seed_reference.down.sql

insert into lead_sources (code, label_en, label_hi, sort_order) values
  ('elementor',   'Elementor',      'Elementor',   10),
  ('wati',        'WATI',           'WhatsApp',    20),
  ('meta_ad',     'Meta Ad',        'Meta Ad',     30),
  ('google_ad',   'Google Ad',      'Google Ad',   40),
  ('organic',     'Organic',        'Organic',     50),
  ('referral',    'Referral',       'Referral',    60),
  ('walkin',      'Walk-in',        'Walk-in',     70),
  ('repeat',      'Repeat',         'Repeat',      80),
  ('zoho_legacy', 'Zoho (legacy)',  'Purana data', 99)
on conflict (code) do nothing;

insert into lead_statuses (code, label_en, label_hi, sort_order) values
  ('new',                 'New',                'Naya',            10),
  ('contacted',           'Contacted',          'Baat hui',        20),
  ('interested',          'Interested',         'Interested',      30),
  ('consultation_booked', 'Consultation booked','Consult book',    40),
  ('converted',           'Converted',          'Order ho gaya',   50),
  ('lost',                'Lost',               'Lost',            60),
  ('junk',                'Junk',               'Junk',            70)
on conflict (code) do nothing;

insert into couriers (code, label_en, sort_order) values
  ('delhivery',  'Delhivery',  10),
  ('shiprocket', 'Shiprocket', 20)
on conflict (code) do nothing;

-- 'cod' is included because July's 163 orders vs 148 recorded payment modes
-- leaves 15 unaccounted for (open-questions Q7). Harmless if unused.
insert into payment_modes (code, label_en, label_hi, sort_order) values
  ('gpay',          'GPay',          'GPay',        10),
  ('gpay_cod',      'GPay + COD',    'GPay + COD',  20),
  ('cod',           'COD',           'COD',         30),
  ('razorpay',      'Razorpay',      'Razorpay',    40),
  ('bank_transfer', 'Bank transfer', 'Bank',        50)
on conflict (code) do nothing;

insert into lost_reasons (code, label_en, label_hi, sort_order) values
  ('too_expensive',   'Too expensive',       'Mehenga laga',      10),
  ('not_interested',  'Not interested',      'Interest nahi',     20),
  ('wrong_number',    'Wrong number',        'Galat number',      30),
  ('no_response',     'No response',         'Response nahi',     40),
  ('bought_elsewhere','Bought elsewhere',    'Kahin aur se liya', 50),
  ('medical',         'Medical reason',      'Medical reason',    60),
  ('other',           'Other',               'Other',             99)
on conflict (code) do nothing;

insert into cancel_reasons (code, label_en, label_hi, sort_order) values
  ('patient_no_show',  'Patient no-show',     'Patient nahi aaya', 10),
  ('doctor_unavailable','Doctor unavailable', 'Doctor busy',       20),
  ('rescheduled',      'Rescheduled',         'Reschedule hua',    30),
  ('refund_requested', 'Refund requested',    'Refund manga',      40),
  ('other',            'Other',               'Other',             98),
  -- used exactly once, by the legacy import, for July's 8 cancelled rows
  -- that carry no reason in the sheet (open-questions Q9)
  ('legacy_unknown',   'Unknown (legacy)',    'Purana data',       99)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Products. Names and variants from PROJECT.md; prices and per-SKU course
-- lengths are deliberately NULL — money and course_duration_days are on the
-- never-auto-fill list and are not mine to invent (open-questions Q18).
-- ---------------------------------------------------------------------------
insert into products (sku, name, variant, is_combo, sort_order) values
  ('GP60',  'Gold Plus',           '60N', false, 10),
  ('GP30',  'Gold Plus',           '30N', false, 20),
  ('DC60',  'Daily Charge',        '60N', false, 30),
  ('DC30',  'Daily Charge',        '30N', false, 40),
  ('PD',    'Power Drive',         null,  false, 50),
  ('BUO',   'Boost Up Oil',        null,  false, 60),
  ('SGR',   'Shilajit Gold Resin', null,  false, 70),
  ('CMB-CONF',  'Confidence Combo',    null, true, 80),
  ('CMB-START', 'Starter Combo',       null, true, 90),
  ('CMB-B7',    '7-Day Booster Combo', null, true, 95)
on conflict (sku) do nothing;

-- ---------------------------------------------------------------------------
-- The RRR clock, exactly as PROJECT.md states it. 7d has no mid touch
-- (open-questions Q16 asks whether that is intentional).
-- ---------------------------------------------------------------------------
insert into course_plans (course_days, touch, offset_days) values
  (7,  'response',      2),
  (7,  'repeat_pitch',  5),
  (7,  'last_chance',   9),

  (15, 'response',      3),
  (15, 'mid',           8),
  (15, 'repeat_pitch', 11),
  (15, 'last_chance',  17),

  (30, 'response',      5),
  (30, 'mid',          15),
  (30, 'repeat_pitch', 24),
  (30, 'last_chance',  33),

  (60, 'response',      7),
  (60, 'mid',          30),
  (60, 'repeat_pitch', 50),
  (60, 'last_chance',  65),

  (90, 'response',     10),
  (90, 'mid',          45),
  (90, 'repeat_pitch', 78),
  (90, 'last_chance',  96)
on conflict (course_days, touch) do nothing;

-- `concerns` is intentionally NOT seeded. The list is clinical vocabulary and
-- must come from the doctors, not from an agent (open-questions Q19).
