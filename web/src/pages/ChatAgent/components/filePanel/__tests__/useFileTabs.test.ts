import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFileTabs, tabsStorageKey, threadTabsStorageKey } from '../useFileTabs';

const paths = (tabs: { path: string | null }[]) => tabs.map((t) => t.path);

beforeEach(() => localStorage.clear());

describe('useFileTabs preview semantics', () => {
  it('opens on a single empty tab', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    expect(paths(result.current.tabs)).toEqual([null]);
    expect(result.current.activeTab.path).toBeNull();
  });

  it('reuses the one preview tab so browsing never piles tabs up', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md'));
    act(() => result.current.openFile('b.md'));

    expect(paths(result.current.tabs)).toEqual(['b.md']);
    expect(result.current.activeTab.preview).toBe(true);
  });

  it('keeps a pinned tab when the next file is only previewed', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openFile('b.md'));

    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
    expect(result.current.activeTab.path).toBe('b.md');
  });

  it('fills the empty tab the user is looking at, not the preview elsewhere', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md'));
    act(() => result.current.newTab());
    act(() => result.current.openFile('b.md'));

    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
    expect(result.current.activeTab.path).toBe('b.md');
    expect(result.current.tabs[0].preview).toBe(true);
  });

  it('opens beside the active tab rather than at the end of the strip', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openFile('c.md', { pin: true }));
    act(() => result.current.activate(result.current.tabs[0].id));
    act(() => result.current.openFile('b.md', { pin: true }));

    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('pins the preview tab in place rather than opening a second one', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md'));
    act(() => result.current.pinTab(result.current.activeId));
    act(() => result.current.openFile('b.md'));

    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
  });

  it('activates the tab a file already has instead of opening another', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openFile('b.md', { pin: true }));
    act(() => result.current.openFile('a.md'));

    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
    expect(result.current.activeTab.path).toBe('a.md');
    // Re-opening as a preview must not un-pin what was already kept.
    expect(result.current.activeTab.preview).toBe(false);
  });

  it('replays a location asked for twice, so a repeat click highlights again', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { location: { line: 4 } }));
    const first = result.current.activeTab.locationSeq;
    act(() => result.current.openFile('a.md', { location: { line: 4 } }));

    expect(result.current.activeTab.locationSeq).toBe(first + 1);
  });

  it('keeps each tab its own location so switching back returns there', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true, location: { line: 9 } }));
    const aId = result.current.activeId;
    act(() => result.current.openFile('b.md', { pin: true, location: { page: 3 } }));
    act(() => result.current.activate(aId));

    expect(result.current.activeTab.location).toEqual({ line: 9 });
  });
});

describe('useFileTabs running apps', () => {
  it('names a preview tab by its port when the agent gave it no title', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openPreview({ port: 8050 }));

    expect(result.current.activeTab.kind).toBe('preview');
    expect(result.current.activeTab.port).toBe(8050);
    expect(result.current.activeTab.path).toBeNull();
    // An app is not on loan the way a browsed file is — it stays until closed.
    expect(result.current.activeTab.preview).toBe(false);
  });

  it('gives a port one tab however often it is opened', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openPreview({ port: 8050, title: 'Dashboard' }));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openPreview({ port: 8050 }));

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTab.port).toBe(8050);
    // Re-opening by port alone must not blank the title the agent gave it.
    expect(result.current.activeTab.title).toBe('Dashboard');
  });

  it('gives two ports two tabs, opened beside the active one', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openPreview({ port: 8050 }));
    act(() => result.current.openPreview({ port: 8051 }));

    expect(result.current.tabs.map((t) => t.port)).toEqual([undefined, 8050, 8051]);
    expect(result.current.activeTab.port).toBe(8051);
  });

  it('fills the empty tab the reader is looking at', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openPreview({ port: 8050 }));

    expect(result.current.tabs).toHaveLength(1);
  });

  it('stores the port and its labels, never the signed URL', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openPreview({
      port: 8050, title: 'Dashboard', path: '/timeline.html', command: 'python app.py',
    }));

    expect(JSON.parse(localStorage.getItem(tabsStorageKey('ws'))!)).toEqual({
      tabs: [{
        path: null, kind: 'preview', preview: false, port: 8050,
        title: 'Dashboard', previewPath: '/timeline.html', command: 'python app.py',
      }],
      active: 0,
    });
  });

  it('brings the start command back with a restored preview tab', () => {
    localStorage.setItem(tabsStorageKey('ws'), JSON.stringify({
      tabs: [{ path: null, kind: 'preview', preview: false, port: 8050, command: 'python app.py' }],
      active: 0,
    }));
    const { result } = renderHook(() => useFileTabs('ws'));
    expect(result.current.activeTab.port).toBe(8050);
    expect(result.current.activeTab.command).toBe('python app.py');
  });

  it('reopens a running app as a port to mint against', () => {
    const first = renderHook(() => useFileTabs('ws'));
    act(() => first.result.current.openPreview({ port: 8050, title: 'Dashboard' }));
    first.unmount();

    const { result } = renderHook(() => useFileTabs('ws'));
    expect(result.current.activeTab.kind).toBe('preview');
    expect(result.current.activeTab.port).toBe(8050);
    expect(result.current.activeTab.title).toBe('Dashboard');
  });

  it('drops a stored preview tab that names no port', () => {
    localStorage.setItem(tabsStorageKey('ws'), JSON.stringify({
      tabs: [{ path: null, kind: 'preview', preview: false }],
      active: 0,
    }));
    const { result } = renderHook(() => useFileTabs('ws'));

    expect(paths(result.current.tabs)).toEqual([null]);
    expect(result.current.activeTab.kind).toBeUndefined();
  });
});

