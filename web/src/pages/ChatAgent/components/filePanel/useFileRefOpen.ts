import { useCallback, useRef } from 'react';
import { basename, isSystemPath, linkCandidates, resolveExact } from '../../utils/fileRefResolver';
import { normalizeAgentPath } from '../../utils/agentPaths';
import type { FileLocation } from '../../utils/fileLocation';
import type { FileRefResolution } from './types';
import { DOWNLOAD_ONLY_EXTENSIONS, getFileExtension } from './fileMeta';
import { categorizeFileError, type FileError } from './fileErrors';
import type { FileBodyCache } from './useFileBody';
import type { FileTabsApi } from './useFileTabs';

export interface OpenAt {
  pin?: boolean;
  location?: FileLocation | null;
}

interface RefOpenArgs {
  tabs: FileTabsApi;
  cache: FileBodyCache;
  /** Which open files the agent has rewritten since a tab read them. */
  hasChanged: (path: string) => boolean;
  files: string[];
  workspaceStatus?: string;
  resolveFileFn: ((candidates: string[], recentWrites: string[]) => Promise<FileRefResolution>) | null;
  getRecentWritePaths?: (() => string[]) | null;
  /** Clear whatever the panel is showing over the viewer before a file lands. */
  onBeforeOpen: () => void;
  /** A reference arrives from outside the tree, so it leaves no filter behind. */
  clearSearch: () => void;
  /** Nothing certain matched: show the tree filtered to the name, with the candidates. */
  onLandOnSearch: (ref: string, name: string, matches: string[]) => void;
  /** Re-read the file already open, which is what a retry with no reference does. */
  refetch: () => void;
}

/**
 * Turning a reference into an open tab.
 *
 * A reference from chat or from inside a document may not name a real path —
 * the agent moves files, writes relative links, and quotes names it never
 * wrote. The order here is what keeps the common case free: an exact match or
 * an absolute path is read straight away, and only a miss pays for the
 * server's lookup.
 */
export function useFileRefOpen({
  tabs, cache, hasChanged, files, workspaceStatus, resolveFileFn, getRecentWritePaths,
  onBeforeOpen, clearSearch, onLandOnSearch, refetch,
}: RefOpenArgs) {
  // Bumped by every reference open, so a slow lookup cannot land after the
  // reader has already clicked something else.
  const refSeq = useRef(0);
  const unresolved = useRef<{ rawRef: string; fromFile: string | null; location: FileLocation | null } | null>(null);

  /** Open a file in a tab, having first proved its bytes are readable. */
  const openFileAt = useCallback(async (path: string, { pin = false, location = null }: OpenAt = {}): Promise<FileError | null> => {
    unresolved.current = null;
    onBeforeOpen();
    tabs.openFile(path, { pin, location });
    if (DOWNLOAD_ONLY_EXTENSIONS.has(getFileExtension(path))) return { category: 'binary_file' };
    if (hasChanged(path)) cache.invalidate(path);
    try {
      await cache.fetchBody(path);
      return null;
    } catch (err) {
      console.error(`[FilePanel] Failed to load ${path}:`, err);
      return categorizeFileError(err, workspaceStatus);
    }
  }, [tabs, cache, hasChanged, workspaceStatus, onBeforeOpen]);

  const openFileRef = useCallback(async (
    rawRef: string,
    { fromFile = null, location = null, pin = false }: { fromFile?: string | null; location?: FileLocation | null; pin?: boolean } = {},
  ) => {
    const candidates = fromFile ? linkCandidates(rawRef, fromFile) : [normalizeAgentPath(rawRef)];
    const primary = candidates[0];
    if (!primary) return;
    clearSearch();
    const tried = new Set<string>();
    // True once the path opened, or failed for a reason a search cannot fix.
    const landed = async (path: string) => {
      // A download-only file opens with no read, so opening one proves nothing
      // about the path: a moved .docx would sit behind a download card built on
      // a name the listing still remembers. Only the lookup settles it.
      if (resolveFileFn && DOWNLOAD_ONLY_EXTENSIONS.has(getFileExtension(path))) return false;
      tried.add(path);
      const category = (await openFileAt(path, { location, pin }))?.category;
      return category !== 'not_found' && category !== 'not_backed_up';
    };
    const writes = getRecentWritePaths?.() ?? [];

    // A known path can still be stale (the agent moved it), so a miss falls through.
    const exact = resolveExact(candidates, files, writes);
    if (exact && await landed(exact)) return;
    // Absolute and system paths are not in the default listing and the agent
    // names them exactly, so read them before asking.
    const direct = candidates.find((c) => c.startsWith('/') || isSystemPath(c));
    if (direct && !tried.has(direct) && await landed(direct)) return;
    if (!resolveFileFn) {
      if (!tried.has(primary)) void openFileAt(primary, { location, pin });
      return;
    }

    const seq = ++refSeq.current;
    let result: FileRefResolution | null = null;
    try {
      result = await resolveFileFn(candidates, writes);
    } catch (err) {
      console.error('[FilePanel] File reference lookup failed:', err);
    }
    if (seq !== refSeq.current) return;

    if (!result || result.status === 'unavailable') {
      // Retrying the path alone asks the same unanswerable question: the lookup
      // is the only thing that knows where the file is, and the lookup is what
      // was unavailable. Keeping the reference is what lets a retry resolve.
      await openFileAt(primary, { location, pin });
      if (seq === refSeq.current) unresolved.current = { rawRef, fromFile, location };
      return;
    }
    if (result.status === 'resolved' && result.path) return void openFileAt(result.path, { location, pin });
    // Name the reference as written; the joined reading is only our guess.
    const named = candidates[candidates.length - 1];
    onLandOnSearch(named, basename(named), result.matches);
  }, [openFileAt, clearSearch, onLandOnSearch, resolveFileFn, getRecentWritePaths, files]);

  /** The error card's retry: re-ask the lookup where one was owed, else re-read. */
  const retryOpen = useCallback(() => {
    const ref = unresolved.current;
    if (ref) return void openFileRef(ref.rawRef, { fromFile: ref.fromFile, location: ref.location });
    refetch();
  }, [openFileRef, refetch]);

  return { openFileAt, openFileRef, retryOpen };
}
