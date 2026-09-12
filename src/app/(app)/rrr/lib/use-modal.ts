'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Make a `role="dialog" aria-modal="true"` element actually behave like one.
 *
 * Both RRR dialogs claimed to be modal and neither was: Escape did nothing, Tab
 * walked straight out into the table behind them, and closing dropped focus at
 * the top of the document instead of returning it to the row you opened. For a
 * screen whose design brief is "keyboard first", that is the difference between
 * a dialog a rep can drive and one that forces them back to the mouse.
 *
 * Returns the ref to put on the dialog's own element.
 */
export function useModal(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so the effect does not re-run — and re-steal focus — every
  // time the caller re-renders with a fresh closure.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const previous = document.activeElement as HTMLElement | null;

    // Focus the first real control, not the dialog box, so a rep can start
    // typing or hit Enter immediately.
    const first = node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;

      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;

      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      // Wrap at both ends rather than letting Tab escape to the page behind.
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Back to the row that opened it. isConnected guards the case where that
      // row has since been re-rendered away underneath us.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  /** Click on the backdrop itself — never a click that merely bubbled up from
   *  something inside the panel. */
  const onBackdropClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget) close.current();
  };

  return { ref, onBackdropClick };
}