describe('useFileTabs closing', () => {
  it('leaves an empty tab rather than a panel with no way back', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md'));
    act(() => result.current.closeTab(result.current.activeId));

    expect(paths(result.current.tabs)).toEqual([null]);
    expect(result.current.activeTab.path).toBeNull();
  });

  it('hands the active slot to the tab that takes the closed one’s place', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openFile('b.md', { pin: true }));
    const bId = result.current.activeId;
    act(() => result.current.openFile('c.md', { pin: true }));
    act(() => result.current.closeTab(bId));

    expect(paths(result.current.tabs)).toEqual(['a.md', 'c.md']);
    expect(result.current.activeTab.path).toBe('c.md');
  });

  it('leaves the active tab alone when another one closes', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    const aId = result.current.activeId;
    act(() => result.current.openFile('b.md', { pin: true }));
    act(() => result.current.closeTab(aId));

    expect(result.current.activeTab.path).toBe('b.md');
  });
});

describe('useFileTabs persistence', () => {
  it('stores names and the active index, never the bytes', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openFile('b.md'));

    expect(JSON.parse(localStorage.getItem(tabsStorageKey('ws'))!)).toEqual({
      tabs: [{ path: 'a.md', preview: false }, { path: 'b.md', preview: true }],
      active: 1,
    });
  });

  it('reopens the strip, and the tab that was in front, on a fresh mount', () => {
    const first = renderHook(() => useFileTabs('ws'));
    act(() => first.result.current.openFile('a.md', { pin: true }));
    act(() => first.result.current.openFile('b.md', { pin: true }));
    act(() => first.result.current.activate(first.result.current.tabs[0].id));
    first.unmount();

    const { result } = renderHook(() => useFileTabs('ws'));
    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
    expect(result.current.activeTab.path).toBe('a.md');
  });

  it('keeps the empty tab out of storage', () => {
    const { result } = renderHook(() => useFileTabs('ws'));
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.newTab());

    expect(JSON.parse(localStorage.getItem(tabsStorageKey('ws'))!).tabs).toEqual([
      { path: 'a.md', preview: false },
    ]);
  });

  it('gives each workspace its own strip', () => {
    const ws = renderHook(() => useFileTabs('ws'));
    act(() => ws.result.current.openFile('a.md', { pin: true }));
    ws.unmount();

    const { result } = renderHook(() => useFileTabs('other'));
    expect(paths(result.current.tabs)).toEqual([null]);
  });

  it('persists nothing for a share, which has no workspace of its own', () => {
    const { result } = renderHook(() => useFileTabs(''));
    act(() => result.current.openFile('a.md', { pin: true }));

    expect(localStorage.length).toBe(0);
    expect(paths(result.current.tabs)).toEqual(['a.md']);
  });

  it('starts clean on a strip that cannot be read back', () => {
    localStorage.setItem(tabsStorageKey('ws'), '{not json');
    const { result } = renderHook(() => useFileTabs('ws'));

    expect(paths(result.current.tabs)).toEqual([null]);
  });
});

describe('useFileTabs thread scope', () => {
  it('keeps one strip per thread and seeds a new thread from the workspace strip', () => {
    const { result, rerender } = renderHook(
      ({ thread }: { thread: string | null }) => useFileTabs('ws', thread),
      { initialProps: { thread: 't1' } },
    );
    act(() => result.current.openFile('a.md', { pin: true }));
    act(() => result.current.openFile('b.md', { pin: true }));
    expect(JSON.parse(localStorage.getItem(threadTabsStorageKey('ws', 't1'))!).tabs.map((t: { path: string }) => t.path))
      .toEqual(['a.md', 'b.md']);
    // The workspace strip mirrors whatever was shown last.
    expect(JSON.parse(localStorage.getItem(tabsStorageKey('ws'))!).tabs).toHaveLength(2);

    // A thread with nothing saved starts from that mirror, then diverges.
    rerender({ thread: 't2' });
    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
    act(() => result.current.closeTab(result.current.tabs[0].id));
    expect(paths(result.current.tabs)).toEqual(['b.md']);

    // Coming back to the first thread restores exactly what it had.
    rerender({ thread: 't1' });
    expect(paths(result.current.tabs)).toEqual(['a.md', 'b.md']);
    rerender({ thread: 't2' });
    expect(paths(result.current.tabs)).toEqual(['b.md']);
  });

  it('carries the strip over when a fresh chat gets its thread id', () => {
    const { result, rerender } = renderHook(
      ({ thread }: { thread: string | null }) => useFileTabs('ws', thread),
      { initialProps: { thread: null as string | null } },
    );
    act(() => result.current.openFile('a.md', { pin: true }));
    const id = result.current.activeTab.id;
    rerender({ thread: 't9' });
    // Same tab objects, not a re-read: a location or scroll it held survives.
    expect(result.current.activeTab.id).toBe(id);
    expect(paths(result.current.tabs)).toEqual(['a.md']);
    expect(localStorage.getItem(threadTabsStorageKey('ws', 't9'))).not.toBeNull();
  });

  it('reads a new workspace’s own seed rather than carrying the old strip across', () => {
    localStorage.setItem(tabsStorageKey('ws2'), JSON.stringify({ tabs: [{ path: 'z.md', preview: false }], active: 0 }));
    const { result, rerender } = renderHook(
      ({ ws }: { ws: string }) => useFileTabs(ws, 't1'),
      { initialProps: { ws: 'ws' } },
    );
    act(() => result.current.openFile('a.md', { pin: true }));
    rerender({ ws: 'ws2' });
    expect(paths(result.current.tabs)).toEqual(['z.md']);
  });
});
