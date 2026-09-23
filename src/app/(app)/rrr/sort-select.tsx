'use client';

import type { SortOption } from './lib/sort';

/** The "Sort" dropdown every RRR list carries. `first` is the page's own
 *  default order, listed on top so it is always one pick away. `inToolbar`
 *  drops the visible caption for screens whose controls sit in the toolbar
 *  rather than in a filter panel. */
export function SortSelect({ id, value, onChange, first, options, inToolbar = false }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  first: SortOption;
  options: SortOption[];
  inToolbar?: boolean;
}) {
  const select = (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={first.value}>{inToolbar ? `Sort: ${first.label}` : first.label}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{inToolbar ? `Sort: ${o.label}` : o.label}</option>)}
    </select>
  );
  return inToolbar ? (
    <>
      <label className="sr-only" htmlFor={id}>Sort</label>
      {select}
    </>
  ) : (
    <label className="rrr-field">
      <span>Sort</span>
      {select}
    </label>
  );
}
