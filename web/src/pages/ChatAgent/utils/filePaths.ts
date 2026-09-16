import type { LucideIcon } from 'lucide-react';
import { FileText, FileCode, Image, Presentation, Table } from 'lucide-react';
import { hasLineSuffix } from './fileLocation';

const EXT_ICONS: Record<string, LucideIcon> = {
  py: FileCode, js: FileCode, jsx: FileCode, ts: FileCode, tsx: FileCode,
  html: FileCode, css: FileCode, sh: FileCode, bash: FileCode, sql: FileCode,
  csv: Table, json: Table, yaml: Table, yml: Table, xml: Table, toml: Table, xlsx: Table, xls: Table,
  pptx: Presentation, ppt: Presentation, key: Presentation,
  png: Image, jpg: Image, jpeg: Image, svg: Image, gif: Image, webp: Image,
};

/** The icon standing for a file's kind, by extension. */
export function fileIcon(path: string): LucideIcon {
  return EXT_ICONS[path.split('.').pop()?.toLowerCase() ?? ''] || FileText;
}

/** Prefix used for cross-workspace file references: __wsref__/{workspaceId}/path */
const WSREF_PREFIX = '__wsref__/';

/**
 * Parse a __wsref__/{workspaceId}/path reference.
 * Returns { workspaceId, path } or null if not a workspace-qualified path.
 *
 * Expects pre-normalized input (no file:// or /home/workspace/ inside the path).
 * Use normalizeFileRefs() at the content level to clean paths before they reach here.
 */
export function parseWsPath(href: string | undefined): { workspaceId: string; path: string } | null {
  if (!href || !href.startsWith(WSREF_PREFIX)) return null;
  const rest = href.slice(WSREF_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx < 1) return null;
  return {
    workspaceId: rest.slice(0, slashIdx),
    path: rest.slice(slashIdx + 1),
  };
}

/**
 * Check if an href looks like a sandbox file path (not an external URL).
 *
 * Expects pre-normalized input (normalizeFileRefs already stripped file://
 * and /home/workspace/ prefixes). Any relative href is a file: the agent has
 * no other use for one, and a relative link left to the browser opens the app
 * itself in a new tab. The file panel owns resolving it, so a name with
 * an unfamiliar extension or none at all still opens. A root-absolute href
 * still needs an extension, since `/settings` style links are app routes.
 * A `name.py:42` line suffix is checked before the scheme test, which would
 * otherwise read `name.py:` as a URL scheme.
 */
export function isFilePath(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith(WSREF_PREFIX)) return !!parseWsPath(href);
  if (hasLineSuffix(href) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return !/^www\./i.test(href);
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#') || href.startsWith('?')) return false;
  if (/^www\./i.test(href)) return false;
  if (href.startsWith('/')) return /\.[a-z0-9]{1,8}(?:[?#].*)?$/i.test(href);
  return true;
}

/**
 * Normalize a file path for API calls: strip __wsref__ prefix, return relative path.
 *
 * Drops a `#fragment` or `?query`, which a link can carry but a file path
 * never does (a literal `#` in a name arrives percent-encoded).
 *
 * Also percent-decodes the path so an LLM-emitted markdown link like
 * `[name](results/%E9%95%BF...md)` reaches the API as raw Unicode and gets
 * encoded exactly once by the HTTP layer. Without this, Axios re-encodes the
 * leading `%` to `%25` and the backend's single `unquote` decodes to a
 * literal `%XX` path that doesn't exist on disk.
 *
 * Expects pre-normalized input (no file:// or /home/workspace/ prefixes).
 */
export function normalizeFilePath(path: string): string {
  const ws = parseWsPath(path);
  const raw = (ws ? ws.path : path).replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);

/**
 * Check if an href points to an image file.
 */
export function isImagePath(href: string | undefined): boolean {
  if (!href) return false;
  const ext = href.split('.').pop()?.split(/[?#]/)[0]?.toLowerCase();
  return !!ext && IMAGE_EXTS.has(ext);
}
