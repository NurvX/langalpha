import type { FileLocation } from '../../utils/fileLocation';
import type { MemoryTier } from '../../utils/agentPaths';

// --- Types ---

export interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
  files: string[];
}

export interface SelectionTooltipData {
  x: number;
  y: number;
  text: string;
  lineStart?: number | null;
  lineEnd?: number | null;
}

export interface ContextMenuData {
  x: number;
  y: number;
  filePath: string;
}

export interface ContextPayload {
  path?: string;
  snippet?: string;
  label?: string;
  /**
   * Where inside the file the snippet came from, when lines are the wrong unit
   * — a spreadsheet range writes `Model!B4:D9`. Fragment syntax without the
   * leading `#`, so the composer can write `@path#locator` and the link it
   * makes reopens exactly what was referenced.
   */
  locator?: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  lineCount?: number;
  /** What made the snippet, when it is not a file's text: `chat`, `paste`, `chart`. */
  source?: string;
}

export interface EditorTextSelectData {
  text: string;
  startLine: number;
  endLine: number;
  rect: { left: number; top: number; width: number; height: number } | null;
}

/** How the server settled a file reference; `matches` are ranked best first. */
export interface FileRefResolution {
  status: 'resolved' | 'ambiguous' | 'missing' | 'unavailable';
  path?: string;
  matches: string[];
  reason?: string;
}

export interface ApiAdapter {
  readFile?: (path: string) => Promise<{ content: string; mime?: string }>;
  readFileFull?: (path: string) => Promise<{ content: string }>;
  writeFile?: (path: string, content: string) => Promise<unknown>;
  downloadFile?: (path: string) => Promise<string>;
  downloadFileAsArrayBuffer?: (path: string) => Promise<ArrayBuffer>;
  triggerDownload?: (path: string) => Promise<void>;
  resolveFile?: (candidates: string[], recentWrites: string[]) => Promise<FileRefResolution>;
  /** Override the served URL for HTML preview (e.g. the public share serve URL,
   *  used on /s/:shareToken where the workspace UUID isn't available). */
  buildServedUrl?: (path: string, opts?: { injectTheme?: boolean }) => string;
}

export interface BackupResult {
  synced?: number;
  skipped?: number;
  error?: string;
  [key: string]: unknown;
}

export interface SortOption {
  value: string;
  label: string;
}

// --- Panel targets ---

/** The port range the sandbox preview endpoint serves; a tab outside it can never resolve. */
export const PREVIEW_PORT_MIN = 3000;
export const PREVIEW_PORT_MAX = 9999;

/** What a preview tab is opened with. The port is the identity; the rest is labelling. */
export interface PreviewSpec {
  port: number;
  title?: string;
  /** A path suffix on the served app, e.g. `/timeline.html`. */
  path?: string;
  command?: string;
}

/** What a chart tab is opened with. The symbol is the identity; the interval is where it starts. */
export interface ChartTabSpec {
  symbol: string;
  timeframe?: string;
}

/**
 * What a tool tab is opened with: the call id alone. A tab holds no record of
 * its own; it reads the transcript's live one at render, since stream handlers
 * replace a call's record as its result lands, and a copy taken at click time
 * would show a running call forever.
 */
export interface ToolTabSpec {
  toolCallId: string;
}

export interface PlanData {
  description?: string;
  [key: string]: unknown;
}

/**
 * What a plan tab is opened with. Plans are one per approval interrupt, so a
 * thread with a rejected plan and its successor has two, and the id keeps a
 * pinned one from being retargeted. The text itself never changes once
 * proposed, so it can travel with the ask.
 */
export interface PlanTabSpec {
  planId: string;
  plan: PlanData;
}

/**
 * What the right panel is currently pointed at: one discriminated value, so
 * exactly one target is set at a time and the active tab derives from `.kind`.
 *
 * `dir` outlives the click that set it: it is the tree's active filter, shown
 * in the header and cleared by the back button. So it cannot also say that a
 * request happened, and `seq` does, counting the clicks. The same folder asked
 * for twice is two requests carrying one directory.
 */
export type PanelTarget =
  | {
    kind: 'file';
    path?: string | null;
    dir?: string | null;
    location?: FileLocation | null;
    seq?: number;
    /** Open in a tab of its own rather than the preview slot. */
    pin?: boolean;
  }
  /** A dev server the agent started in the sandbox; it opens as a tab in the
   *  Files panel. `seq` counts the asks, so the same port twice is two. */
  | ({ kind: 'preview'; seq: number } & PreviewSpec)
  /** A live market chart; it opens as a tab in the Files panel, one per symbol. */
  | ({ kind: 'chart'; seq: number } & ChartTabSpec)
  /** A tool call's result, opened as a tab in the Files panel. */
  | ({ kind: 'tool'; seq: number } & ToolTabSpec)
  /** A plan's text, opened as a tab in the Files panel. */
  | ({ kind: 'plan'; seq: number } & PlanTabSpec)
  /** A turn's provenance, opened as a tab in the Files panel. */
  | { kind: 'sources'; seq: number; messageId: string }
  | { kind: 'memory'; key: string; tier: MemoryTier }
  | { kind: 'memo'; key: string }
  | { kind: 'status' };

/** The kinds the Files tab owns: it consumes each and clears it once handled. */
export const FILES_PANEL_KINDS = ['file', 'preview', 'chart', 'tool', 'plan', 'sources'] as const satisfies readonly PanelTarget['kind'][];
export type FilesPanelKind = (typeof FILES_PANEL_KINDS)[number];

export function isFilesPanelKind(kind: PanelTarget['kind'] | null | undefined): kind is FilesPanelKind {
  return (FILES_PANEL_KINDS as readonly string[]).includes(kind ?? '');
}

/** A target as a caller states it; the landing stamps `seq`. */
export type UnsequencedTarget = PanelTarget extends infer T ? (T extends { seq?: number } ? Omit<T, 'seq'> : T) : never;

/** Stamp an ask with its sequence number, so the same ask twice arrives twice. */
export function stampTarget(target: UnsequencedTarget, seq: number): PanelTarget {
  return { ...target, seq } as PanelTarget;
}

export function fileTarget(
  path: string,
  { location = null, pin = false }: { location?: FileLocation | null; pin?: boolean },
  seq: number,
): PanelTarget {
  return stampTarget({ kind: 'file', path, location, pin }, seq);
}

/** `''` is the workspace root, not the absence of a folder. */
export function dirTarget(dir: string, seq: number): PanelTarget {
  return stampTarget({ kind: 'file', dir }, seq);
}
