'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { VALUE_SORTS } from '../lib/sort';
import { SortSelect } from '../sort-select';

/** This page is rendered on the server, so its sort lives in the URL. */
export function WorkSort({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, start] = useTransition();
  return (
    <SortSelect id="work-sort" inToolbar value={value}
      first={{ value: 'due', label: 'Due date (default)' }} options={VALUE_SORTS}
      onChange={(next) => {
        const q = new URLSearchParams(params.toString());
        if (next === 'due') q.delete('sort'); else q.set('sort', next);
        const qs = q.toString();
        start(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
      }} />
  );
}
