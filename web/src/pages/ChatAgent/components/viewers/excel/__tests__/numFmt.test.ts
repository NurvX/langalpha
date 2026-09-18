import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { excelSerialToDate, formatCellValue, formatNumber, isDateFormat, splitSections } from '../numFmt';

// Every expectation below is en-US output; pin the locale so a machine whose
// navigator says otherwise still runs the same assertions.
beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

describe('splitSections', () => {
  it('splits on a real separator only', () => {
    expect(splitSections('#,##0;(#,##0);"-"')).toEqual(['#,##0', '(#,##0)', '"-"']);
    expect(splitSections('0.0"a;b"')).toEqual(['0.0"a;b"']);
    expect(splitSections('[>=100]0;0.0')).toEqual(['[>=100]0', '0.0']);
  });
});

describe('formatNumber', () => {
  it('reads a percent as a percent', () => {
    expect(formatNumber(0.1234, '0.0%')).toBe('12.3%');
    expect(formatNumber(0.1234, '0%')).toBe('12%');
    expect(formatNumber(0.5, '0.00%')).toBe('50.00%');
  });

  it('groups thousands and holds the decimals the code asks for', () => {
    expect(formatNumber(1624, '#,##0')).toBe('1,624');
    expect(formatNumber(1624.456, '#,##0.00')).toBe('1,624.46');
    expect(formatNumber(1624, '#,##0.00')).toBe('1,624.00');
    expect(formatNumber(1624, '0')).toBe('1624');
    expect(formatNumber(0.5, '0.00')).toBe('0.50');
  });

  it('carries a currency symbol, written either way', () => {
    expect(formatNumber(1234.5, '$#,##0.00')).toBe('$1,234.50');
    expect(formatNumber(1234.5, '"$"#,##0.00')).toBe('$1,234.50');
    expect(formatNumber(1234.5, '[$€-407]#,##0.00')).toBe('€1,234.50');
  });

  it('formats the magnitude under a negative section, which is what the parens are for', () => {
    expect(formatNumber(-1240, '#,##0;(#,##0)')).toBe('(1,240)');
    expect(formatNumber(1240, '#,##0;(#,##0)')).toBe('1,240');
    expect(formatNumber(-1240, '#,##0')).toBe('-1,240');
    expect(formatNumber(0, '#,##0;(#,##0);"--"')).toBe('--');
  });

  it('scales on a trailing comma, a thousand each', () => {
    expect(formatNumber(1234567, '#,##0.0,,"M"')).toBe('1.2M');
    expect(formatNumber(1234567, '#,##0,')).toBe('1,235');
  });

  it('reads a scientific code', () => {
    expect(formatNumber(12345, '0.00E+00')).toBe('1.23E4');
  });

  it('falls back to the raw value rather than guess', () => {
    expect(formatNumber(1234567, 'General')).toBe('1234567');
    expect(formatNumber(0.1234, '')).toBe('0.1234');
    // A fraction code means numerator/denominator, not a decimal.
    expect(formatNumber(0.5, '# ?/?')).toBe('0.5');
    expect(formatNumber(42, '"units"')).toBe('42');
  });
});

describe('isDateFormat', () => {
  it('says yes only when every letter run is a date token', () => {
    expect(isDateFormat('yyyy-mm-dd')).toBe(true);
    expect(isDateFormat('mmm-yy')).toBe(true);
    expect(isDateFormat('[$-409]d mmmm yyyy')).toBe(true);
    expect(isDateFormat('h:mm:ss AM/PM')).toBe(true);
    expect(isDateFormat('"Day "d')).toBe(true);
  });

  it('says no to a number code that merely holds letters', () => {
    expect(isDateFormat('General')).toBe(false);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat('0.00E+00')).toBe(false);
    expect(isDateFormat('#,##0 "days"')).toBe(false);
    expect(isDateFormat('0.0%')).toBe(false);
    expect(isDateFormat(undefined)).toBe(false);
  });
});

describe('formatCellValue', () => {
  it('turns a serial under a date code into that calendar day', () => {
    expect(excelSerialToDate(45000).toISOString().slice(0, 10)).toBe('2023-03-15');
    expect(formatCellValue(45000, 'yyyy-mm-dd')).toBe('03/15/2023');
    expect(formatCellValue(45000, 'mmm-yy')).toBe('Mar 2023');
  });

  it('formats a Date the parser already resolved', () => {
    expect(formatCellValue(new Date(Date.UTC(2023, 2, 15)), 'dd/mm/yyyy')).toBe('03/15/2023');
  });

  it('passes text, booleans and blanks through', () => {
    expect(formatCellValue('Revenue ($M)')).toBe('Revenue ($M)');
    expect(formatCellValue(true)).toBe('TRUE');
    expect(formatCellValue(null)).toBe('');
    expect(formatCellValue(undefined)).toBe('');
  });

  it('never reads a number as a date without a date code', () => {
    expect(formatCellValue(45000, '#,##0')).toBe('45,000');
  });
});
