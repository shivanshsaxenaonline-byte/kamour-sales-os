'use client';

import Link, { useLinkStatus } from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, type ComponentProps } from 'react';

function NavigationFeedback() {
  const { pending } = useLinkStatus();
  return pending ? <>
    <span className="navigation-pending-dot" aria-hidden="true" />
    <span className="navigation-progress" role="status"><span className="sr-only">Opening section</span></span>
  </> : null;
}

/** Fetch a complete route on intent, without loading every data-heavy list at once. */
export function DashboardLink({ children, onMouseEnter, onFocus, ...props }: ComponentProps<typeof Link>) {
  const router = useRouter();
  const warmedAt = useRef(0);
  function warm() {
    if (typeof props.href !== 'string' || !props.href.startsWith('/') || Date.now() - warmedAt.current < 30_000) return;
    warmedAt.current = Date.now();
    router.prefetch(props.href);
  }
  return <Link {...props}
    onMouseEnter={event => { warm(); onMouseEnter?.(event); }}
    onFocus={event => { warm(); onFocus?.(event); }}>
    {children}<NavigationFeedback />
  </Link>;
}
