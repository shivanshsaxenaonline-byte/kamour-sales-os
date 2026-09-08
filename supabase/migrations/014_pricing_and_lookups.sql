-- 014 · real prices, course lengths, concerns, and the lookup values found in
--       the July export
--
-- Prices from the "KAMOUR PRODUCTS PRICING - CGA FUNNEL" board, updated
-- 21-05-2026. Each row was verified as MRP x (1 - discount%) = sale price
-- before being written here.
--
-- These are DEFAULTS for display only. The sales team discounts case by case,
-- so `orders.amount` and `orders.discount` remain never-auto-filled. (D-027)
--
-- Down: supabase/migrations/014_pricing_and_lookups.down.sql

-- 30N = a 15-day course, 60N = a 30-day course. Confirmed by the user.
update products set mrp = 3200, sale_price = 2985, default_course_days = 15 where sku = 'GP30';
update products set mrp = 5999, sale_price = 5495, default_course_days = 30 where sku = 'GP60';
update products set mrp =  698, sale_price =  591, default_course_days = 15 where sku = 'DC30';
update products set mrp = 1292, sale_price = 1095, default_course_days = 30 where sku = 'DC60';
update products set mrp =  690, sale_price =  599 where sku = 'PD';
update products set mrp = 1490, sale_price =  999 where sku = 'BUO';
update products set mrp = 2490, sale_price = 1390 where sku = 'SGR';
update products set mrp = 1388, sale_price = 1095, default_course_days = 7 where sku = 'CMB-B7';

-- Power Drive, Boost Up Oil and Shilajit carry no N-count on the board, so no
-- course length is implied. Left NULL rather than guessed — course_duration_days
-- drives the RRR clock.

-- The board states the 7-Day Booster Combo's contents outright.
insert into combo_items (combo_product_id, component_product_id, quantity)
select b.id, c.id, 1 from products b, products c
where b.sku = 'CMB-B7' and c.sku in ('DC30','PD')
on conflict do nothing;

-- Confidence Combo and Starter Combo appear on the wall but their figures are
-- not legible in the photo and their contents are unstated. Left unpriced
-- rather than approximated (open-questions Q29).

-- ---------------------------------------------------------------------------
-- Lookup values that appear in the July export but were not in the seed.
-- Confirmed real by the user, not typos.
-- ---------------------------------------------------------------------------
insert into couriers (code, label_en, sort_order) values
  ('bluedart',   'Bluedart',    30),
  ('dtdc',       'DTDC',        40),
  ('shadowfax',  'Shadowfax',   50),
  ('maruti',     'Maruti',      60),
  ('store',      'Store pickup',70)
on conflict (code) do nothing;

insert into payment_modes (code, label_en, label_hi, sort_order) values
  ('prepaid', 'Prepaid', 'Prepaid', 45)
on conflict (code) do nothing;

insert into lead_sources (code, label_en, label_hi, sort_order) values
  ('kapeefit',       'Kapeefit',       'Kapeefit',   5),
  ('reactivation',   'Reactivation',   'Reactivation', 45),
  ('calling',        'Calling',        'Calling',    55),
  ('wati_elementor', 'Wati + Elementor','Wati + Elementor', 25),
  ('justdial',       'Justdial',       'Justdial',   85),
  ('facebook',       'Facebook',       'Facebook',   86),
  ('instagram',      'Instagram',      'Instagram',  87),
  ('flipkart',       'Flipkart',       'Flipkart',   88),
  ('indiamart',      'IndiaMART',      'IndiaMART',  89)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Concerns. Taken from the `Ad` column of the July export and confirmed by the
-- user. `sexologist` and `other` are categories rather than clinical concerns —
-- kept because that is how the data is actually recorded.
-- ---------------------------------------------------------------------------
insert into concerns (code, label_en, label_hi, sort_order) values
  ('ed',                  'Erectile dysfunction', 'ED',                 10),
  ('pme',                  'Premature ejaculation','PME',               20),
  ('low_libido',           'Low libido',           'Low libido',        30),
  ('performance_anxiety',  'Performance anxiety',  'Performance anxiety',40),
  ('skin_irritation',      'Skin / irritation',    'Skin / irritation', 50),
  ('sexologist',           'Sexologist (general)', 'Sexologist',        60),
  ('other',                'Other',                'Other',             99)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- SLA: 15 minutes from lead creation. "Possibly as soon as possible."
-- This is the top of the Aaj Ka Kaam ranking. (D-028)
-- ---------------------------------------------------------------------------
alter table leads alter column sla_due_at set default (now() + interval '15 minutes');

comment on column leads.sla_due_at is
  'First-response deadline: created_at + 15 minutes. Breach = rank 1 in Aaj Ka Kaam.';
