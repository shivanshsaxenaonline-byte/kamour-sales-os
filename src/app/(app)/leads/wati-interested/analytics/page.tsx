import { redirect } from 'next/navigation';

/**
 * WATI Interested no longer has an analytics page of its own.
 *
 * User, 21 Sep 2026: "wati interested ka lead or rrr wali leads sath m krdete
 * h no seperate analytics."
 *
 * Two pages meant a manager auditing a rep's day had to add two screens
 * together in their head, and neither one matched what the rep was actually
 * looking at — /rrr/my has merged both streams since WATI hand-over was built.
 * /rrr/analytics now loads wati_work_calls and wati_work_items alongside the
 * RRR ones and tags every row with the list it came off.
 *
 * Kept as a redirect rather than deleted: the old path is bookmarked, and it
 * carries the ?date= the manager was looking at.
 */
export default async function WatiAnalyticsRedirect(
  { searchParams }: { searchParams: Promise<{ date?: string }> },
) {
  const { date } = await searchParams;
  redirect(date ? `/rrr/analytics?date=${encodeURIComponent(date)}` : '/rrr/analytics');
}
