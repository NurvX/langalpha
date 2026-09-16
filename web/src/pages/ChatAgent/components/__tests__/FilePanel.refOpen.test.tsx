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
    resolveWorkspaceFile: vi.fn(),
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

const resolveMock = () => api.resolveWorkspaceFile as ReturnType<typeof vi.fn>;

const CONTENT: Record<string, string> = {
  'notes.md': '# Notes\n\nMy private notes body.',
  'report.py': 'print("report")\n',
  'results/report2.md': '# Report',
  'results/tools/x.py': 'x = 1\n',
  // Two namesakes at two depths, which is what makes the reading matter.
  'docs/index.md': [
    '# Index',
    '',
    '[sandbox](/home/workspace/results/report.md)',
    '[qualified](__wsref__/ws/results/report.md)',
    '[sibling](results/report.md)',
    '[up-folder](../data/)',
    '[sub-folder](assets/)',
    '[rooted-folder](__wsref__/ws/results/)',
  ].join('\n'),
  'docs/results/report.md': '# The nested one',
  'results/report.md': '# The rooted one',
};

/** The three namesake files, plus the document whose links point at them. */
const NAMESAKES = ['docs/index.md', 'docs/results/report.md', 'results/report.md'];

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

  it('asks the server for a known path that is no longer there', async () => {
    resolveMock().mockResolvedValue({ status: 'resolved', path: 'results/report2.md', matches: ['results/report2.md'] });
    renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={[]} getRecentWritePaths={() => ['report2.md']} targetFile="report2.md" />,
    );
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('ws', 'results/report2.md'));
    expect(api.resolveWorkspaceFile).toHaveBeenCalledWith('ws', ['report2.md'], ['report2.md']);
  });

  it('asks the server when a stopped workspace reports the path as not backed up', async () => {
    wsStatus.value = 'stopped';
    resolveMock().mockResolvedValue({ status: 'resolved', path: 'results/tools/x.py', matches: ['results/tools/x.py'] });
    renderWithProviders(<FilePanel workspaceId="ws" onClose={() => {}} files={[]} targetFile="tools/x.py" />);
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('ws', 'results/tools/x.py'));
  });

  it('asks the server for a download-only reference the listing still remembers', async () => {
    // A .docx opens with no read at all, so a listing hit is not evidence the
    // path is live: the card would offer to save a name nothing occupies.
    resolveMock().mockResolvedValue({ status: 'resolved', path: 'results/deck.docx', matches: ['results/deck.docx'] });
    renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={['deck.docx']} targetFile="deck.docx" />,
    );
    await waitFor(() => expect(api.resolveWorkspaceFile).toHaveBeenCalledWith('ws', ['deck.docx'], []));
    expect(api.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('lands on the matches when the server cannot pick one', async () => {
    resolveMock().mockResolvedValue({ status: 'ambiguous', matches: ['a/model.py', 'b/model.py'] });
    renderWithProviders(<FilePanel workspaceId="ws" onClose={() => {}} files={['a/model.py', 'b/model.py']} targetFile="model.py" />);
    await screen.findByText(/More than one file matches model\.py/);
    expect(api.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('reads the path as written when the server cannot look yet', async () => {
    resolveMock().mockResolvedValue({ status: 'unavailable', reason: 'sandbox_starting', matches: [] });
    renderWithProviders(<FilePanel workspaceId="ws" onClose={() => {}} files={[]} targetFile="results/new.csv" />);
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('ws', 'results/new.csv'));
  });

  // A reference that named where it starts is not written relative to the file
  // quoting it, so joining it against that file's directory opens a namesake.
  const openDocAndClick = async (linkText: string) => {
    renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={NAMESAKES} targetFile="docs/index.md" />,
    );
    await screen.findByText('Index');
    (api.readWorkspaceFile as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(await screen.findByText(linkText));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return (api.readWorkspaceFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
  };

  it('opens the rooted file a sandbox-absolute link named, not the nearer namesake', async () => {
    const read = await openDocAndClick('sandbox');
    expect(read).toContain('results/report.md');
    expect(read).not.toContain('docs/results/report.md');
  });

  it('opens the rooted file a same-workspace qualifier named', async () => {
    const read = await openDocAndClick('qualified');
    expect(read).toContain('results/report.md');
    expect(read).not.toContain('docs/results/report.md');
  });

  it('still reads a bare link against the directory of the file quoting it', async () => {
    // The control: a reference that named no starting point is the one case
    // where the open file's own directory is the better guess.
    const read = await openDocAndClick('sibling');
    expect(read).toContain('docs/results/report.md');
  });

  // A folder is delegated to the router rather than resolved, because the
  // lookup globs files and a directory never matches one. The router reads the
  // path as given, so the reading a relative folder invited has to be applied
  // before it is handed over, exactly as it is for a file.
  const clickFolder = async (linkText: string) => {
    const onOpenFile = vi.fn();
    renderWithProviders(
      <FilePanel
        workspaceId="ws"
        onClose={() => {}}
        files={NAMESAKES}
        targetFile="docs/index.md"
        onOpenFile={onOpenFile}
      />,
    );
    await screen.findByText('Index');
    fireEvent.click(await screen.findByText(linkText));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return onOpenFile;
  };

  it('opens a climbing folder at the directory it names from the viewed file', async () => {
    expect(await clickFolder('up-folder'))
      .toHaveBeenCalledWith('data/', undefined, undefined);
  });

  it('opens a sibling folder under the directory of the file quoting it', async () => {
    expect(await clickFolder('sub-folder'))
      .toHaveBeenCalledWith('docs/assets/', undefined, undefined);
  });

  it('leaves a rooted folder where it points, not one level down', async () => {
    // The control for the join above: `docs/results/` exists, so joining a
    // reference that named its own starting point would land on it. A sandbox
    // root cannot stand in for the qualifier here, because `isFilePath` asks a
    // rooted destination for an extension and a folder has none.
    expect(await clickFolder('rooted-folder'))
      .toHaveBeenCalledWith('results/', 'ws', undefined);
  });

  it('drops a save that fails after the reader has opened another file', async () => {
    // A save reads the whole body before the anchor click and the client sets
    // no timeout, so the window is open for as long as the request hangs.
    // Opening another file clears `fileError` on the way in and nothing clears
    // it again, so an unguarded rejection replaced the file on screen with the
    // previous one's error, and `not_found` renders without a Retry button.
    const files = ['data.parquet', 'notes.md'];
    let failDownload: (err: unknown) => void = () => {};
    (api.triggerFileDownload as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((_resolve, reject) => { failDownload = reject; }),
    );

    const { rerender } = renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={files} targetFile="data.parquet" />,
    );
    fireEvent.click(await screen.findByText('Download instead'));

    rerender(<FilePanel workspaceId="ws" onClose={() => {}} files={files} targetFile="notes.md" />);
    await screen.findByText('My private notes body.');

    await act(async () => {
      failDownload({ response: { status: 404, data: { detail: 'File not found' } } });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.getByText('My private notes body.')).toBeTruthy();
    expect(screen.queryByText('File not found')).toBeNull();
    expect(screen.queryByText('Cannot preview this file')).toBeNull();
  });

  it('still reports a save that fails while its own file is on screen', async () => {
    // The control for the guard above: the reader has not moved, so the failure
    // belongs to the file being looked at and is the one thing that tells them
    // the download they asked for did not happen.
    const files = ['data.parquet', 'notes.md'];
    let failDownload: (err: unknown) => void = () => {};
    (api.triggerFileDownload as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((_resolve, reject) => { failDownload = reject; }),
    );

    renderWithProviders(
      <FilePanel workspaceId="ws" onClose={() => {}} files={files} targetFile="data.parquet" />,
    );
    fireEvent.click(await screen.findByText('Download instead'));

    await act(async () => {
      failDownload({ response: { status: 404, data: { detail: 'File not found' } } });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(await screen.findByText('File not found')).toBeTruthy();
  });
});
