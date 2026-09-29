-- The AI list stops at 180 days since the last order, not 365.
--
-- Measured on the calls of 1–21 Sep 2026: 269 of the 423 customers called had
-- not ordered for more than 180 days. They took about 650 calls, half the
-- floor's calling, and returned one order of Rs 500. Customers who bought
-- within 75 days ordered again 18% of the time. Every RRR screen now leaves
-- the 181+ customers off (MAX_DAYS_SINCE_ORDER in src/app/(app)/rrr/lib/
-- priority.ts); this is the generator's half of the same rule, so those slots
-- go to customers who can still be won back.
--
-- The live function carries changes this repo does not (20260926090000 was
-- applied from elsewhere), so rather than restate 400 lines and risk rolling
-- them back, this edits the one constant in whatever is live, and refuses if
-- the constant is not there to edit.
do $migration$
declare
  v_sig regprocedure := 'public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure;
  v_def text := pg_get_functiondef(v_sig);
begin
  if position('v_max_age  int := 365;' in v_def) = 0 then
    raise exception 'fn_generate_ai_daily_leads no longer declares v_max_age := 365; edit it by hand';
  end if;
  execute replace(v_def, 'v_max_age  int := 365;', 'v_max_age  int := 180;');
end
$migration$;
