/**
 * Excel number-format codes, read far enough to show a cell the way its author
 * saw it: percents, thousands, fixed decimals, a currency symbol, scaled
 * thousands, a negative section, and dates.
 *
 * Deliberately partial. A code this reader cannot follow falls back to the raw
 * value rather than to a guess, because a wrong number in a financial model is
 * worse than an unformatted one.
 */
import { createDateFormatter, createFormatter } from '@/lib/format';

export type ExcelScalar = string | number | boolean | Date | null | undefined;

/** Excel's day zero. A serial is a UTC instant, and stays one all the way to
 *  the formatter, so the calendar date shown is the one the file stores. */
const EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86400000;

export function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - EPOCH_OFFSET_DAYS) * MS_PER_DAY));
}

/** Literals, colour/locale brackets and width placeholders, none of which say
 *  anything about the shape of the number underneath. */
function stripLiterals(fmt: string): string {
  return fmt
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '');
}

const DATE_LETTERS = /^[ymdhsapge]+$/i;

/**
 * A date code is one whose every letter run is a date token. `General` fails on
 * `n`/`r`/`l`, `0.00E+00` has no `y`/`m`/`d`/`h`/`s`, and `#,##0 "M"` has no
 * letters left once its literal is gone.
 */
export function isDateFormat(fmt: string | undefined | null): boolean {
  if (!fmt) return false;
  const bare = stripLiterals(fmt);
  const runs = bare.match(/[a-z]+/gi);
  if (!runs || !runs.every((r) => DATE_LETTERS.test(r))) return false;
  return /[ymdhs]/i.test(bare);
}

interface DateShape {
  year?: 'numeric';
  month?: '2-digit' | 'short';
  day?: '2-digit';
  hour?: '2-digit';
  minute?: '2-digit';
  second?: '2-digit';
  timeZone: 'UTC';
}

function dateShape(fmt: string): DateShape {
  const bare = stripLiterals(fmt);
  const time = /[hs]/i.test(bare);
  // `m` alone beside an hour is minutes, not a month.
  const date = /[yd]/i.test(bare) || (!time && /m/i.test(bare));
  const shape: DateShape = { timeZone: 'UTC' };
  if (date) {
    shape.year = 'numeric';
    if (/d/i.test(bare)) {
      shape.month = '2-digit';
      shape.day = '2-digit';
    } else {
      shape.month = 'short';
    }
  }
  if (time) {
    shape.hour = '2-digit';
    shape.minute = '2-digit';
    if (/s/i.test(bare)) shape.second = '2-digit';
  }
  return shape;
}

// One memoised formatter per distinct shape. `createFormatter` already tracks
// the locale inside each closure, so the cache never needs clearing.
const numberCache = new Map<string, (n: number) => string>();
const dateCache = new Map<string, (d: Date | number) => string>();

function numberFormatter(opts: Intl.NumberFormatOptions): (n: number) => string {
  const key = JSON.stringify(opts);
  let fmt = numberCache.get(key);
  if (!fmt) {
    fmt = createFormatter(opts);
    numberCache.set(key, fmt);
  }
  return fmt;
}

function dateFormatter(opts: Intl.DateTimeFormatOptions): (d: Date | number) => string {
  const key = JSON.stringify(opts);
  let fmt = dateCache.get(key);
  if (!fmt) {
    fmt = createDateFormatter(opts);
    dateCache.set(key, fmt);
  }
  return fmt;
}

/** Excel's `General`: no grouping, no forced decimals, real precision kept. */
const general = createFormatter({ maximumFractionDigits: 10, useGrouping: false });

interface NumberSection {
  prefix: string;
  suffix: string;
  percent: boolean;
  scientific: boolean;
  /** A trailing comma divides by a thousand — `#,##0,,` reads in millions. */
  scale: number;
  grouping: boolean;
  minFrac: number;
  maxFrac: number;
  minInt: number;
  hasDigits: boolean;
}

/** `;` separates the positive / negative / zero / text sections, except inside
 *  a quoted literal or a bracket. */
