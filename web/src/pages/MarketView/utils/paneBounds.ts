import type { IChartApi } from 'lightweight-charts';

type PaneSource = Pick<IChartApi, 'panes'>;

/**
 * Height of the price pane (pane 0) in container pixels. The RSI pane sits
 * beneath it inside the same container, so a y measured against the
 * container is only a price coordinate while it stays above this line; past
 * it, `coordinateToPrice` extrapolates a price nothing on screen shows.
 * Falls back to `fallback` (the host height) when the chart is disposed or
 * has no pane yet.
 */
export function pricePaneHeight(chart: PaneSource | null | undefined, fallback: number): number {
  try {
    const h = chart?.panes()[0]?.getHeight();
    return h != null && Number.isFinite(h) && h > 0 ? h : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Clamp a container-relative y onto the price pane. A non-positive height
 * means nothing was measured (an unlaid-out host, jsdom), and then there is
 * nothing to clip against.
 */
export function clampToPricePane(y: number, paneHeight: number): number {
  if (paneHeight <= 0) return y;
  return Math.max(0, Math.min(y, paneHeight));
}

/** Whether a container-relative y lands on the price pane rather than beneath it. */
export function isOnPricePane(y: number, paneHeight: number): boolean {
  if (paneHeight <= 0) return true;
  return y >= 0 && y <= paneHeight;
}
