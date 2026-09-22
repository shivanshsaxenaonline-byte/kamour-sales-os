// The RRR module's date, money and name formatting — one copy.
//
// Before this file there were three istToday()s, two money()s, three different
// day-formatters and two addDays() helpers scattered across five files, and
// they had already drifted: log-call-dialog's addDays worked in machine-local
// time while everything else worked in IST, and medicine-ending's addDays was
// a day short on every single date it produced (see addDaysIso).
//
// Every function here is framework-neutral so the server components, the
// client components and the server actions can all share one definition.

/** The sales floor runs on IST; the server does not. Everything date-shaped in
 *  this module is an IST calendar day, so the shift happens here and nowhere
 *  else. Must agree with the database's own ist_today(). */
export const IST_OFFSET_MS = 5.5 * 3600_000;

const DAY_MS = 86_400_000;

/** Today on the sales floor, as YYYY-MM-DD. */
export const istToday = () =>
  new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** IST calendar date of a stored timestamp (which is serialized in UTC). */
export const istDateFromTimestamp = (timestamp: string) =>
  new Date(new Date(timestamp).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** An IST calendar day `n` days from today. Used for the next-follow-up date a
 *  call outcome suggests, which must be the rep's tomorrow, not the server's. */
export const istTodayPlus = (n: number) =>
  new Date(Date.now() + IST_OFFSET_MS + n * DAY_MS).toISOString().slice(0, 10);

/** Midnight IST on a YYYY-MM-DD day, as a real instant. */
export const istMidnight = (iso: string) => new Date(`${iso}T00:00:00+05:30`).getTime();

/**
 * `n` days after an IST calendar day, still as an IST calendar day.
 *
 * Done as plain arithmetic on the instant rather than Date.setDate(), which is
 * what the previous version used and why it was wrong: setDate() steps the
 * *machine-local* calendar, and the result was then read back through
 * toISOString() as a *UTC* calendar day. Midnight IST is 18:30 UTC the previous
 * day, so that round trip landed one day early on every date it produced —
 * '2026-09-01' + 15 came back as the 15th instead of the 16th.
 */
export const addDaysIso = (iso: string, n: number) =>
  new Date(istMidnight(iso) + n * DAY_MS + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The parcel takes about a week to arrive, and nobody takes a tablet they
 *  have not received. Median 6 days, mean 7.0, over the 130 delivered orders
 *  carrying both dates. Must agree with v_delivery_lag in
 *  fn_generate_ai_daily_leads and with course_started_on in
 *  v_rrr_customer_orders. */
export const DELIVERY_LAG_DAYS = 7;

/** A course nobody recorded and whose parcel held no tablets we know. Fifteen
 *  days, because that is what 441 of the 741 orders carrying both a duration
 *  and a tablet row turn out to be. */
export const FALLBACK_COURSE_DAYS = 15;

/**
 * How long the medicine in a customer's hands is meant to last.
 *
 * The tablets decide it: 60N is a month, 30N a fortnight
 * (products.default_course_days, surfaced as tablet_course_days). The sheet's
 * own course_duration_days is second, not first — 232 orders carry a recorded
 * 15 against a 60N box, typed by habit, and a fortnight's clock on a month's
 * medicine is a call two weeks early.
 */
export const courseDays = (o: {
  tablet_course_days?: number | null;
  course_duration_days: number | null;
}) => o.tablet_course_days || o.course_duration_days || FALLBACK_COURSE_DAYS;

/**
 * When an order's medicine runs out.
 *
 * The day the course started plus its length, where the course starts on the
 * delivery date — not the order date. Two stand-ins for what the order may not
 * record: delivery is taken as DELIVERY_LAG_DAYS after the order, and a course
 * nobody can pin down as FALLBACK_COURSE_DAYS. `estimated` is true whenever
 * either was used, so a screen can mark the date as a guess.
 *
 * Prefer `medicine_ends_on` off v_rrr_customer_orders where the row came from
 * that view; this is the same arithmetic for callers that only have the order.
 */
export function medicineEnds(o: {
  ordered_on: string | null;
  delivered_on: string | null;
  course_duration_days: number | null;
  tablet_course_days?: number | null;
}): { on: string; estimated: boolean } | null {
  const started = o.delivered_on?.slice(0, 10)
    ?? (o.ordered_on ? addDaysIso(o.ordered_on.slice(0, 10), DELIVERY_LAG_DAYS) : null);
  if (!started) return null;
  return {
    on: addDaysIso(started, courseDays(o)),
    estimated: !o.delivered_on || !(o.tablet_course_days || o.course_duration_days),
  };
}

/** Whole IST days from `from` to `to`, positive when `to` is later. */
export const daysBetween = (from: string, to: string) =>
  Math.round((istMidnight(to) - istMidnight(from)) / DAY_MS);

/** Rupees, no paise. The floor reads totals, never fractions. */
export const money = (n: number | null | undefined) =>
  n == null ? '—' : '₹' + Math.round(Number(n)).toLocaleString('en-IN');

/** "12 Sep" — for dense table cells. A full timestamp is read as the IST day
 *  it happened on; slicing its UTC date put every evening-IST call a day early. */
export const dayShort = (iso: string | null) =>
  iso
    ? new Date(iso.length > 10 ? iso : istMidnight(iso)).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
      })
    : '—';

/** "12 Sep" this year, "31 Oct 2025" otherwise — so a history spanning years
 *  does not read as if October came after June. */
export const dayInYear = (iso: string | null) => {
  if (!iso) return '—';
  const day = iso.length > 10 ? istDateFromTimestamp(iso) : iso;
  return day.slice(0, 4) === istToday().slice(0, 4)
    ? dayShort(day)
    : `${dayShort(day)} ${day.slice(0, 4)}`;
};

/** "12 Sep", or "12 Sep 2025" when `withYear`.
 *
 *  For a pair of dates that belong to one row. dayInYear() decides per date,
 *  which is right in isolation and wrong side by side: a row reading
 *  "30 Dec 2025 → ends 5 Feb" leaves the reader to guess which February, and
 *  the answer is not the one the missing year suggests. The caller works out
 *  whether ANY date in the row falls outside this year, and prints them all
 *  the same way. */
export const dayMaybeYear = (iso: string | null, withYear: boolean) =>
  !iso ? '—' : withYear ? `${dayShort(iso)} ${(iso.length > 10 ? istDateFromTimestamp(iso) : iso).slice(0, 4)}` : dayShort(iso);

/** Whether a date falls outside the current IST year — the test the caller
 *  needs to decide dayMaybeYear()'s second argument for a whole row. */
export const isOtherYear = (iso: string | null) =>
  !!iso && (iso.length > 10 ? istDateFromTimestamp(iso) : iso).slice(0, 4) !== istToday().slice(0, 4);

/** "12 Sep 2026" — for panels, where the year matters. */
export const dayLong = (iso: string | null) =>
  iso
    ? new Date(iso.length > 10 ? iso : istMidnight(iso)).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      })
    : '—';

/** "04:30" in IST, from a full timestamp. */
export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });

/** Up to two initials for the row avatar. */
export const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

/** Digits only, so "+91 99458" and "99458" find the same customer. */
export const digitsOf = (s: string) => s.replace(/\D/g, '');
