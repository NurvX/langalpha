import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ExcelJS from 'exceljs';
import i18n from '@/i18n';
import type { ContextPayload } from '../../filePanel/types';
import ExcelViewer from '../ExcelViewer';

async function workbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Model');
  wb.addWorksheet('Inputs');
  ws.getCell('A4').value = 'Units (M)';
  ws.getCell('B4').value = 12.4;
  ws.getCell('B4').numFmt = '#,##0.0';
  ws.getCell('B5').value = { formula: 'B4*2', result: 24.8 };
  ws.getCell('B5').numFmt = '#,##0.0';
  ws.getCell('B6').value = { formula: 'B5*Inputs!C3' } as ExcelJS.CellFormulaValue;
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

const cell = (ref: string) => document.querySelector<HTMLTableCellElement>(`td[data-ref="${ref}"]`)!;
const nameBox = () => document.querySelector('.excel-namebox')!.textContent;
const fx = () => document.querySelector('.excel-fx')!.textContent;

describe('ExcelViewer', () => {
  let data: ArrayBuffer;

  beforeAll(async () => {
    await i18n.changeLanguage('en-US');
    // jsdom has no scrollIntoView; the grid uses it to follow the selection.
    Element.prototype.scrollIntoView = vi.fn();
    data = await workbook();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const open = async (props: Partial<React.ComponentProps<typeof ExcelViewer>> = {}) => {
    const view = render(<ExcelViewer data={data} {...props} />);
    await screen.findByText('Units (M)');
    return view;
  };

  it('addresses cells the way Excel does, with row 1 a data row', async () => {
    await open();
    const head = document.querySelector('thead tr')!;
    expect(within(head as HTMLElement).getByText('A')).toBeInTheDocument();
    expect(within(head as HTMLElement).getByText('B')).toBeInTheDocument();
    // The label sits on row 4 and is reachable at A4, not at A3.
    expect(cell('A4').textContent).toBe('Units (M)');
    expect(document.querySelectorAll('tbody tr').length).toBe(6);
  });

  it('reports a cached formula, its value and its format', async () => {
    await open();
    fireEvent.mouseDown(cell('B5'));
    expect(nameBox()).toBe('B5');
    expect(fx()).toContain('=B4*2');
    expect(fx()).toContain('24.8');
    expect(fx()).toContain('#,##0.0');
  });

  it('says so when a formula carries no value instead of printing an object', async () => {
    await open();
    expect(cell('B6').textContent).toBe('=B5*Inputs!C3');
    fireEvent.mouseDown(cell('B6'));
    expect(fx()).toContain('not calculated');
    // The cross-sheet half is named in the bar, and is not on screen to tint.
    expect(fx()).toContain('Inputs!C3');
    expect(document.querySelectorAll('.is-precedent').length).toBe(1);
  });

  it('tints the cells the selected formula reads', async () => {
    await open();
    fireEvent.mouseDown(cell('B5'));
    expect(cell('B4').className).toContain('is-precedent');
    expect(cell('B6').className).not.toContain('is-precedent');
  });

  it('moves with the arrow keys and extends with shift', async () => {
    await open();
    fireEvent.mouseDown(cell('B4'));
    expect(nameBox()).toBe('B4');
    const grid = document.querySelector('.excel-grid-wrapper')!;
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(nameBox()).toBe('B5');
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    expect(nameBox()).toBe('B5:B6');
    fireEvent.keyDown(grid, { key: 'ArrowLeft', shiftKey: true });
    expect(nameBox()).toBe('A5:B6');
  });

  it('extends a range on a shift-click', async () => {
    await open();
    fireEvent.mouseDown(cell('A4'));
    fireEvent.mouseDown(cell('B6'), { shiftKey: true });
    expect(nameBox()).toBe('A4:B6');
  });

  it('selects a whole column from its header, and more of them on shift', async () => {
    await open();
    fireEvent.mouseDown(screen.getByTitle('Select column B'));
    expect(nameBox()).toBe('B:B');
    expect(cell('B4').classList.contains('is-selected')).toBe(true);
    expect(cell('A4').classList.contains('is-selected')).toBe(false);
    fireEvent.mouseDown(screen.getByTitle('Select column A'), { shiftKey: true });
    expect(nameBox()).toBe('A:B');
    // A cell click drops back to a plain range.
    fireEvent.mouseDown(cell('B5'));
    expect(nameBox()).toBe('B5');
  });

  it('selects a whole row from its number, and with Shift+Space', async () => {
    await open();
    fireEvent.mouseDown(screen.getByTitle('Select row 4'));
    expect(nameBox()).toBe('4:4');
    expect(cell('A4').classList.contains('is-selected')).toBe(true);
    expect(cell('A5').classList.contains('is-selected')).toBe(false);
    fireEvent.mouseDown(cell('B5'));
    fireEvent.keyDown(screen.getByLabelText('Model cells'), { key: ' ', shiftKey: true });
    expect(nameBox()).toBe('5:5');
    fireEvent.keyDown(screen.getByLabelText('Model cells'), { key: ' ', ctrlKey: true });
    expect(nameBox()).toBe('B:B');
  });

  it('hands a whole column to the composer as one line that names it, not its cells', async () => {
    const onAddContext = vi.fn<(p: ContextPayload) => void>();
    await open({ filePath: 'models/dcf.xlsx', onAddContext });
    fireEvent.mouseDown(screen.getByTitle('Select column B'));
    fireEvent.click(screen.getByText('Add'));

    const payload = onAddContext.mock.calls[0][0];
    expect(payload.locator).toBe('Model!B:B');
    expect(payload.label).toBe('dcf.xlsx#Model!B:B');
    expect(payload.snippet).toBe('Model!B:B · column B · 1 value, 2 formulas in rows 1-6');
  });

  it('opens a whole column a link named', async () => {
    await open({ focusCell: 'Model!B:B', focusSeq: 1 });
    await waitFor(() => expect(nameBox()).toBe('B:B'));
    expect(cell('B6').classList.contains('is-selected')).toBe(true);
  });

  it('swaps values for formulas on the toggle', async () => {
    await open();
    expect(cell('B5').textContent).toBe('24.8');
    fireEvent.click(screen.getByTitle('Show formulas'));
    expect(cell('B5').textContent).toBe('=B4*2');
    expect(cell('B4').textContent).toBe('12.4');
  });

  it('hands a selected range to the composer as a locator plus a TSV block', async () => {
    const onAddContext = vi.fn<(p: ContextPayload) => void>();
    await open({ filePath: 'models/dcf.xlsx', onAddContext });
    fireEvent.mouseDown(cell('A4'));
    fireEvent.mouseDown(cell('B5'), { shiftKey: true });
    fireEvent.click(screen.getByText('Add'));

    expect(onAddContext).toHaveBeenCalledTimes(1);
    const payload = onAddContext.mock.calls[0][0];
    expect(payload.path).toBe('models/dcf.xlsx');
    expect(payload.locator).toBe('Model!A4:B5');
    expect(payload.label).toBe('dcf.xlsx#Model!A4:B5');
    expect(payload.snippet).toContain('Units (M)\t12.4');
    expect(payload.snippet).toContain('B5\tB4*2');
    // The offer goes down once taken.
    expect(screen.queryByText('Add')).not.toBeInTheDocument();
  });

  it('offers nothing when the panel gave it nowhere to send a selection', async () => {
    await open();
    fireEvent.mouseDown(cell('B5'));
    expect(screen.queryByText('Add')).not.toBeInTheDocument();
  });

  it('opens the cell a link named, on the sheet it named', async () => {
    await open({ focusCell: 'Model!B5' });
    await waitFor(() => expect(nameBox()).toBe('B5'));
    expect(cell('B5').className).toContain('is-focus');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('lists every sheet and switches between them', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Model' }).className).toContain('active');
    fireEvent.click(screen.getByRole('button', { name: 'Inputs' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inputs' }).className).toContain('active'));
  });
});
