-- The calling-number dropdown defaulted to whatever sorted first, for everyone.
--
-- `Kis number se call hui?` opened on 7217399285 on every screen for every rep,
-- because the dialog seeded itself with numbers[0] and the list is ordered by
-- sort_order. That is Ashutosh's usual handset and nobody else's. Two of the
-- three reps were correcting the field on every single call, and the ones they
-- forgot are now recorded against a number they never dialled.
--
-- The field opens on the number that rep last called from. Last used rather than
-- most used, because the floor moves between handsets within a day and not over
-- months: Tejasv has 394 lifetime calls on 9045599289 and 203 on 7217399285, but
-- he spent last week on the second and is back on the first today. A lifetime
-- count would have pinned him to the wrong one all day; last used follows the
-- handset he is actually holding, and costs him one correction when he switches.
-- Where several calls share the same timestamp — the imported sheet rows carry a
-- date and no clock — the number he uses more often wins.
--
-- It has to be SECURITY DEFINER. A rep's own call history sits behind the
-- restrictive `sales_rrr_followups_only` policy, which shows them follow-ups only
-- for customers they currently hold, so a rep reading their own past calls
-- directly would see almost none of them. This returns one contact-number id for
-- the caller and nothing else — no customer, no outcome, no other rep's habits.
create or replace function public.fn_my_calling_number() returns uuid
language sql stable security definer set search_path = public as $$
  with recent as (
    (select f.contact_number_id, f.completed_at as at
       from public.followups f
      where f.owner_id = auth.uid()
        and f.contact_number_id is not null
        -- Completed calls only. Logging a call also opens the next follow-up
        -- carrying the same number, and an appointment is not a call made.
        and f.completed_at is not null
      order by f.completed_at desc
      limit 50)
    union all
    -- WATI Interested calls are logged against their own task rather than a
    -- follow-up, but they come off the same handset and count the same.
    (select w.contact_number_id, w.called_at
       from public.wati_work_calls w
      where w.owner_id = auth.uid()
        and w.contact_number_id is not null
      order by w.called_at desc
      limit 50)
  )
  select r.contact_number_id
    from recent r
    join public.contact_numbers n
      on n.id = r.contact_number_id and n.is_active
   group by r.contact_number_id
   order by max(r.at) desc, count(*) desc
   limit 1
$$;

revoke all on function public.fn_my_calling_number() from public, anon;
grant execute on function public.fn_my_calling_number() to authenticated;

comment on function public.fn_my_calling_number() is
  'The number this rep last called from, ties going to the one they use more often. Seeds the Log-call dialog so the field opens on the handset in their hand instead of whatever sorts first. Deactivated numbers are never suggested; a rep with no call history gets NULL and the dialog falls back to the first in the list.';
