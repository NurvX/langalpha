import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';

const wsStatus = { value: 'running' };

vi.mock('@/pages/ChatAgent/utils/api', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    readWorkspaceFile: vi.fn(),
    readWorkspaceFileFull: vi.fn(),
    writeWorkspaceFile: vi.fn(async () => ({})),
    downloadWorkspaceFile: vi.fn(),
    downloadWorkspaceFileAsArrayBuffer: vi.fn(),
    triggerFileDownload: vi.fn(),
    listWorkspaceFiles: vi.fn(),
  };
});
vi.mock('@/hooks/useWorkspace', () => ({ useWorkspace: () => ({ data: { status: wsStatus.value, name: 'ws' } }) }));
vi.mock('@/pages/ChatAgent/components/FilePanelMemo', () => ({
  memoMimeForName: () => null,
  useAddToMemo: () => vi.fn(),
  useWorkspaceMemoIndex: () => new Map(),
  useMemoStaleCheck: () => ({ status: null, sandboxText: null, refresh: () => {} }),
  MemoStaleBanner: () => null,
  MemoDiffModal: () => null,
}));
vi.mock('@/pages/ChatAgent/components/SandboxSettingsPanel', () => ({ SandboxSettingsContent: () => null }));
vi.mock('@/pages/ChatAgent/components/viewers/CodeEditor', () => ({
  default: ({ value, fileName }: { value?: string; fileName: string }) => (
    <textarea data-testid="editor" data-file={fileName} value={value ?? ''} readOnly />
  ),
}));

import * as api from '@/pages/ChatAgent/utils/api';
import FilePanel from '@/pages/ChatAgent/components/FilePanel';

const CONTENT: Record<string, string> = {
  'notes.md': '# Notes\n\nMy private notes body.',
  'report.py': 'print("report")\n',
  'results/report2.md': '# Report',
  'results/tools/x.py': 'x = 1\n',
};

beforeEach(() => {
  vi.clearAllMocks();
  wsStatus.value = 'running';
  (api.readWorkspaceFile as ReturnType<typeof vi.fn>).mockImplementation(async (_ws: string, p: string) => {
    if (p in CONTENT) return { content: CONTENT[p], mime: p.endsWith('.md') ? 'text/markdown' : 'text/x-python', truncated: false };
    throw { response: { status: 404, data: { detail: 'File not found' } } };
  });
  (api.readWorkspaceFileFull as ReturnType<typeof vi.fn>).mockImplementation(async (_ws: string, p: string) => ({ content: CONTENT[p] }));
});

describe('FilePanel reference opens', () => {
  it('leaves edit mode when a reference opens another file', async () => {
    const files = ['notes.md', 'report.py'];
    const { rerender } = renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={files} targetFile="notes.md" />,
    );
    await screen.findByText('My private notes body.');
    fireEvent.click(screen.getByTitle('Edit file'));
    await screen.findByTestId('editor');

    rerender(<FilePanel workspaceId="ws" onClose={() => {}} files={files} targetFile="report.py" />);
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('ws', 'report.py'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.queryByTitle('Save (Cmd+S)')).toBeNull();
  });

  it('searches for a known path that is no longer there', async () => {
    (api.listWorkspaceFiles as ReturnType<typeof vi.fn>).mockResolvedValue({ files: ['results/report2.md'], sandbox_ready: true });
    renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={[]} getRecentWritePaths={() => ['report2.md']} targetFile="report2.md" />,
    );
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('ws', 'results/report2.md'));
  });

  it('searches when a stopped workspace reports the path as not backed up', async () => {
    wsStatus.value = 'stopped';
    (api.listWorkspaceFiles as ReturnType<typeof vi.fn>).mockResolvedValue({ files: ['results/tools/x.py'], source: 'database', sandbox_ready: false });
    renderWithProviders(<FilePanel workspaceId="ws" onClose={() => {}} files={[]} targetFile="tools/x.py" />);
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('ws', 'results/tools/x.py'));
  });
});
