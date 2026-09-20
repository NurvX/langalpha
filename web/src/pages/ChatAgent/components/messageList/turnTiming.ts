/**
 * Elapsed-time copy for the turn fold header.
 *
 * Import-free on purpose, like `liveZoneTiming`: the header's duration is the
 * kind of thing a Node-side spec wants to assert, and the render-block module
 * graph (i18n JSON, framer) cannot load there.
 */

/**
 * `4.2s`, `47s`, `12m 58s`, `1h 3m` — one step of precision at every scale, so
 * the row stops changing width a few seconds into a turn and the reader's eye
 * is not pulled back to a ticking number for the rest of a long run.
 */
/**
 * `4s`, `47s`, `12m 58s`, `1h 3m` for how long the model thought. Whole
 * seconds from the first tick: the header ticks once a second while a thought
 * runs, and tenths there would read as jitter.
 */
export function formatThoughtFor(ms: number): string {
  const elapsed = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(elapsed / 1000);
  if (totalSeconds < 1) return '<1s';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return formatWorkedFor(elapsed);
}

export function formatWorkedFor(ms: number): string {
  const elapsed = Number.isFinite(ms) && ms > 0 ? ms : 0;
  // Under ten seconds the tenth is the whole signal; truncate rather than
  // round so a timer never reads a moment that has not happened yet.
  if (elapsed < 10_000) return `${(Math.floor(elapsed / 100) / 10).toFixed(1)}s`;
  const totalSeconds = Math.floor(elapsed / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
