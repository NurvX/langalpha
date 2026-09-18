import { useCallback, useEffect, useRef, useState } from 'react';

const NO_WRITES: string[] = [];

/**
 * Which open files the agent has rewritten since the tab showing them last
 * read its bytes — the amber dot on a tab.
 *
 * The signal is the thread's own Write/Edit log, newest first. A tab records
 * the log's length when it reads a file; everything the agent writes after
 * that sits in the prefix ahead of that mark, so a path found there is a file
 * that changed under an open tab. A panel with no log (a share, the gallery)
 * simply never marks anything, which is correct: nothing is writing.
 *
 * The log is a live array behind a getter, and nothing re-renders when the
 * agent appends to it, so it is read after each render rather than
 * subscribed to. The equality guard is what keeps that from looping; in
 * practice the render that notices is the one the refreshed file list causes.
 */
export function useChangedFiles(getRecentWritePaths?: (() => string[]) | null) {
  const [writes, setWrites] = useState<string[]>(NO_WRITES);
  const marks = useRef(new Map<string, number>());

  // Deliberately dep-less: it runs after every render, and the equality guard
  // below is what stops the update chain.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const next = getRecentWritePaths?.() ?? NO_WRITES;
    setWrites((prev) => (prev.length === next.length && prev[0] === next[0] ? prev : next.slice()));
  });

  /** This path's bytes are now in hand; writes after this moment are changes. */
  const markRead = useCallback((path: string) => {
    marks.current.set(path, (getRecentWritePaths?.() ?? NO_WRITES).length);
  }, [getRecentWritePaths]);

  const forget = useCallback((path: string) => {
    marks.current.delete(path);
  }, []);

  const hasChanged = useCallback((path: string) => {
    const mark = marks.current.get(path);
    if (mark == null) return false;
    const since = writes.length - mark;
    if (since <= 0) return false;
    const at = writes.indexOf(path);
    return at >= 0 && at < since;
  }, [writes]);

  return { markRead, forget, hasChanged };
}
