-- 023 · where an order came from, on the order itself
--
-- `customers.first_source_id` records only a customer's FIRST touch, which
-- cannot answer "did this particular order come from the website or from a
-- rep's call?" — and that question is the whole point of the KM002 sheets:
-- the Master tab is rep-converted work (CGA funnel, Flipkart, Indiamart) and
-- the Kamour.in & Kamour.shop tab is self-serve website checkout. A repeat
-- customer legitimately has orders from both. The user's requirement was
-- exactly this: those orders join the RRR flow like any other, "but usme
-- likha hoga kamour.in or kamour.shop" (D-063).
--
-- Nullable on purpose: an order whose origin is genuinely unrecorded stays
-- NULL rather than being assigned a plausible-looking source.
--
-- Down: supabase/migrations/023_order_source.down.sql

alter table orders add column source_id uuid references lead_sources(id);

create index on orders (source_id) where source_id is not null;

comment on column orders.source_id is
  'Where THIS order came from (website checkout, CGA funnel, marketplace...), as opposed to customers.first_source_id which is the customer''s first-ever touch. NULL means the source was not recorded at the source, never a guess.';

-- Codes the KM002 sheets actually use. kamour.in and kamour.shop are two
-- separate storefronts and are kept separate, not merged into one "website".
insert into lead_sources (code, label_en, label_hi, sort_order) values
  ('cga',          'CGA funnel',   'CGA funnel',   35),
  ('kamour_in',    'Kamour.in',    'Kamour.in',    85),
  ('kamour_shop',  'Kamour.shop',  'Kamour.shop',  86)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- A self-serve website order has no salesperson, and inventing one would put
-- 164 orders' incentive credit on someone who never made a call. Every row in
-- the Kamour.in & Kamour.shop tab has "Conversion By" blank for exactly this
-- reason. `leads.owner_id` is already nullable and migration 020 already
-- treats NULL owner as "unassigned" throughout the queue, so orders now say
-- the same thing the rest of the schema already says.
--
-- Non-legacy orders keep the guarantee: the app must still name an owner.
-- ---------------------------------------------------------------------------
alter table orders alter column original_owner_id drop not null;
alter table orders alter column current_owner_id  drop not null;

alter table orders add constraint orders_live_needs_owner check (
  is_legacy or (original_owner_id is not null and current_owner_id is not null)
);

comment on column orders.current_owner_id is
  'NULL means unassigned — a self-serve website order nobody has picked up yet. Only ever NULL on is_legacy rows; the app always sets an owner.';
