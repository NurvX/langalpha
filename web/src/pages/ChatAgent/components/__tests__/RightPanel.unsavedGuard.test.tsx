/**
 * RightPanel's unsaved-edit guard. The Files panel keeps its drafts in the
 * mount, so closing the panel or leaving for Memory/Memo/Sources/Status used
 * to throw an unsaved edit away without a word. Both paths now ask the
 * question closing a single file tab already asked.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '@/test/utils';
import RightPanel from '../RightPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Stands in for the real panel's half of the contract: it reports whether a
// draft is open while it is mounted, and reports clean as it goes.
const { dirty } = vi.hoisted(() => ({ dirty: { current: true } }));
vi.mock('../FilePanel', () => {
  const FilePanelStub = ({ onDirtyChange, onSwitchToMemoTab }: {
    onDirtyChange?: ((d: boolean) => void) | null;
    onSwitchToMemoTab?: (() => void) | null;
  }) => {
    React.useEffect(() => {
      onDirtyChange?.(dirty.current);
      return () => onDirtyChange?.(false);
    }, [onDirtyChange]);
    return (
      <div data-testid="file-panel">
        files
        <button onClick={() => onSwitchToMemoTab?.()}>view in memo</button>
      </div>
    );
  };
  return { default: FilePanelStub };
});
vi.mock('../MemoryPanel', () => ({
  default: () => <div data-testid="memory-panel">memory</div>,
}));
vi.mock('../MemoPanel', () => ({
  default: () => <div data-testid="memo-panel">memo</div>,
}));

vi.mock('@/components/ui/animated-tabs', () => ({
  AnimatedTabs: ({ tabs, value, onChange }: {
    tabs: { id: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
  }) => (
    <div data-testid="tabs" data-active={value}>
      {tabs.map((t) => (
        <button key={t.id} data-tab={t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  ),
}));

const closeButton = () => screen.getByTitle('rightPanel.close');
const memoryTab = () => screen.getByRole('button', { name: 'rightPanel.tabs.memory' });
const activeTab = () => screen.getByTestId('tabs').getAttribute('data-active');

/**
 * Flush the effect that reports the draft. The guard reads state the panel
 * sets on mount and clears on unmount, so a click before that has committed
 * would be testing the render in between rather than the guard.
 */
const settle = () => act(async () => {});

/** Mounts the panel on Files and waits for the lazy body to arrive. */
const mountOnFiles = async (onClose: () => void) => {
  renderWithProviders(<RightPanel workspaceId="ws-1" onClose={onClose} />);
  await screen.findByTestId('file-panel');
  await settle();
};

describe('RightPanel unsaved-edit guard', () => {
  beforeEach(() => {
    dirty.current = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the panel open when the edit is not discarded', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = vi.fn();
    await mountOnFiles(onClose);

    fireEvent.click(closeButton());

    expect(confirmSpy).toHaveBeenCalledWith('filePanel.discardUnsaved');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('file-panel')).toBeInTheDocument();
  });

  it('closes once the edit is discarded', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    await mountOnFiles(onClose);

    fireEvent.click(closeButton());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays on Files when the edit is not discarded', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mountOnFiles(vi.fn());

    fireEvent.click(memoryTab());

    expect(activeTab()).toBe('files');
    expect(screen.getByTestId('file-panel')).toBeInTheDocument();
  });

  it('leaves Files once the edit is discarded, and stops asking after it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    await mountOnFiles(onClose);

    fireEvent.click(memoryTab());
    expect(activeTab()).toBe('memory');
    expect(await screen.findByTestId('memory-panel')).toBeInTheDocument();
    await settle();

    // The drafts went with the panel, so there is nothing left to ask about.
    fireEvent.click(closeButton());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays on Files when a transcript target would leave the edit behind', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onTargetMemoryHandled = vi.fn();
    const { rerender } = renderWithProviders(
      <RightPanel workspaceId="ws-1" onClose={() => {}} onTargetMemoryHandled={onTargetMemoryHandled} />,
    );
    await screen.findByTestId('file-panel');
    await settle();

    rerender(
      <RightPanel
        workspaceId="ws-1"
        onClose={() => {}}
        onTargetMemoryHandled={onTargetMemoryHandled}
        panelTarget={{ kind: 'memory', key: 'notes', tier: 'user' }}
      />,
    );
    await settle();

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(activeTab()).toBe('files');
    expect(screen.getByTestId('file-panel')).toBeInTheDocument();
    expect(onTargetMemoryHandled).toHaveBeenCalledTimes(1);
  });

  it('follows a transcript target once the edit is discarded', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { rerender } = renderWithProviders(<RightPanel workspaceId="ws-1" onClose={() => {}} />);
    await screen.findByTestId('file-panel');
    await settle();

    rerender(
      <RightPanel workspaceId="ws-1" onClose={() => {}} panelTarget={{ kind: 'memory', key: 'notes', tier: 'user' }} />,
    );
    await settle();

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(activeTab()).toBe('memory');
    expect(screen.queryByTestId('file-panel')).toBeNull();
  });

  it('stays on Files when the memo shortcut would leave the edit behind', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mountOnFiles(() => {});

    fireEvent.click(screen.getByText('view in memo'));
    await settle();

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(activeTab()).toBe('files');
    expect(screen.getByTestId('file-panel')).toBeInTheDocument();
  });

  it('closes without asking when no tab holds an unsaved edit', async () => {
    dirty.current = false;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = vi.fn();
    await mountOnFiles(onClose);

    fireEvent.click(closeButton());

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
