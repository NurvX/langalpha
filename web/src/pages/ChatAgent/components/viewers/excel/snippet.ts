/**
 * The block a selected range hands to the composer: displayed values as TSV,
 * then the formulas behind them, so the agent reads both what the model says
 * and how it got there.
 */
import { boxCells, columnName, formatLocator, formatRange, type CellBox } from './a1';

export type WholeAxis = 'rows' | 'cols';

export interface SnippetCell {
  /** What the grid shows, already formatted. */
  text: string;
  /** Present only on a formula cell. */
  formula?: string;
}

export interface RangeSnippet {
  snippet: string;
  /** Cells actually written out. */
  cellCount: number;
  /** The box that was written, cut down from the selection when it was too big. */
  box: CellBox;
  truncated: boolean;
}

/** A composer pill is context, not a payload: past this the range is a file. */
export const MAX_SNIPPET_CELLS = 200;

/** Whole rows are kept whole — a half row of TSV has no readable shape. */
export function clampBox(box: CellBox, maxCells = MAX_SNIPPET_CELLS): CellBox {
  if (boxCells(box) <= maxCells) return box;
  const width = Math.min(box.right - box.left + 1, maxCells);
  const rows = Math.max(1, Math.floor(maxCells / width));
  return {
    top: box.top,
    left: box.left,
    bottom: Math.min(box.bottom, box.top + rows - 1),
    right: box.left + width - 1,
  };
}

/** A TSV field holds no tab and no newline, or the grid it describes collapses. */
function flatten(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').trim();
}

export function buildRangeSnippet(opts: {
  sheet: string;
  box: CellBox;
  cellAt: (row: number, col: number) => SnippetCell;
  maxCells?: number;
}): RangeSnippet {
  const { sheet, box, cellAt } = opts;
  const max = opts.maxCells ?? MAX_SNIPPET_CELLS;
  const kept = clampBox(box, max);
  const truncated = boxCells(kept) < boxCells(box);

  const values: string[] = [];
  const formulas: string[] = [];
  for (let row = kept.top; row <= kept.bottom; row++) {
    const line: string[] = [];
    for (let col = kept.left; col <= kept.right; col++) {
      const cell = cellAt(row, col);
      line.push(flatten(cell.text));
      if (cell.formula) formulas.push(`${columnName(col)}${row}\t${flatten(cell.formula)}`);
    }
    values.push(line.join('\t'));
  }

  const full = formatLocator(sheet, box);
  const head = truncated
    ? `${full} · values (TSV), first ${boxCells(kept)} of ${boxCells(box)} cells (${formatRange(kept)})`
    : `${full} · values (TSV)`;
  const blocks = [head, values.join('\n')];
  if (formulas.length) blocks.push('', `${formatLocator(sheet, kept)} · formulas`, formulas.join('\n'));

  return { snippet: blocks.join('\n'), cellCount: boxCells(kept), box: kept, truncated };
}

/** Headers are quoted in the hint, and the hint is one line, so this is the cap. */
const MAX_HEADERS = 6;

/**
 * The line a whole row or column hands to the composer. A column is a
 * thousand cells the agent can read itself; what it cannot know is which one
 * the user meant, so the hint names the axis, its header label, and how much
 * of it is filled — and nothing of what fills it.
 */
export function buildWholeSnippet(opts: {
  sheet: string;
  /** The locator's box: full-height for columns, full-width for rows. */
  box: CellBox;
  axis: WholeAxis;
  /** How far the sheet actually extends, which bounds the walk. */
  extent: { rows: number; cols: number };
  cellAt: (row: number, col: number) => SnippetCell;
}): string {
  const { sheet, box, axis, extent, cellAt } = opts;
  const lines = axis === 'cols'
    ? range(box.left, Math.min(box.right, extent.cols))
    : range(box.top, Math.min(box.bottom, extent.rows));
  const across = axis === 'cols' ? range(1, extent.rows) : range(1, extent.cols);

  let values = 0;
  let formulas = 0;
  for (const line of lines) {
    for (const k of across) {
      const cell = axis === 'cols' ? cellAt(k, line) : cellAt(line, k);
      if (cell.formula) formulas++;
      else if (cell.text) values++;
    }
  }

  // The label a reader would use: row 1 of a column, column A of a row.
  const headers = lines
    .map((line) => flatten(axis === 'cols' ? cellAt(1, line).text : cellAt(line, 1).text))
    .filter(Boolean);
  const shown = headers.slice(0, MAX_HEADERS).map((h) => `"${h}"`);
  if (headers.length > MAX_HEADERS) shown.push('…');

  const noun = axis === 'cols' ? 'column' : 'row';
  const name = lines.length === 1
    ? `${noun} ${axis === 'cols' ? columnName(lines[0]) : lines[0]}`
    : `${noun}s ${formatRange(box)}`;
  const span = axis === 'cols'
    ? `rows 1-${extent.rows}`
    : `columns A-${columnName(extent.cols)}`;
  const parts = [`${formatLocator(sheet, box)} · ${name}`];
  if (shown.length) parts.push(`header ${shown.join(', ')}`);
  parts.push(`${values} value${values !== 1 ? 's' : ''}, ${formulas} formula${formulas !== 1 ? 's' : ''} in ${span}`);
  return parts.join(' · ');
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}
