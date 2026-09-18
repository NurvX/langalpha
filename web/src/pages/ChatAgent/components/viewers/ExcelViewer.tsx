import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FunctionSquare } from 'lucide-react';
import { createFormatter } from '@/lib/format';
import type { ContextPayload } from '../filePanel/types';
import {
  boxOf,
  columnName,
  formatLocator,
  formatRange,
  inBox,
  isWholeColumns,
  isWholeRows,
  MAX_COL,
  MAX_ROW,
  parseLocator,
  type CellBox,
  type CellRef,
} from './excel/a1';
import { parseWorkbook, type GridCell, type SheetData } from './excel/parse';
import { precedentsOf } from './excel/precedents';
import { buildRangeSnippet, buildWholeSnippet, type WholeAxis } from './excel/snippet';
import './ExcelViewer.css';

/** Rows a Page Up / Page Down step covers. */
const PAGE_ROWS = 20;

const integer = createFormatter({ maximumFractionDigits: 0 });

interface Selection {
  anchor: CellRef;
  focus: CellRef;
  /**
   * Set when a header was clicked: the selection is every cell of these
   * columns or rows, however far the sheet grows. Only the anchor's and the
   * focus's column (or row) then matter.
   */
  whole?: WholeAxis;
}

/** The cells the grid paints for a selection — a whole axis stops at the sheet's edge. */
function visibleBox(sel: Selection, sheet: SheetData): CellBox {
  const box = boxOf(sel.anchor, sel.focus);
  if (sel.whole === 'cols') return { ...box, top: 1, bottom: Math.max(1, sheet.rows.length) };
  if (sel.whole === 'rows') return { ...box, left: 1, right: Math.max(1, sheet.colCount) };
  return box;
}

/** The box a locator writes — a whole axis runs to the workbook's limit, as `B:B` means. */
function locatorBox(sel: Selection): CellBox {
  const box = boxOf(sel.anchor, sel.focus);
  if (sel.whole === 'cols') return { ...box, top: 1, bottom: MAX_ROW };
  if (sel.whole === 'rows') return { ...box, left: 1, right: MAX_COL };
  return box;
}

/** A link's box read back into a selection: `B:D` selects columns, `4:9` rows. */
function selectionFor(box: CellBox): Selection {
  // Anchor at the far corner so the outline lands on the cell the link named.
  const sel: Selection = {
    anchor: { row: box.bottom, col: box.right },
    focus: { row: box.top, col: box.left },
  };
  if (isWholeColumns(box)) return { ...sel, anchor: { row: 1, col: box.right }, focus: { row: 1, col: box.left }, whole: 'cols' };
  if (isWholeRows(box)) return { ...sel, anchor: { row: box.bottom, col: 1 }, focus: { row: box.top, col: 1 }, whole: 'rows' };
  return sel;
}

