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

// Restore retries: content below the fold lands after the route swap, and how
// long after depends on where it comes from -- a lazy chunk or a warm query
// cache is a few frames, a cold fetch is not. A frame budget was tuned for the
// first and silently never restored the second, so the wait is a deadline
// instead. A user who has started scrolling cancels it (wheel/touch).
const RESTORE_WINDOW_MS = 1200;

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

    let cancelled = false;
    const deadline = performance.now() + RESTORE_WINDOW_MS;
    const retry = () => {
      if (cancelled) return;
      if (el.scrollTop >= target - 4) return; // reached (content tall enough)
      el.scrollTop = target;
      if (performance.now() < deadline) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
    const cancel = () => {
      cancelled = true;
    };
    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('touchstart', cancel, { passive: true });
    return () => {
      cancelled = true;
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('touchstart', cancel);
    };
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
