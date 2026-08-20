import { useEffect, useRef } from 'react';
import { useStableHandler } from './useStableHandler';

/**
 * Keyboard and focus behaviour for a hand-rolled modal overlay.
 *
 * The overlays in this app are raw fixed-position divs rather than Radix
 * dialogs, so nothing supplies the three things a modal owes a keyboard user:
 * focus that starts inside it, focus that cannot leave while it is open, and
 * Escape to close. Attach the returned ref to the dialog element and pair it
 * with `role="dialog"`, `aria-modal="true"` and an `aria-labelledby`.
 */
export function useDialogA11y<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const close = useStableHandler(onClose);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Restore focus to whatever opened the dialog, so dismissing it does not
    // dump the caret back at the top of the document.
    const opener = document.activeElement as HTMLElement | null;
    // tabIndex is the property, not the attribute: it reads -1 for anything
    // deliberately taken out of the tab order, which is how a visually hidden
    // control (the file input behind a dropzone) stays out of the trap.
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'
        )
      ).filter((el) => el.tabIndex >= 0);

    (focusables()[0] ?? node).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at both ends, and pull focus back in if it somehow escaped —
      // the dialog is not inert to the rest of the page, so a stray Tab
      // would otherwise walk into the content behind it.
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      opener?.focus?.();
    };
  }, [close]);

  return ref;
}
