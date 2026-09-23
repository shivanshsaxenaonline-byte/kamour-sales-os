// One vocabulary of "who first" for every RRR list that is not the paged
// All-customers screen (that one sorts in SQL — see ORDERS in ./filters).
//
// Each list keeps its own default, because each was ordered for a reason: the
// AI list by the generator's rank, Medicine Ending by who runs out first, Due
// by who is most overdue. The customer-value orders — LTV above all — are the
// same everywhere, so a manager who sorts by LTV on one screen gets the same
// ranking on the next.

export type SortOption = { value: string; label: string };

/** What a row has to say about its customer to be sorted by value. A WATI lead
 *  nobody has ordered from is 0 / 0 / null and sorts last, not first. */
export type CustomerValue = {
  ltv: number;
  orders: number;
  last_order_at: string | null;
  name: string;
};

export const VALUE_SORTS: SortOption[] = [
  { value: 'ltv', label: 'Highest LTV first' },
  { value: 'orders', label: 'Most orders first' },
  { value: 'recent', label: 'Most recent order first' },
  { value: 'name', label: 'Name A–Z' },
];

const COMPARE: Record<string, (a: CustomerValue, b: CustomerValue) => number> = {
  ltv: (a, b) => b.ltv - a.ltv || b.orders - a.orders,
  orders: (a, b) => b.orders - a.orders || b.ltv - a.ltv,
  // Never ordered sorts last, rather than pretending to be the oldest order.
  recent: (a, b) => (b.last_order_at ?? '').localeCompare(a.last_order_at ?? ''),
  name: (a, b) => a.name.localeCompare(b.name),
};

/**
 * `rows` in the order `sort` asks for. An unknown key (the page's own default)
 * returns the rows in the order they came, which is that default. Ties fall
 * back to that same order, because Array.prototype.sort is stable.
 */
export function sortByValue<T>(rows: T[], sort: string, pick: (row: T) => CustomerValue): T[] {
  const compare = COMPARE[sort];
  if (!compare) return rows;
  return [...rows].sort((a, b) => compare(pick(a), pick(b)));
}
