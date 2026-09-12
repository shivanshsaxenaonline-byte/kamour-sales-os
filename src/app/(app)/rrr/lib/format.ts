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

/** Whole IST days from `from` to `to`, positive when `to` is later. */
export const daysBetween = (from: string, to: string) =>
  Math.round((istMidnight(to) - istMidnight(from)) / DAY_MS);

/** Rupees, no paise. The floor reads totals, never fractions. */
export const money = (n: number | null | undefined) =>
  n == null ? '—' : '₹' + Math.round(Number(n)).toLocaleString('en-IN');

/** "12 Sep" — for dense table cells. */
export const dayShort = (iso: string | null) =>
  iso
    ? new Date(istMidnight(iso.slice(0, 10))).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
      })
    : '—';

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
