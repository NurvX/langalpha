/**
 * The files one turn produced, for the card strip under the agent's reply.
 *
 * A turn's deliverables are named twice: the reply links them, and the write
 * tools record the paths they touched. The links carry the agent's own order
 * and reach files a script wrote, which no tool call names; the tool calls
 * reach a file the reply forgot to mention and carry what the edit changed.
 */

import { isFilePath, isImagePath, normalizeFilePath, parseWsPath } from './filePaths';
import { classifyAgentPath } from './agentPaths';
import { splitFileLocation, type FileLocation } from './fileLocation';
import { isSystemPath, normalizeRefPath, WRITE_TOOLS, type ToolCallLike } from './fileRefResolver';
import { normalizeFileRefs } from './normalizeFileRefs';

export interface TurnFile {
  /** Workspace-relative path, with no location suffix. */
  path: string;
  /** Set when the reference names another workspace (a Flash relay). */
  workspaceId?: string;
  /** The spot inside the file the reply pointed at, if it named one. */
  location?: FileLocation;
  /** Lines this turn's edits added and removed, for a file the Edit tool changed. */
  stats?: { added: number; removed: number };
}

/**
 * A markdown link or image, with the destination bare or in angle brackets.
 *
 * A bare destination carries one level of balanced parens, which CommonMark
 * allows and `normalizeFileRefs.LINK_DEST_RE` already reads, because
 * `report(1).pdf` is a real deliverable name. Without it the reply's own link
 * renders and opens while the card for it never appears, and an embedded
 * `![chart](chart(1).png)` stops counting as embedded and earns a second,
 * duplicate card for what the reader is already looking at.
 */
const LINK_RE = /(!?)\[[^\]\n]*\]\(\s*(<[^<>\n]+>|(?:[^()\s]|\([^()\s]*\))+)\s*\)/g;

interface MessageLike {
  role?: unknown;
  contentSegments?: { type?: string; content?: string }[];
  content?: unknown;
  toolCallProcesses?: Record<string, ToolCallLike>;
}

/**
 * The file kinds a person opens to read the answer.
 *
 * A turn writes two sorts of file: the report, model or deck it was asked for,
 * and the scripts it wrote to get there. Listing the scripts buries the answer
 * in the scaffolding, so the deck lists documents, spreadsheets, pages and
 * charts only. Everything else stays one search away in the file panel.
 */
const DELIVERABLE_EXTS = new Set([
  'md', 'markdown', 'pdf', 'docx', 'doc', 'rtf', 'odt',
  'pptx', 'ppt', 'key',
  'xlsx', 'xls', 'csv',
  'html', 'htm',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
]);

function isDeliverableKind(path: string): boolean {
  const ext = path.split('/').pop()?.split('.');
  return !!ext && ext.length > 1 && DELIVERABLE_EXTS.has(ext[ext.length - 1].toLowerCase());
}

/**
 * What one Edit changed, counted after the lines both sides share.
 *
 * The tool's two strings carry the surrounding lines that anchor the swap, so
 * counting them whole reports an edit several times its real size.
 */
function editLines(text: unknown): string[] {
  // Empty text is no lines at all, and a trailing newline ends the last line
  // rather than opening another. `''.split('\n')` says one line to both, so a
  // deletion would report the line it removed and a phantom line added.
  if (typeof text !== 'string' || text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

function editStats(oldString: unknown, newString: unknown): { added: number; removed: number } {
  const before = editLines(oldString);
  const after = editLines(newString);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  return { added: after.length - head - tail, removed: before.length - head - tail };
}

/** The reply's own text, with the link forms normalized the renderer uses. */
function assistantText(message: MessageLike): string {
  const segments = (message.contentSegments ?? [])
    .filter((s) => s?.type === 'text' && s.content)
    .map((s) => s.content as string);
  const text = segments.length ? segments.join('\n') : typeof message.content === 'string' ? message.content : '';
  return text ? normalizeFileRefs(text) : '';
}

/** Whether a reference points at a workspace file the panel can open. */
function openablePath(path: string): boolean {
  return (
    !!path
    && isDeliverableKind(path)
    && !isSystemPath(path)
    && classifyAgentPath(path).kind === 'file'
  );
}

interface MessageFiles {
  /** Files the reply links, in the order it names them. */
  cited: TurnFile[];
  /** Files a write tool touched, in call order. */
  written: TurnFile[];
  /** Images the reply embeds, which the reader can already see. */
  embedded: string[];
}

// A message object is replaced when it changes, so a cache keyed on it holds
// only while the text is settled: during a turn every other message is a hit,
// and the growing one recomputes alone.
const perMessage = new WeakMap<object, MessageFiles>();

function filesInMessage(message: MessageLike): MessageFiles {
  const cited: TurnFile[] = [];
  const written: TurnFile[] = [];
  const embedded: string[] = [];

  if (message.role === 'assistant') {
    for (const match of assistantText(message).matchAll(LINK_RE)) {
      const dest = match[2].replace(/^<|>$/g, '');
      if (!isFilePath(dest)) continue;
      const wsRef = parseWsPath(dest);
      const { path: href, location } = splitFileLocation(wsRef ? wsRef.path : dest);
      const path = normalizeRefPath(normalizeFilePath(href));
      if (!openablePath(path)) continue;
      if (match[1] === '!' || isImagePath(path)) {
        embedded.push(path);
        continue;
      }
      cited.push({ path, workspaceId: wsRef?.workspaceId, location: location ?? undefined });
    }
  }

  const calls = Object.values(message.toolCallProcesses ?? {})
    .filter((p) => p && WRITE_TOOLS.has(p.toolName ?? '') && !p.isFailed)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const call of calls) {
    const args = call.toolCall?.args ?? {};
    const named = args.file_path ?? args.filePath ?? args.path ?? args.filename;
    if (typeof named !== 'string' || !named) continue;
    const path = normalizeRefPath(named);
    if (!openablePath(path)) continue;
    // Only an Edit says what changed. A Write carries the new file alone, and
    // whether it replaced one, or how much of it, is not in the call.
    const stats = call.toolName === 'Edit' ? editStats(args.old_string, args.new_string) : undefined;
    written.push(stats ? { path, stats } : { path });
  }

  return { cited, written, embedded };
}

/**
 * The files a turn produced: the ones the reply names, in its order, then the
 * ones only a write tool names. An image the reply embeds is left out, since a
 * card for it would point at what the reader is already looking at.
 */
export function collectTurnFiles(messages: readonly unknown[]): TurnFile[] {
  const parsed: MessageFiles[] = [];
  for (const raw of messages) {
    const message = raw as MessageLike | null;
    if (!message || typeof message !== 'object') continue;
    let files = perMessage.get(message);
    if (!files) {
      files = filesInMessage(message);
      perMessage.set(message, files);
    }
    parsed.push(files);
  }

  const embedded = new Set(parsed.flatMap((p) => p.embedded));
  const byPath = new Map<string, TurnFile>();
  const add = (file: TurnFile) => {
    if (embedded.has(file.path)) return;
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file, stats: file.stats && { ...file.stats } });
      return;
    }
    if (!existing.location && file.location) existing.location = file.location;
    if (!existing.workspaceId && file.workspaceId) existing.workspaceId = file.workspaceId;
    if (file.stats) {
      existing.stats = {
        added: (existing.stats?.added ?? 0) + file.stats.added,
        removed: (existing.stats?.removed ?? 0) + file.stats.removed,
      };
    }
  };

  for (const p of parsed) p.cited.forEach(add);
  for (const p of parsed) p.written.forEach(add);
  return [...byPath.values()];
}
