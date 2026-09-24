import { describe, it, expect, beforeEach } from 'vitest';
import i18n from '@/i18n';
import { createFormatter, createDateFormatter, compactNumber, compactNumberFixed2, fixed2, signedFixed2 } from '@/lib/format';

describe('createFormatter', () => {
  beforeEach(() => {
    i18n.changeLanguage('en-US');
  });

  it('formats numbers with the active locale', () => {
    const fmt = createFormatter({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(fmt(1234.5)).toBe('1,234.50');
  });

  it('reformats after locale switch (zh-CN uses same Western digits + grouping)', () => {
    const fmt = createFormatter({ style: 'currency', currency: 'USD' });
    const en = fmt(1234.5);
    i18n.changeLanguage('zh-CN');
    const zh = fmt(1234.5);
    expect(en).not.toBe(zh);
    expect(zh).toContain('1,234.50');
  });

  it('reuses Intl instance when locale unchanged', () => {
    const fmt = createFormatter({});
    expect(fmt(1)).toBe(fmt(1));
    expect(fmt(2)).toBe('2');
  });

  it('percent formatting respects locale', () => {
    const fmt = createFormatter({ style: 'percent', minimumFractionDigits: 2 });
    expect(fmt(0.1234)).toBe('12.34%');
  });
});

describe('createDateFormatter', () => {
  beforeEach(() => {
    i18n.changeLanguage('en-US');
  });

  it('formats dates with the active locale', () => {
    const fmt = createDateFormatter({ year: 'numeric', month: 'short', day: 'numeric' });
    const out = fmt(new Date('2026-04-25T00:00:00Z'));
    expect(out).toMatch(/Apr/);
  });

  it('reformats after locale switch', () => {
    const fmt = createDateFormatter({ year: 'numeric', month: 'long' });
    const en = fmt(new Date('2026-04-25T00:00:00Z'));
    i18n.changeLanguage('zh-CN');
    const zh = fmt(new Date('2026-04-25T00:00:00Z'));
    expect(en).not.toBe(zh);
  });
});

describe('compactNumber', () => {
  beforeEach(() => {
    i18n.changeLanguage('en-US');
  });

  it('renders sub-thousand values verbatim (no suffix)', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(7)).toBe('7');
    expect(compactNumber(999)).toBe('999');
  });

  it('compacts 4-digit-and-up values with locale suffix', () => {
    expect(compactNumber(1000)).toMatch(/^1K$/);
    expect(compactNumber(1234)).toMatch(/^1\.2K$/);
    expect(compactNumber(5142)).toMatch(/^5\.1K$/);
    expect(compactNumber(1_500_000)).toMatch(/^1\.5M$/);
  });
});

describe('quote-strip formatters', () => {
  beforeEach(() => {
    i18n.changeLanguage('en-US');
  });

  it('fixed2 keeps two decimals and never groups a price', () => {
    expect(fixed2(1234.5)).toBe('1234.50');
    expect(fixed2(0)).toBe('0.00');
    expect(fixed2(-4)).toBe('-4.00');
  });

  it('signedFixed2 signs every move and leaves a flat one unsigned', () => {
    expect(signedFixed2(1.234)).toBe('+1.23');
    expect(signedFixed2(-4)).toBe('-4.00');
    expect(signedFixed2(0)).toBe('0.00');
    // A sub-cent dip rounds to zero and must not print as `-0.00`.
    expect(signedFixed2(-0.001)).toBe('0.00');
  });

  it('compactNumberFixed2 keeps two decimals so a volume column holds its width', () => {
    expect(compactNumberFixed2(999)).toBe('999.00');
    expect(compactNumberFixed2(1234)).toBe('1.23K');
    expect(compactNumberFixed2(1_500_000)).toBe('1.50M');
    expect(compactNumberFixed2(2_000_000_000)).toBe('2.00B');
  });
});

// If `i18n.language` is briefly invalid (transient changeLanguage state, broken
// localStorage), Intl throws. The closure must catch and fall back to the host
// default — otherwise every memoized formatter on the dashboard would crash on
// every subsequent call. Stage the bad locale by stubbing i18n.language directly.
describe('safe fallback for invalid locales', () => {
  it('createFormatter falls back to host default when locale is rejected', () => {
    const original = i18n.language;
    Object.defineProperty(i18n, 'language', { value: 'xx-not-a-locale-😀', configurable: true });
    const fmt = createFormatter({ minimumFractionDigits: 2 });
    expect(() => fmt(1234.5)).not.toThrow();
    expect(fmt(1234.5)).toMatch(/1.?234/);
    Object.defineProperty(i18n, 'language', { value: original, configurable: true });
  });

  it('createDateFormatter falls back to host default when locale is rejected', () => {
    const original = i18n.language;
    Object.defineProperty(i18n, 'language', { value: 'xx-not-a-locale-😀', configurable: true });
    const fmt = createDateFormatter({ year: 'numeric', month: 'short' });
    expect(() => fmt(new Date('2026-04-25T00:00:00Z'))).not.toThrow();
    Object.defineProperty(i18n, 'language', { value: original, configurable: true });
  });
});
