import { describe, expect, it } from 'vitest';
import { buildRangeSnippet, buildWholeSnippet, clampBox, MAX_SNIPPET_CELLS } from '../snippet';
import { columnName, MAX_COL, MAX_ROW, type CellBox } from '../a1';

const box = (top: number, left: number, bottom: number, right: number): CellBox => ({ top, left, bottom, right });

describe('clampBox', () => {
  it('leaves a range that already fits', () => {
    expect(clampBox(box(4, 2, 9, 4))).toEqual(box(4, 2, 9, 4));
  });

  it('keeps whole rows, cutting from the bottom', () => {
    // 4 columns × 100 rows = 400 cells; 50 whole rows is what 200 allows.
    expect(clampBox(box(1, 1, 100, 4), 200)).toEqual(box(1, 1, 50, 4));
  });

  it('cuts columns too when one row alone is wider than the cap', () => {
    expect(clampBox(box(1, 1, 9, 500), 200)).toEqual(box(1, 1, 1, 200));
  });

  it('defaults to the composer cap', () => {
    expect(clampBox(box(1, 1, 1000, 1))).toEqual(box(1, 1, MAX_SNIPPET_CELLS, 1));
  });
});

describe('buildRangeSnippet', () => {
  const grid: Record<string, { text: string; formula?: string }> = {
    B4: { text: '12.4' },
    C4: { text: '13.1' },
    B5: { text: '1,624', formula: 'B4*Inputs!C3' },
    C5: { text: '1,755', formula: 'C4*Inputs!C3' },
  };
  const cellAt = (row: number, col: number) => grid[`${columnName(col)}${row}`] ?? { text: '' };

  it('writes the displayed values as TSV, then the formulas behind them', () => {
    const out = buildRangeSnippet({ sheet: 'Model', box: box(4, 2, 5, 3), cellAt });
    expect(out.truncated).toBe(false);
    expect(out.cellCount).toBe(4);
    expect(out.snippet).toBe(
      [
        'Model!B4:C5 · values (TSV)',
        '12.4\t13.1',
        '1,624\t1,755',
        '',
        'Model!B4:C5 · formulas',
        'B5\tB4*Inputs!C3',
        'C5\tC4*Inputs!C3',
      ].join('\n'),
    );
  });

  it('leaves the formula block out when nothing in the range is computed', () => {
    const out = buildRangeSnippet({ sheet: 'Model', box: box(4, 2, 4, 3), cellAt });
    expect(out.snippet).toBe('Model!B4:C4 · values (TSV)\n12.4\t13.1');
  });

  it('quotes a sheet name that needs it', () => {
    const out = buildRangeSnippet({ sheet: 'My Sheet', box: box(4, 2, 4, 2), cellAt });
    expect(out.snippet.startsWith("'My Sheet'!B4 · values (TSV)")).toBe(true);
  });

  it('says in its first line when the selection was bigger than the block', () => {
    const out = buildRangeSnippet({ sheet: 'Model', box: box(1, 1, 100, 4), cellAt, maxCells: 8 });
    expect(out.truncated).toBe(true);
    expect(out.cellCount).toBe(8);
    expect(out.snippet.split('\n')[0]).toBe(
      'Model!A1:D100 · values (TSV), first 8 of 400 cells (A1:D2)',
    );
  });

  it('keeps a TSV row on one line whatever the cell held', () => {
    const out = buildRangeSnippet({
      sheet: 'Model',
      box: box(1, 1, 1, 2),
      cellAt: (_r, c) => ({ text: c === 1 ? 'line one\nline two' : 'a\tb' }),
    });
    expect(out.snippet.split('\n')[1]).toBe('line one line two\ta b');
  });
});

describe('buildWholeSnippet', () => {
  const grid: Record<string, { text: string; formula?: string }> = {
    A1: { text: 'Line item' }, B1: { text: 'FY2025E' }, C1: { text: 'FY2026E' },
    A4: { text: 'Revenue' }, B4: { text: '12.4' }, C4: { text: '13.1' },
    A5: { text: 'Cost' }, B5: { text: '1,624', formula: 'B4*Inputs!C3' }, C5: { text: '1,755', formula: 'C4*Inputs!C3' },
  };
  const cellAt = (row: number, col: number) => grid[`${columnName(col)}${row}`] ?? { text: '' };
  const extent = { rows: 5, cols: 3 };

  it('names a column by its header and says how full it is, never what fills it', () => {
    const out = buildWholeSnippet({ sheet: 'Model', box: box(1, 2, MAX_ROW, 2), axis: 'cols', extent, cellAt });
    expect(out).toBe('Model!B:B · column B · header "FY2025E" · 2 values, 1 formula in rows 1-5');
    expect(out).not.toContain('12.4');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('names a row by its first cell', () => {
    const out = buildWholeSnippet({ sheet: 'Model', box: box(5, 1, 5, MAX_COL), axis: 'rows', extent, cellAt });
    expect(out).toBe('Model!5:5 · row 5 · header "Cost" · 1 value, 2 formulas in columns A-C');
  });

  it('lists every header of a multi-column selection', () => {
    const out = buildWholeSnippet({ sheet: 'Model', box: box(1, 2, MAX_ROW, 3), axis: 'cols', extent, cellAt });
    expect(out).toContain('columns B:C · header "FY2025E", "FY2026E"');
  });

  it('leaves the header out of a column that has none', () => {
    const out = buildWholeSnippet({ sheet: 'Model', box: box(1, 4, MAX_ROW, 4), axis: 'cols', extent: { rows: 5, cols: 4 }, cellAt });
    expect(out).toBe('Model!D:D · column D · 0 values, 0 formulas in rows 1-5');
  });
});
