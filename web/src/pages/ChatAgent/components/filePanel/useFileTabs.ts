import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileLocation } from '../../utils/fileLocation';

/**
 * One open tab. `path` is null for the empty tab, which is the panel's landing
 * surface and its upload drop target.
 *
 * `preview` is the VS Code rule: a single click in the tree lands in the one
 * italic tab, so browsing never piles up tabs, and anything that says the file
 * is being worked with — a double click, entering edit mode, adding it to the
 * context — pins it.
 */
export interface FileTab {
  id: string;
  path: string | null;
  /**
   * A tab that is not a file: the workspace settings, or a running app served
   * from the sandbox. `kind: 'preview'` and the `preview` flag below are
   * unrelated — one is what the tab shows, the other is how long it stays.
   */
  kind?: 'settings' | 'preview';
  /** Preview tabs: the sandbox port the dev server listens on. Identifies the tab. */
  port?: number;
  /** Preview tabs: what the agent called the app, when it said. */
  title?: string;
  /** Preview tabs: a path suffix on the served app, e.g. `/timeline.html`. */
  previewPath?: string;
  /** Preview tabs: how the agent started the server, so a restored tab can restart an idle port. */
  command?: string;
  preview: boolean;
  /** Where a reference pointed inside this file, kept so switching back returns there. */
  location: FileLocation | null;
  /** Bumped whenever a location arrives, so asking for the same line twice replays the highlight. */
  locationSeq: number;
}

export interface OpenFileOptions {
  /** Open as a kept tab rather than the reused preview one. */
  pin?: boolean;
  location?: FileLocation | null;
}

interface TabsState {
  tabs: FileTab[];
  activeId: string;
}

interface PersistedTab {
  path: string | null;
  kind?: 'settings' | 'preview';
  preview: boolean;
  port?: number;
  title?: string;
  previewPath?: string;
  command?: string;
}

/** What a preview tab is opened with. The port is the identity; the rest is labelling. */
export interface PreviewTabSpec {
  port: number;
  title?: string;
  /** A path suffix on the served app, e.g. `/timeline.html`. */
  path?: string;
  command?: string;
}

/** A tab that carries something other than a file — settings, or a running app. */
const isNamed = (t: { path?: string | null; kind?: string }) => !!t.path || !!t.kind;

interface PersistedState {
  tabs: PersistedTab[];
  active: number;
}

/**
 * The workspace's strip: what the panel last showed there, in any thread. It is
 * the seed a thread with no strip of its own starts from, so a new conversation
 * about the same files opens on them rather than on nothing.
 */
export function tabsStorageKey(workspaceId: string): string {
  return `filePanel.tabs.${workspaceId}`;
}

/** A thread's own strip, which wins over the workspace seed once it exists. */
export function threadTabsStorageKey(workspaceId: string, threadId: string): string {
  return `filePanel.tabs.${workspaceId}.t.${threadId}`;
}

let nextId = 0;
const newId = () => `t${++nextId}`;

function emptyTab(): FileTab {
  return { id: newId(), path: null, preview: false, location: null, locationSeq: 0 };
}

function blankState(): TabsState {
  const tab = emptyTab();
  return { tabs: [tab], activeId: tab.id };
}

function readPersisted(key: string | null): TabsState | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as PersistedState;
    if (!Array.isArray(saved?.tabs)) return null;
    const tabs: FileTab[] = saved.tabs
      .filter((t) => (typeof t?.path === 'string' && !!t.path)
        || t?.kind === 'settings'
        || (t?.kind === 'preview' && Number.isFinite(t?.port)))
      .map((t) => ({
        id: newId(), path: t.kind ? null : t.path, kind: t.kind,
        // The signed URL a preview runs on is short-lived, so it is never
        // stored: the tab comes back as a port, and activating it mints a new one.
        port: t.kind === 'preview' ? t.port : undefined,
        title: t.kind === 'preview' ? t.title : undefined,
        previewPath: t.kind === 'preview' ? t.previewPath : undefined,
        command: t.kind === 'preview' ? t.command : undefined,
        preview: !!t.preview, location: null, locationSeq: 0,
      }));
    if (!tabs.length) return null;
    const at = Number.isInteger(saved.active) ? Math.min(Math.max(saved.active, 0), tabs.length - 1) : 0;
    return { tabs, activeId: tabs[at].id };
  } catch {
    return null;
  }
}