export function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '\\') {
      cur += ch + (fmt[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '[') bracket = true;
    else if (!quoted && ch === ']') bracket = false;
    else if (ch === ';' && !quoted && !bracket) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSection(src: string): NumberSection {
  let prefix = '';
  let suffix = '';
  let core = '';
  let seen = false;
  let percent = false;
  let scientific = false;
  const push = (s: string) => {
    if (seen) suffix += s;
    else prefix += s;
  };

  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      push(src.slice(i + 1, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 1;
    } else if (ch === '\\') {
      push(src[i + 1] ?? '');
      i += 2;
    } else if (ch === '_' || ch === '*') {
      // Width padding and fill: they change spacing, not the value.
      i += 2;
    } else if (ch === '[') {
      const end = src.indexOf(']', i);
      const inner = src.slice(i + 1, end < 0 ? src.length : end);
      // `[$€-407]` carries a currency symbol; `[Red]` and `[>=100]` carry none.
      const currency = /^\$([^-\]]*)/.exec(inner);
      if (currency?.[1]) push(currency[1]);
      i = end < 0 ? src.length : end + 1;
    } else if (ch === '%') {
      // The percent style draws its own sign, in the place the locale wants it.
      percent = true;
      i++;
    } else if (ch === '#' || ch === '0' || ch === '?' || ch === '.' || ch === ',') {
      seen = true;
      core += ch;
      i++;
    } else if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      scientific = true;
      let j = i + 2;
      while (j < src.length && '0#?'.includes(src[j])) j++;
      i = j;
    } else {
      push(ch);
      i++;
    }
  }

  const trailing = /,+$/.exec(core);
  const body = trailing ? core.slice(0, -trailing[0].length) : core;
  const dot = body.indexOf('.');
  const int = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? '' : body.slice(dot + 1);
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  return {
    prefix,
    suffix,
    percent,
    scientific,
    scale: trailing ? 1 / 1000 ** trailing[0].length : 1,
    grouping: body.includes(','),
    minFrac: Math.min(count(frac, /0/g), 20),
    maxFrac: Math.min(count(frac, /[0#?]/g), 20),
    minInt: Math.min(Math.max(count(int, /0/g), 1), 21),
    hasDigits: /[#0?]/.test(body),
  };
}

function renderSection(value: number, section: NumberSection): string {
  const opts: Intl.NumberFormatOptions = {
    style: section.percent ? 'percent' : 'decimal',
    useGrouping: section.grouping,
    minimumFractionDigits: section.minFrac,
    maximumFractionDigits: Math.max(section.maxFrac, section.minFrac),
    minimumIntegerDigits: section.minInt,
  };
  if (section.scientific) opts.notation = 'scientific';
  return section.prefix + numberFormatter(opts)(value * section.scale) + section.suffix;
}

/**
 * A number under its format code. Excel picks the section by sign and, having
 * picked the negative one, formats the magnitude — which is why `#,##0;(#,##0)`
 * shows `(1,240)` and not `(-1,240)`.
 */
export function formatNumber(value: number, fmt: string | undefined | null): string {
  if (!Number.isFinite(value)) return String(value);
  if (!fmt || fmt === 'General' || fmt === '@') return general(value);
  try {
    const sections = splitSections(fmt);
    let src = sections[0];
    let picked = 0;
    let n = value;
    if (value < 0 && sections[1] !== undefined) {
      src = sections[1];
      picked = 1;
      n = Math.abs(value);
    } else if (value === 0 && sections[2] !== undefined) {
      src = sections[2];
      picked = 2;
    }
    // A fraction code (`# ?/?`) reads its digits as a numerator and a
    // denominator, which is a different number entirely. Not supported, so the
    // raw value is the honest answer.
    if (/[#0?]\s*\/\s*[#0?]/.test(src)) return general(value);
    const section = parseSection(src);
    if (section.hasDigits) return renderSection(n, section);
    // A negative or zero section written as a bare literal is Excel's idiom for
    // "print this instead" — `#,##0;(#,##0);"-"` puts a dash on zero, and an
    // empty one prints nothing. A *first* section with no digits is far more
    // likely to be a code this reader misread, so that one falls back to raw.
    return picked > 0 ? section.prefix + section.suffix : general(value);
  } catch {
    return general(value);
  }
}

export function formatDate(date: Date, fmt: string | undefined | null): string {
  if (Number.isNaN(date.getTime())) return '';
  return dateFormatter(dateShape(fmt ?? 'yyyy-mm-dd'))(date);
}

/** What a cell shows, given its value and its number format. */
export function formatCellValue(value: ExcelScalar, fmt?: string | null): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value, fmt);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    return isDateFormat(fmt) ? formatDate(excelSerialToDate(value), fmt) : formatNumber(value, fmt);
  }
  return String(value);
}
