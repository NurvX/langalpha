import { useLayoutEffect } from 'react';
import type React from 'react';
import { registerAuthReset } from '@/lib/authResets';

/**
 * Session-scoped scroll positions keyed by a stable id (route path, thread id).
 * Module-level so positions survive route unmounts — the whole point: coming
 * back to a tab or thread lands where the user left, not at top/bottom.
 * `'bottom'` is a sticky sentinel: "the user was at the bottom", which for
 * growing content (chat) means re-pin to the new bottom, not a pixel offset.
 */
const positions = new Map<string, number | 'bottom'>();

// LRU bound for long-lived sessions (dashboards left open for days): route/page
// keys are finite, but thread keys accrue per thread visited. Entries are tiny;
// the cap is hygiene, not memory pressure. Deleted threads/workspaces also
// forget their keys eagerly at the delete sites.
const MAX_ENTRIES = 300;

export const scrollMemory = {
  get(key: string): number | 'bottom' | undefined {
    return positions.get(key);
  },
  set(key: string, value: number | 'bottom'): void {
    // Delete-then-set refreshes insertion order, making eviction least-recent.
    positions.delete(key);
    positions.set(key, value);
    if (positions.size > MAX_ENTRIES) {
      const oldest = positions.keys().next().value;
      if (oldest !== undefined) positions.delete(oldest);
    }
  },
  forget(key: string): void {
    positions.delete(key);
  },
  clear(): void {
    positions.clear();
  },
};

// Thread/route keys are per-account state — wipe on sign-out/account switch.
registerAuthReset(() => scrollMemory.clear());

// Restoring is content-dependent, not time-dependent: a saved offset only
// becomes reachable once whatever fills the port has arrived, and how long that
// takes is the network's business rather than a number this module can pick. A
// frame budget tuned for a lazy chunk silently never restored a route whose body
// comes from a fetch, and widening it into a deadline only moved the cliff out
// to slower responses. So watch the port for content instead, and stop the
// moment the offset lands or the user takes the scroll for themselves. The
// bound below is a backstop for a port that never grows tall enough to hold the
// offset, not the mechanism.
const RESTORE_BACKSTOP_MS = 10_000;

/**
 * Keyed scroll persistence for a container the caller owns. Saves scrollTop
 * per key while the user scrolls; on key change restores the saved offset
 * (0 for never-visited keys, so positions don't bleed between routes sharing
 * the container).
 */
export function useScrollMemory(ref: React.RefObject<HTMLElement | null>, key: string): void {
  // Restore before paint so the incoming route never flashes at the stale offset.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = scrollMemory.get(key);
    const target = typeof saved === 'number' ? saved : 0;
    el.scrollTop = target;
    if (target === 0) return;

    // The offset this hook last wrote, so a scroll event can be attributed. Any
    // other value means something else moved the port -- a wheel, a key, a drag
    // on the scrollbar -- and where the user is now outranks where they were.
    // Reading it back rather than assuming `target` matters while the content is
    // still short: the write clamps to whatever the port can currently hold.
    let written = el.scrollTop;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      clearTimeout(backstop);
      el.removeEventListener('scroll', onScroll);
    };
    const attempt = () => {
      if (stopped) return;
      if (el.scrollTop >= target - 4) return stop(); // reached
      el.scrollTop = target;
      written = el.scrollTop;
      if (written >= target - 4) stop();
    };
    const onScroll = () => {
      if (el.scrollTop !== written) stop();
    };
    // `subtree`, because the growth is inside the page the port wraps, not in
    // the port itself -- whose own box is pinned by the column and so never
    // resizes. `characterData`, because a route that renders its shell first and
    // fills the text in later grows without adding a node.
    const observer = new MutationObserver(attempt);
    const backstop = setTimeout(stop, RESTORE_BACKSTOP_MS);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(attempt);
    return stop;
  }, [ref, key]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      scrollMemory.set(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, key]);
}