/**
 * Open a file, or activate the tab already showing it.
 *
 * The tab being looked at is always the target: an un-pinned open lands in
 * the active tab when it is empty or a preview, else in whichever tab already
 * carries the preview, else in a new tab beside the active one. A pinned open
 * fills an empty active tab and otherwise opens beside it, so pinning one file
 * and clicking another never overwrites the first.
 */
function openIn(state: TabsState, path: string, { pin = false, location = null }: OpenFileOptions): TabsState {
  const { tabs, activeId } = state;
  const stamp = (t: FileTab): FileTab => ({
    ...t,
    location: location ?? t.location,
    locationSeq: location ? t.locationSeq + 1 : t.locationSeq,
  });

  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    return {
      tabs: tabs.map((t) => (t.id !== existing.id ? t : stamp({ ...t, preview: pin ? false : t.preview }))),
      activeId: existing.id,
    };
  }

  const active = tabs.find((t) => t.id === activeId);
  const reusable = active && !active.kind && (!active.path || (!pin && active.preview))
    ? active
    : !pin
      ? tabs.find((t) => t.preview && t.path)
      : undefined;
  if (reusable) {
    return {
      tabs: tabs.map((t) => (t.id !== reusable.id ? t : stamp({ ...t, path, preview: !pin }))),
      activeId: reusable.id,
    };
  }

  const fresh = stamp({ id: newId(), path, preview: !pin, location: null, locationSeq: 0 });
  const at = tabs.findIndex((t) => t.id === activeId);
  const next = [...tabs];
  next.splice(at < 0 ? tabs.length : at + 1, 0, fresh);
  return { tabs: next, activeId: fresh.id };
}

/**
 * Land a non-file tab: activate the one that already exists, else fill an empty
 * active tab, else open beside the active one. The settings tab is the
 * singleton of its kind; a preview is the singleton of its port.
 */
function openSingletonIn(state: TabsState, match: (t: FileTab) => boolean, fields: Partial<FileTab>): TabsState {
  const existing = state.tabs.find(match);
  if (existing) {
    return {
      tabs: state.tabs.map((t) => (t.id !== existing.id ? t : { ...t, ...fields })),
      activeId: existing.id,
    };
  }
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active && !active.path && !active.kind) {
    return { ...state, tabs: state.tabs.map((t) => (t.id !== active.id ? t : { ...t, ...fields, preview: false })) };
  }
  const fresh: FileTab = { ...emptyTab(), ...fields, preview: false };
  const at = state.tabs.findIndex((t) => t.id === state.activeId);
  const tabs = [...state.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, fresh);
  return { tabs, activeId: fresh.id };
}

/** Closing the last tab leaves the empty one rather than a panel with no way back. */
function closeIn(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (!tabs.length) return blankState();
  const activeId = id === state.activeId ? (tabs[at] ?? tabs[at - 1]).id : state.activeId;
  return { tabs, activeId };
}

/**
 * The panel's open tabs.
 *
 * Tabs persist per thread and come back as names only. Nothing is read until
 * a tab is activated, so reopening a thread with eight tabs costs one
 * request, not eight — the bodies live in the React Query cache, keyed by path,
 * and a tab is only a claim on one.
 *
 * A thread without a strip of its own inherits the workspace's: a new
 * conversation is usually about the files the last one left open. Until a
 * fresh chat has a thread id (its first message mints one) the strip is the
 * workspace's, and it carries over unchanged when the id arrives.
 */
