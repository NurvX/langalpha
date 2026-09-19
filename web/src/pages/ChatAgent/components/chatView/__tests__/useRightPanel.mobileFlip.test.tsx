import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useRightPanel } from '../useRightPanel';

const { getPreviewUrl } = vi.hoisted(() => ({ getPreviewUrl: vi.fn() }));
vi.mock('../../../utils/api', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getPreviewUrl }));

function open(isMobile: boolean) {
  // Hoisted out of the render callback: a fresh identity per render would
  // re-run the workspace-reset effect and wipe the state under test.
  const setFilePanelWorkspaceId = vi.fn();
  return renderHook((props: { isMobile: boolean }) => useRightPanel({
    isMobile: props.isMobile,
    workspaceId: 'ws',
    isActive: true,
    containerRef: { current: null },
    setFilePanelWorkspaceId,
    messages: [],
  }), { initialProps: { isMobile }, wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
}

const APP = { url: '', port: 8050, title: 'Dashboard', command: 'python app.py', path: '/timeline.html', loading: true };

beforeEach(() => {
  vi.clearAllMocks();
  getPreviewUrl.mockResolvedValue({ url: 'https://8050-sandbox.example.com/' });
});

describe('the viewport widening with the preview sheet open', () => {
  it('lands the app the sheet was showing as a Files-panel preview target', async () => {
    const { result, rerender } = open(true);
    await act(async () => { result.current.handleOpenPreview(APP); });
    expect(result.current.rightPanelType).toBe('preview');

    act(() => rerender({ isMobile: false }));

    // The desktop column renders nothing for `preview`; the app goes where a
    // desktop opens it, carrying what the tab needs to mint its own URL.
    expect(result.current.rightPanelType).toBe('file');
    expect(result.current.panelTarget).toMatchObject({
      kind: 'preview', port: 8050, title: 'Dashboard', command: 'python app.py', path: '/timeline.html',
    });
    expect(result.current.rightPanelWidth).toBe(850);
  });

  it('closes the column when the sheet had nothing to show', () => {
    const { result, rerender } = open(true);
    act(() => result.current.setRightPanelType('preview'));

    act(() => rerender({ isMobile: false }));

    expect(result.current.rightPanelType).toBeNull();
    expect(result.current.panelTarget).toBeNull();
  });

  it('leaves a file panel alone when the viewport widens', () => {
    const { result, rerender } = open(true);
    act(() => result.current.handleToggleFilePanel());

    act(() => rerender({ isMobile: false }));

    expect(result.current.rightPanelType).toBe('file');
    expect(result.current.panelTarget).toBeNull();
  });

  it('does not react to the viewport narrowing', async () => {
    const { result, rerender } = open(false);
    act(() => result.current.handleOpenPreview(APP));
    const before = result.current.panelTarget;

    act(() => rerender({ isMobile: true }));

    expect(result.current.rightPanelType).toBe('file');
    expect(result.current.panelTarget).toBe(before);
  });
});
