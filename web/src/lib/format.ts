/**
 * Locale-aware number/date formatter factories.
 *
 * Each factory returns a function that memoizes its `Intl.*Format` instance
 * by `i18n.language`, so a per-row formatter on a hot render path costs one
 * Intl construction per locale switch (not per call).
 *
 * Consumers MUST call `useTranslation()` in the component that uses the
 * formatter — without it, the component never re-renders on locale switch
 * and the cell shows stale-locale output until something else triggers a
 * re-render. The formatter itself only re-creates Intl when `i18n.language`
 * changes; React's render cycle is what forces it to actually re-run.
 */
import i18n from '@/i18n';

// Defensive: if `i18n.language` is briefly empty/null/invalid (transient
// changeLanguage state, broken localStorage), the Intl constructor throws.
// Without the catch, the closure would re-throw on every subsequent call —
// every formatted widget on the dashboard would crash at once. The fallback
// uses the host default locale and we still update `lastLocale` so we don't
// retry the bad construction every call.
function safeNumberFormat(lang: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(lang, opts);
  } catch {
    return new Intl.NumberFormat(undefined, opts);
  }
}

function safeDateFormat(lang: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang, opts);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts);
  }
}

export function createFormatter(opts: Intl.NumberFormatOptions): (n: number) => string {
  let lastLocale: string | null = null;
  let fmt: Intl.NumberFormat | null = null;
  return (n: number): string => {
    const lang = i18n.language;
    if (lang !== lastLocale || !fmt) {
      fmt = safeNumberFormat(lang, opts);
      lastLocale = lang;
    }
    return fmt.format(n);
  };
}

export function createDateFormatter(opts: Intl.DateTimeFormatOptions): (d: Date | number) => string {
  let lastLocale: string | null = null;
  let fmt: Intl.DateTimeFormat | null = null;
  return (d: Date | number): string => {
    const lang = i18n.language;
    if (lang !== lastLocale || !fmt) {
      fmt = safeDateFormat(lang, opts);
      lastLocale = lang;
    }
    return fmt.format(d);
  };
}

// Compact short-form integer formatter — `1234 → "1.2K"`, `5_142 → "5.1K"`,
// `1_500_000 → "1.5M"`. Locale-aware via Intl. Numbers under 1000 render in
// full; suffix style follows the active locale (en `K`, zh `万`, etc).
export const compactNumber = createFormatter({ notation: 'compact', maximumFractionDigits: 1 });

// The quote-strip variants. Two fixed decimals so a column of figures keeps
// its width from one tick to the next; grouping off because a stock price
// reads as one number (`1234.50`, not `1,234.50`). Null is the reader's
// concern: these take a number, the caller decides what an absent one shows.
export const fixed2 = createFormatter({ minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
// `exceptZero` rather than `always`: a flat or sub-cent move prints `0.00`, not `-0.00`.
export const signedFixed2 = createFormatter({ minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false, signDisplay: 'exceptZero' });
export const compactNumberFixed2 = createFormatter({ notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const byteAmount = createFormatter({ maximumFractionDigits: 1 });
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

// A byte count in the largest binary unit it reaches, one decimal under ten
// (`40960 → "40 KB"`, `1536 → "1.5 KB"`). The number follows the locale; the
// unit symbols are the same everywhere, spaced so zh-CN reads `256 MB` too.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${byteAmount(0)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 1023.7 KB would print as "1,024 KB"; carry it into the next unit instead.
  if (unit > 0 && unit < BYTE_UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${byteAmount(shown)} ${BYTE_UNITS[unit]}`;
}

function safeRelativeFormat(lang: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'narrow' });
  } catch {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
  }
}

const _RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * Locale-aware relative time — `"5m ago"`, `"yesterday"`, `"in 3d"`, `"昨天"`.
 * Same memoization + `useTranslation()` contract as the factories above.
 * Signed, so future timestamps read as future; sub-minute deltas collapse to
 * the locale's "now" phrasing.
 *
 * Missing and unparseable inputs return `''` rather than a plausible-looking
 * "now" — every call site renders this straight into the DOM, so a bad
 * timestamp has to read as absent, not as fresh.
 */
export const relativeTime = (() => {
  let lastLocale: string | null = null;
  let fmt: Intl.RelativeTimeFormat | null = null;
  return (d: Date | number | string | null | undefined): string => {
    if (d === null || d === undefined || d === '') return '';
    const ms = new Date(d).getTime();
    if (Number.isNaN(ms)) return '';
    const lang = i18n.language;
    if (lang !== lastLocale || !fmt) {
      fmt = safeRelativeFormat(lang);
      lastLocale = lang;
    }
    const seconds = (ms - Date.now()) / 1000;
    const abs = Math.abs(seconds);
    for (const [unit, unitSeconds] of _RELATIVE_STEPS) {
      if (abs >= unitSeconds) return fmt.format(Math.round(seconds / unitSeconds), unit);
    }
    return fmt.format(0, 'second');
  };
})();
