import { describe, expect, it } from 'vitest';

import { clampToPricePane, isOnPricePane, pricePaneHeight } from '../paneBounds';

const chartWith = (heights: number[]) => ({
  panes: () => heights.map((h) => ({ getHeight: () => h })),
});

describe('pricePaneHeight', () => {
  it('reads pane 0, not the whole container', () => {
    expect(pricePaneHeight(chartWith([320, 80]) as never, 400)).toBe(320);
  });

  it('falls back to the host height without a usable pane', () => {
    expect(pricePaneHeight(null, 400)).toBe(400);
    expect(pricePaneHeight(chartWith([]) as never, 400)).toBe(400);
    expect(pricePaneHeight(chartWith([0]) as never, 400)).toBe(400);
  });

  it('falls back when the chart is disposed', () => {
    const disposed = { panes: () => { throw new Error('disposed'); } };
    expect(pricePaneHeight(disposed as never, 400)).toBe(400);
  });
});

describe('clampToPricePane / isOnPricePane', () => {
  it('keeps a y inside the price pane', () => {
    expect(clampToPricePane(150, 320)).toBe(150);
    expect(clampToPricePane(-10, 320)).toBe(0);
    expect(clampToPricePane(390, 320)).toBe(320);
  });

  it('leaves everything alone when no height was measured', () => {
    expect(clampToPricePane(390, 0)).toBe(390);
    expect(isOnPricePane(390, 0)).toBe(true);
  });

  it('flags a y that starts on the RSI pane', () => {
    expect(isOnPricePane(320, 320)).toBe(true);
    expect(isOnPricePane(321, 320)).toBe(false);
    expect(isOnPricePane(-1, 320)).toBe(false);
  });
});
