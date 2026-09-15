/**
 * Where inside a file a reference points: `report.md#valuation`,
 * `model.py#L40-L55`, `model.py:42`, `filing.pdf#page=12`.
 */
export interface FileLocation {
  line?: number;
  lineEnd?: number;
  page?: number;
  anchor?: string;
}

export type OpenFileHandler = (path: string, workspaceId?: string, location?: FileLocation) => void;

const LINE_FRAGMENT_RE = /^L(\d+)(?:-L?(\d+))?$/i;
const PAGE_FRAGMENT_RE = /(?:^|&)page=(\d+)(?:&|$)/i;
// `name.ext:42`, `name.ext:40-55`, `name.ext:42:7` (the column is ignored).
// The extension is required so a URL port or a drive letter never reads as a line.
const LINE_SUFFIX_RE = /(\.[a-z0-9]{1,8}):(\d+)(?:-(\d+)|:\d+)?$/i;

function lineRange(start: string, end?: string): FileLocation | null {
  const a = Number(start);
  const b = end ? Number(end) : a;
  if (!(a >= 1)) return null;
  const lo = Math.min(a, b >= 1 ? b : a);
  const hi = Math.max(a, b >= 1 ? b : a);
  return hi > lo ? { line: lo, lineEnd: hi } : { line: lo };
}

/** Read a fragment (without `#`) as a line range, a PDF page, or a heading anchor. */
export function parseFragment(fragment: string): FileLocation | null {
  let frag = fragment;
  try {
    frag = decodeURIComponent(fragment);
  } catch {
    // keep the raw text
  }
  frag = frag.trim();
  if (!frag) return null;
  const line = frag.match(LINE_FRAGMENT_RE);
  if (line) return lineRange(line[1], line[2]);
  const page = frag.match(PAGE_FRAGMENT_RE);
  if (page) return Number(page[1]) >= 1 ? { page: Number(page[1]) } : null;
  return { anchor: frag };
}

/** Split a link destination into the file part and the location it points at. */
export function splitFileLocation(href: string): { path: string; location: FileLocation | null } {
  const hash = href.indexOf('#');
  if (hash >= 0) {
    return { path: href.slice(0, hash), location: parseFragment(href.slice(hash + 1)) };
  }
  const suffix = href.match(LINE_SUFFIX_RE);
  if (suffix && suffix.index !== undefined) {
    return {
      path: href.slice(0, suffix.index + suffix[1].length),
      location: lineRange(suffix[2], suffix[3]),
    };
  }
  return { path: href, location: null };
}

export function hasLineSuffix(href: string): boolean {
  return LINE_SUFFIX_RE.test(href);
}

/** GitHub's heading slug: lowercase, punctuation dropped, each space a hyphen. */
export function slugifyHeading(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** Slugs for headings in document order, with GitHub's `-1`, `-2` suffixes on repeats. */
export function headingSlugs(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = slugifyHeading(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  });
}

/** Index of the heading an anchor names, trying it as written and as a slug. */
export function findHeadingIndex(texts: string[], anchor: string): number {
  const wanted = anchor.replace(/^user-content-/, '');
  const slugs = headingSlugs(texts);
  const exact = slugs.indexOf(wanted.toLowerCase());
  return exact >= 0 ? exact : slugs.indexOf(slugifyHeading(wanted));
}

export function countLines(content: string): number {
  if (!content) return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const ATX_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const MARKUP_SPLIT_RE = /[*_`~$<>[\]()|\\]+/;

interface SourceLine {
  text: string;
  inFence: boolean;
}

/** The markdown source line at `line` (or the next non-blank one), plus fence state. */
function sourceLineAt(source: string, line: number): SourceLine | null {
  const lines = source.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const isFence = FENCE_RE.test(lines[i]);
    if (i >= line - 1 && lines[i].trim() && !isFence) {
      return { text: lines[i], inFence };
    }
    if (isFence) inFence = !inFence;
    if (i > line + 2) break;
  }
  return null;
}

/**
 * A run of plain text from a markdown source line that should appear verbatim
 * in the rendered block: link destinations and markup are dropped and the
 * longest remaining piece is kept, since inline formatting splits the rest.
 */
export function markdownLineProbe(source: string, line: number): string | null {
  const at = sourceLineAt(source, line);
  if (!at) return null;
  if (at.inFence) {
    const code = at.text.trim().replace(/\s+/g, ' ');
    return code.length >= 3 ? code : null;
  }
  const text = at.text
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:>\s*)+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const pieces = text.split(MARKUP_SPLIT_RE).map((p) => p.replace(/\s+/g, ' ').trim());
  const longest = pieces.reduce((best, p) => (p.length > best.length ? p : best), '');
  return longest.length >= 3 ? longest : null;
}

/** Position, among the document's ATX headings, of the last one at or above `line`. */
export function headingIndexAbove(source: string, line: number): number {
  const lines = source.split('\n');
  let inFence = false;
  let count = 0;
  let index = -1;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && ATX_HEADING_RE.test(lines[i])) {
      index = count;
      count += 1;
    }
  }
  return index;
}