export function useFileTabs(workspaceId: string, threadId?: string | null) {
  // No key for an adapter mount (a share has no workspace of its own), so two
  // shares cannot inherit each other's tab strip.
  const seedKey = workspaceId ? tabsStorageKey(workspaceId) : null;
  const storageKey = workspaceId && threadId ? threadTabsStorageKey(workspaceId, threadId) : seedKey;

  const [state, setState] = useState<TabsState>(() => readPersisted(storageKey) ?? readPersisted(seedKey) ?? blankState());

  // A thread switch is a different strip, not a reordering of this one. A
  // thread with nothing saved keeps what is on screen when the workspace is the
  // same (that is the seed, and keeping it in memory keeps its locations too);
  // a new workspace reads its own seed.
  const lastKey = useRef(storageKey);
  const lastSeed = useRef(seedKey);
  useEffect(() => {
    if (lastKey.current === storageKey) return;
    const sameWorkspace = lastSeed.current === seedKey;
    lastKey.current = storageKey;
    lastSeed.current = seedKey;
    setState((prev) => readPersisted(storageKey)
      ?? (sameWorkspace ? prev : (readPersisted(seedKey) ?? blankState())));
  }, [storageKey, seedKey]);

  useEffect(() => {
    if (!storageKey) return;
    const named = state.tabs.filter(isNamed);
    const active = Math.max(0, named.findIndex((t) => t.id === state.activeId));
    const json = JSON.stringify({
      tabs: named.map((t) => ({
        path: t.path, kind: t.kind, preview: t.preview,
        ...(t.kind === 'preview' && {
          port: t.port, title: t.title, previewPath: t.previewPath, command: t.command,
        }),
      })),
      active,
    } satisfies PersistedState);
    try {
      localStorage.setItem(storageKey, json);
      // The seed is whatever strip was shown last, in whichever thread.
      if (seedKey && seedKey !== storageKey) localStorage.setItem(seedKey, json);
    } catch { /* a full or blocked store is not worth failing a render over */ }
  }, [state, storageKey, seedKey]);

  const activate = useCallback((id: string) => {
    setState((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id }));
  }, []);

  const newTab = useCallback(() => {
    setState((prev) => {
      const tab = emptyTab();
      return { tabs: [...prev.tabs, tab], activeId: tab.id };
    });
  }, []);

  const openFile = useCallback((path: string, options: OpenFileOptions = {}) => {
    setState((prev) => openIn(prev, path, options));
  }, []);

  const openSettings = useCallback(
    () => setState((prev) => openSingletonIn(prev, (t) => t.kind === 'settings', { kind: 'settings' })),
    [],
  );

  /**
   * One tab per port: a second open of a running app comes back to the tab it
   * already has. A re-open that names nothing keeps the labelling the tab has,
   * so the tree's own click cannot blank a title the agent gave it.
   */
  const openPreview = useCallback(({ port, title, path, command }: PreviewTabSpec) => {
    setState((prev) => openSingletonIn(prev, (t) => t.kind === 'preview' && t.port === port, {
      kind: 'preview', path: null, port,
      ...(title !== undefined && { title }),
      ...(path !== undefined && { previewPath: path }),
      ...(command !== undefined && { command }),
    }));
  }, []);

  const pinTab = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === id && t.preview ? { ...t, preview: false } : t)),
    }));
  }, []);

  const closeTab = useCallback((id: string) => setState((prev) => closeIn(prev, id)), []);

  /** Drop a tab's location — the focus chip's dismiss, which must survive a tab switch. */
  const clearLocation = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, location: null } : t)),
    }));
  }, []);

  const activeTab = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
  const openPaths = useMemo(
    () => new Set(state.tabs.map((t) => t.path).filter((p): p is string => !!p)),
    [state.tabs],
  );

  return {
    tabs: state.tabs,
    activeTab,
    activeId: activeTab.id,
    openPaths,
    activate,
    openFile,
    pinTab,
    closeTab,
    newTab,
    openSettings,
    openPreview,
    clearLocation,
  };
}

export type FileTabsApi = ReturnType<typeof useFileTabs>;
