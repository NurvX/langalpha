/**
 * Resolves a file reference the agent wrote (a markdown link, a tool-call
 * path) to a path that exists in the workspace.
 *
 * Agents often name a file differently from where it landed: a bare
 * `report.md` for `results/report.md`, a path relative to the report that
 * links it, or an absolute sandbox path. The panel tries the cheap, certain
 * matches first and only guesses by name once a direct read has missed, so a
 * file that does exist at the named path is never swapped for a namesake.
 */

import { SYSTEM_DIR_PREFIXES } from '../components/filePanel/fileMeta';

const SANDBOX_ROOT_RE = /^(?:file:\/\/)?\/home\/(?:workspace|daytona)\//;

/** The tools whose path argument names a file the agent created or changed. */
const WRITE_TOOLS = new Set(['Write', 'Edit']);

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? (idx === 0 ? '/' : '') : path.slice(0, idx);
}

/** Canonical workspace-relative form: sandbox root and `./` stripped, `..` folded. */
export function normalizeRefPath(raw: string): string {
  const p = raw.trim().replace(SANDBOX_ROOT_RE, '');
  const absolute = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * Candidate paths for a link found inside an open file, most likely first. A
 * relative link reads against the file's own directory, but agents just as
 * often write it from the workspace root, so both are offered.
 */
export function linkCandidates(href: string, fromFile: string | null): string[] {
  const direct = normalizeRefPath(href);
  if (!fromFile || href.startsWith('/') || SANDBOX_ROOT_RE.test(href)) return [direct];
  const dir = dirname(normalizeRefPath(fromFile));
  if (!dir || dir === '/') return [direct];
  const joined = normalizeRefPath(`${dir}/${href}`);
  return joined === direct ? [direct] : [joined, direct];
}

export function isSystemPath(path: string): boolean {
  if (path.startsWith('/')) return false;
  const first = path.split('/')[0];
  return SYSTEM_DIR_PREFIXES.includes(first);
}

/** The one match certain enough to open without a server round trip: the exact path. */
export function resolveExact(
  candidates: readonly string[],
  files: readonly string[],
  recentWrites: readonly string[],
): string | null {
  const known = new Set([...files, ...recentWrites]);
  return candidates.find((c) => known.has(c)) ?? null;
}

interface ToolCallLike {
  toolName?: string;
  toolCall?: { args?: Record<string, unknown> } | null;
  isFailed?: boolean;
  order?: number;
}

/** Paths the agent wrote or edited in this thread, newest first. */
export function collectRecentWritePaths(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const procs = (messages[i] as { toolCallProcesses?: Record<string, ToolCallLike> } | null)?.toolCallProcesses;
    if (!procs) continue;
    const calls = Object.values(procs)
      .filter((p) => p && WRITE_TOOLS.has(p.toolName ?? '') && !p.isFailed)
      .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    for (const call of calls) {
      const args = call.toolCall?.args;
      const raw = args?.file_path ?? args?.filePath ?? args?.path ?? args?.filename;
      if (typeof raw !== 'string' || !raw) continue;
      const path = normalizeRefPath(raw);
      if (path && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}
