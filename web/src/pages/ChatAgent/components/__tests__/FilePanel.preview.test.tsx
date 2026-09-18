import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { tabsStorageKey } from '@/pages/ChatAgent/components/filePanel/useFileTabs';

vi.mock('@/pages/ChatAgent/utils/api', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    readWorkspaceFile: vi.fn(async () => ({ content: '# Notes', mime: 'text/markdown', truncated: false })),
    readWorkspaceFileFull: vi.fn(async () => ({ content: '# Notes' })),
    writeWorkspaceFile: vi.fn(async () => ({})),
    downloadWorkspaceFileAsArrayBuffer: vi.fn(),
    triggerFileDownload: vi.fn(),
    resolveWorkspaceFile: vi.fn(),
    getPreviewUrl: vi.fn(async () => ({ url: 'https://8050-sandbox.example.com/' })),
  };
});
vi.mock('@/hooks/useWorkspace', () => ({ useWorkspace: () => ({ data: { status: 'running', name: 'ws' } }) }));
vi.mock('@/pages/ChatAgent/components/FilePanelMemo', () => ({
  memoMimeForName: () => null,
  useAddToMemo: () => vi.fn(),
  useWorkspaceMemoIndex: () => new Map(),
  useMemoStaleCheck: () => ({ status: null, sandboxText: null, refresh: () => {} }),
  MemoStaleBanner: () => null,
  MemoDiffModal: () => null,
}));
vi.mock('@/pages/ChatAgent/components/SandboxSettingsPanel', () => ({ SandboxSettingsContent: () => null }));

import * as api from '@/pages/ChatAgent/utils/api';
import FilePanel from '@/pages/ChatAgent/components/FilePanel';

const previewUrl = () => api.getPreviewUrl as ReturnType<typeof vi.fn>;
const FILES = ['notes.md', 'app.py'];
const DASHBOARD = { port: 8050, title: 'Dashboard', command: 'python app.py', seq: 1 };

const panel = (props: Record<string, unknown> = {}) => (
  <FilePanel workspaceId="ws" onClose={() => {}} files={FILES} {...props} />
);

/** Whether the running app's pane is behind another tab rather than unmounted. */
const hiddenPane = () =>
  screen.getByTitle('Preview on port 8050').closest('.file-panel-preview-pane')!.hasAttribute('hidden');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  previewUrl().mockResolvedValue({ url: 'https://8050-sandbox.example.com/' });
});

describe('FilePanel running apps', () => {
  it('opens a preview target as a tab and mints a URL for it', async () => {
    renderWithProviders(panel({ targetPreview: DASHBOARD }));

    await waitFor(() => expect(previewUrl()).toHaveBeenCalledWith('ws', 8050, 'python app.py', false));
    const frame = await screen.findByTitle('Preview on port 8050');
    expect(frame.getAttribute('src')).toBe('https://8050-sandbox.example.com/');
    expect(within(screen.getByRole('tablist')).getByText('Dashboard')).toBeTruthy();
    // The app's own actions live in the crumb row, not in a second header.
    expect(screen.getByTitle('Open in browser')).toBeTruthy();
  });

  it('hangs a path suffix off the signed URL', async () => {
    renderWithProviders(panel({ targetPreview: { ...DASHBOARD, path: '/timeline.html' } }));

    const frame = await screen.findByTitle('Preview on port 8050');
    expect(frame.getAttribute('src')).toBe('https://8050-sandbox.example.com/timeline.html');
  });

  it('lists every running app in the tree, and a click brings its tab forward', async () => {
    const { container, rerender } = renderWithProviders(panel({ targetPreview: DASHBOARD }));
    await screen.findByTitle('Preview on port 8050');

    // Open a file over it, then come back through the tree.
    rerender(panel({ targetPreview: DASHBOARD, targetFile: 'notes.md' }));
    await waitFor(() => expect(hiddenPane()).toBe(true));

    const group = container.querySelector('.file-panel-preview-group')!;
    fireEvent.click(within(group as HTMLElement).getByTitle('Dashboard :8050'));
    await waitFor(() => expect(hiddenPane()).toBe(false));
    // Coming back to an app already resolved must not mint a second URL.
    expect(previewUrl()).toHaveBeenCalledTimes(1);
  });

  it('keeps a running app loaded while another tab is in front', async () => {
    const { rerender } = renderWithProviders(panel({ targetPreview: DASHBOARD }));
    const frame = await screen.findByTitle('Preview on port 8050');

    rerender(panel({ targetPreview: DASHBOARD, targetFile: 'notes.md' }));
    await waitFor(() => expect(hiddenPane()).toBe(true));

    // Same element, still in the tree — a tab switch must not reload the server.
    expect(screen.getByTitle('Preview on port 8050')).toBe(frame);
  });

  it('re-mints the URL for a tab restored from storage, which stored none', async () => {
    localStorage.setItem(tabsStorageKey('ws'), JSON.stringify({
      tabs: [{ path: null, kind: 'preview', preview: false, port: 8050, title: 'Dashboard' }],
      active: 0,
    }));
    renderWithProviders(panel());

    await waitFor(() => expect(previewUrl()).toHaveBeenCalledWith('ws', 8050, undefined, false));
    expect(await screen.findByTitle('Preview on port 8050')).toBeTruthy();
  });

  it('restarts the server behind the port on Refresh', async () => {
    renderWithProviders(panel({ targetPreview: DASHBOARD }));
    await screen.findByTitle('Preview on port 8050');

    fireEvent.click(screen.getByTitle('Reload app'));
    await waitFor(() => expect(previewUrl()).toHaveBeenCalledWith('ws', 8050, 'python app.py', true));
  });

  it('offers a way back rather than a blank frame when the server is gone', async () => {
    previewUrl().mockRejectedValue(new Error('no listener'));
    renderWithProviders(panel({ targetPreview: DASHBOARD }));

    expect(await screen.findByText('Server offline')).toBeTruthy();
    // A dead port is not retried on every visit — Refresh is the retry.
    await waitFor(() => expect(previewUrl()).toHaveBeenCalledTimes(1));
  });
});