export interface ExcelViewerProps {
  data: ArrayBuffer;
  /** Workspace path of the open file, stamped onto the context payload. */
  filePath?: string;
  /**
   * `Model!B7`, `Model!B4:D9` or `B7` — switches to that sheet, selects the
   * range and scrolls it into view. This is what a `#Model!B7` link opens.
   */
  focusCell?: string | null;
  /** Bumped to replay the same `focusCell`, the way PdfViewer replays a page. */
  focusSeq?: number;
  onAddContext?: (payload: ContextPayload) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function cellAt(sheet: SheetData, ref: CellRef): GridCell | undefined {
  return sheet.rows[ref.row - 1]?.[ref.col - 1];
}

/** Selecting a cell a merge covers selects the merge, the way Excel does. */
function resolveMaster(sheet: SheetData | null, ref: CellRef): CellRef {
  const cell = sheet ? cellAt(sheet, ref) : undefined;
  return cell?.master ? { row: cell.master.row, col: cell.master.col } : ref;
}

function withEquals(formula: string): string {
  return `=${formula.replace(/^=/, '')}`;
}

export default function ExcelViewer({ data, filePath, focusCell, focusSeq, onAddContext }: ExcelViewerProps) {
  // Cell text comes from lib/format, which only re-runs when the component
  // re-renders — this is the subscription that makes a locale switch land.
  const { t } = useTranslation();
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [parseError, setParseError] = useState<Error | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [sel, setSel] = useState<Selection | null>(null);
  const [showFormulas, setShowFormulas] = useState(false);
  // The chip is an offer, not a status line: it waits for a selection the user
  // made, and stays down for the range they just added.
  const [interacted, setInteracted] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusCellRef = useRef<HTMLTableCellElement>(null);

  useEffect(() => {
    let cancelled = false;
    parseWorkbook(data)
      .then((result) => {
        if (cancelled) return;
        setSheets(result);
        setActiveSheet(0);
        setSel({ anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } });
        setInteracted(false);
      })
      .catch((err: Error) => {
        console.error('[ExcelViewer] Failed to parse workbook:', err);
        if (!cancelled) setParseError(err);
      });
    return () => { cancelled = true; };
  }, [data]);

  const sheet = sheets ? (sheets[activeSheet] ?? sheets[0]) : null;

  useEffect(() => {
    if (!focusCell || !sheets) return;
    const target = parseLocator(focusCell);
    if (!target) return;
    const index = target.sheet
      ? sheets.findIndex((s) => s.name.toLowerCase() === target.sheet!.toLowerCase())
      : activeSheet;
    if (index >= 0) setActiveSheet(index);
    setSel(selectionFor(target.box));
    setInteracted(true);
    // `activeSheet` is the fallback for an unqualified locator, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCell, focusSeq, sheets]);

  useEffect(() => {
    focusCellRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSheet, sel?.focus.row, sel?.focus.col]);

  const active = sheet && sel ? cellAt(sheet, sel.focus) : undefined;
  const selBox = sel && sheet ? visibleBox(sel, sheet) : null;
  const selLocatorBox = sel ? locatorBox(sel) : null;
  const precedents = useMemo(
    () => precedentsOf(active?.formula, sheet?.name ?? ''),
    [active?.formula, sheet?.name],
  );

  const select = useCallback((row: number, col: number, extend: boolean) => {
    setInteracted(true);
    setSel((prev) => {
      const target = resolveMaster(sheet, { row, col });
      return extend && prev ? { anchor: prev.anchor, focus: target } : { anchor: target, focus: target };
    });
  }, [sheet]);

  /** A header click: the whole column or row, extended along its axis on shift. */
  const selectWhole = useCallback((axis: WholeAxis, index: number, extend: boolean) => {
    setInteracted(true);
    setSel((prev) => {
      // The active cell stays on its other axis, as in Excel: selecting row 5
      // from B5 leaves B5 active, so a following Ctrl+Space means column B.
      const keep = prev?.focus ?? { row: 1, col: 1 };
      const at = axis === 'cols' ? { row: keep.row, col: index } : { row: index, col: keep.col };
      const anchor = extend && prev?.whole === axis ? prev.anchor : at;
      return { anchor, focus: at, whole: axis };
    });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sheet) return;
    const maxRow = sheet.rows.length;
    const maxCol = sheet.colCount;
    const at = sel?.focus ?? { row: 1, col: 1 };

    if (e.key === 'Escape') {
      setSel(null);
      return;
    }
    // Excel's own whole-axis shortcuts: Ctrl+Space a column, Shift+Space a row.
    if (e.key === ' ' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      const rows = e.shiftKey && !(e.ctrlKey || e.metaKey);
      selectWhole(rows ? 'rows' : 'cols', rows ? at.row : at.col, false);
      return;
    }
    // Excel's own show-formulas shortcut.
    if ((e.metaKey || e.ctrlKey) && e.key === '`') {
      e.preventDefault();
      setShowFormulas((v) => !v);
      return;
    }

    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-PAGE_ROWS, 0],
      PageDown: [PAGE_ROWS, 0],
    };
    const move = step[e.key];
    if (move) {
      e.preventDefault();
      select(clamp(at.row + move[0], 1, maxRow), clamp(at.col + move[1], 1, maxCol), e.shiftKey);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      select(e.ctrlKey || e.metaKey ? 1 : at.row, 1, e.shiftKey);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      select(e.ctrlKey || e.metaKey ? maxRow : at.row, maxCol, e.shiftKey);
    }
  }, [sheet, sel, select, selectWhole]);

  const locator = sheet && selLocatorBox ? formatLocator(sheet.name, selLocatorBox) : null;

  const handleAddContext = useCallback(() => {
    if (!sheet || !sel || !selBox || !selLocatorBox || !onAddContext) return;
    const ref = formatLocator(sheet.name, selLocatorBox);
    const cellText = (row: number, col: number) => {
      const cell = sheet.rows[row - 1]?.[col - 1];
      return { text: cell?.text ?? '', formula: cell?.formula };
    };
    // A whole row or column is a pointer, not a payload: the agent gets one
    // line saying which one, and reads the cells itself if it needs them.
    const snippet = sel.whole
      ? buildWholeSnippet({
        sheet: sheet.name,
        box: selLocatorBox,
        axis: sel.whole,
        extent: { rows: sheet.rows.length, cols: sheet.colCount },
        cellAt: cellText,
      })
      : buildRangeSnippet({ sheet: sheet.name, box: selBox, cellAt: cellText }).snippet;
    const name = filePath ? filePath.split('/').pop() || filePath : sheet.name;
    onAddContext({ path: filePath, locator: ref, label: `${name}#${ref}`, snippet });
    setDismissed(ref);
  }, [sheet, sel, selBox, selLocatorBox, onAddContext, filePath]);

  // Bubble to the error boundary the panel wraps this in.
  if (parseError) throw parseError;

  if (!sheets || !sheet) {
    return <div className="excel-viewer-empty">Parsing spreadsheet…</div>;
  }
  if (sheets.length === 0) {
    throw new Error('No sheets found in workbook');
  }
  // An empty sheet keeps the chrome around it: the sheet tabs are how you leave.
  const isEmpty = sheet.rows.length === 0 || sheet.colCount === 0;
  const columns = Array.from({ length: sheet.colCount }, (_, i) => i + 1);
  const notes: string[] = [];
  if (sheet.totalRows > sheet.rows.length) {
    notes.push(`${integer(sheet.rows.length)} of ${integer(sheet.totalRows)} rows`);
  }
  if (sheet.totalCols > sheet.colCount) {
    notes.push(`${integer(sheet.colCount)} of ${integer(sheet.totalCols)} columns`);
  }
  if (sheet.uncalculated > 0) {
    notes.push(`${integer(sheet.uncalculated)} formulas have no cached value`);
  }

  return (
    <div className="excel-viewer clips-focus-ring">
      {!isEmpty && (
        <div className="excel-fbar">
          <div className="excel-namebox" title="Selection">{selLocatorBox ? formatRange(selLocatorBox) : ''}</div>
          <div className="excel-fx">
            {active?.formula ? (
              <>
                <span className="excel-fx-tag">fx</span>
                <span className="excel-fx-formula">{withEquals(active.formula)}</span>
                <span className="excel-fx-value">
                  {active.error ? (
                    <b className="excel-fx-error">{active.error}</b>
                  ) : active.calculated ? (
                    <>= <b>{active.text}</b></>
                  ) : (
                    <span className="excel-fx-muted">not calculated</span>
                  )}
                  <span className="excel-fx-fmt"> · {active.numFmt || 'General'}</span>
                  {precedents.external.length > 0 && (
                    <span className="excel-fx-fmt"> · {precedents.external.join(', ')}</span>
                  )}
                </span>
              </>
            ) : active && active.text ? (
              <>
                <span className="excel-fx-formula">{active.text}</span>
                <span className="excel-fx-value">
                  {active.isText ? 'label' : 'input'}
                  {active.numFmt && <span className="excel-fx-fmt"> · {active.numFmt}</span>}
                </span>
              </>
            ) : (
              <span className="excel-fx-muted">empty</span>
            )}
          </div>
          <button
            type="button"
            className={`excel-fx-toggle${showFormulas ? ' is-on' : ''}`}
            onClick={() => setShowFormulas((v) => !v)}
            aria-pressed={showFormulas}
            title="Show formulas"
          >
            <FunctionSquare className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {isEmpty ? (
        <div className="excel-viewer-empty">This sheet is empty</div>
      ) : (
        <div
          className="excel-table-wrapper excel-grid-wrapper"
          ref={gridRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          aria-label={`${sheet.name} cells`}
        >
          <table className="excel-table excel-grid">
            <thead>
              <tr>
                <th className="excel-row-num excel-corner" aria-label="Row" />
                {columns.map((c) => (
                  <th
                    key={c}
                    className={selBox && c >= selBox.left && c <= selBox.right ? 'is-active' : undefined}
                    title={`Select column ${columnName(c)}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      gridRef.current?.focus();
                      selectWhole('cols', c, e.shiftKey);
                    }}
                  >
                    {columnName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, ri) => {
                const r = ri + 1;
                return (
                  <tr key={r}>
                    <th
                      scope="row"
                      className={`excel-row-num${selBox && r >= selBox.top && r <= selBox.bottom ? ' is-active' : ''}`}
                      title={`Select row ${r}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        gridRef.current?.focus();
                        selectWhole('rows', r, e.shiftKey);
                      }}
                    >
                      {r}
                    </th>
                    {row.map((cell, ci) => {
                      const c = ci + 1;
                      if (cell.master) return null;
                      const isFocus = sel?.focus.row === r && sel?.focus.col === c;
                      const classes = ['excel-cell'];
                      if (cell.isText) classes.push('is-text');
                      if (cell.kind === 'formula') classes.push('is-formula');
                      if (!cell.calculated) classes.push('is-uncalculated');
                      if (cell.error) classes.push('is-error');
                      if (precedents.local.some((b) => inBox(b, r, c))) classes.push('is-precedent');
                      if (selBox && inBox(selBox, r, c)) classes.push('is-selected');
                      if (isFocus) classes.push('is-focus');
                      return (
                        <td
                          key={c}
                          ref={isFocus ? focusCellRef : undefined}
                          className={classes.join(' ')}
                          data-ref={`${columnName(c)}${r}`}
                          style={cell.style}
                          colSpan={cell.colSpan}
                          rowSpan={cell.rowSpan}
                          title={!cell.calculated ? 'This workbook stores no calculated value for this formula' : cell.hyperlink}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            gridRef.current?.focus();
                            select(r, c, e.shiftKey);
                          }}
                        >
                          {showFormulas && cell.formula ? withEquals(cell.formula) : cell.text}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {onAddContext && !isEmpty && interacted && locator && locator !== dismissed && (
        <div className="excel-selchip">
          <span>Add <code>{locator}</code> to context</span>
          <button type="button" onClick={handleAddContext} title={t('context.addToContext')}>
            Add
          </button>
        </div>
      )}

      <div className="excel-footer">
        {sheets.length > 1 && (
          <div className="excel-sheet-tabs">
            {sheets.map((s, idx) => (
              <button
                type="button"
                key={s.name}
                className={`excel-sheet-tab${idx === activeSheet ? ' active' : ''}`}
                onClick={() => {
                  setActiveSheet(idx);
                  setSel({ anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } });
                  setInteracted(false);
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        {notes.length > 0 && <div className="excel-footer-note">{notes.join(' · ')}</div>}
      </div>
    </div>
  );
}
