import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useRightPanel } from '../useRightPanel';
import type { PlanData, ToolCallProcessRecord } from '../types';

// The Files panel's drafts live in its mount, and every exit this hook owns
// unmounts it. With a draft open each exit asks first, and a declined ask
// leaves the panel where it is.

function open() {
  const setFilePanelWorkspaceId = vi.fn();
  const { result } = renderHook(() => useRightPanel({
    isMobile: false,
    workspaceId: 'ws',
    isActive: true,
    containerRef: { current: null },
    setFilePanelWorkspaceId,
    messages: [],
  }), { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
  act(() => result.current.handleToggleFilePanel());
  expect(result.current.rightPanelType).toBe('file');
  act(() => result.current.handleFilesDirtyChange(true));
  return result;
}

const TOOL_CALL = { id: 'tc1', toolCallResult: { artifact: null } } as unknown as ToolCallProcessRecord;
const PLAN = { steps: [] } as unknown as PlanData;

const confirm = vi.fn<(message?: string) => boolean>();
beforeEach(() => {
  confirm.mockReset();
  vi.stubGlobal('confirm', confirm);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('leaving the Files panel with a draft open', () => {
  it('holds the panel on a declined tool-call detail', () => {
    confirm.mockReturnValue(false);
    const result = open();
    act(() => result.current.handleToolCallDetailClick(TOOL_CALL));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.current.rightPanelType).toBe('file');
  });

  it('holds the panel on a declined plan detail', () => {
    confirm.mockReturnValue(false);
    const result = open();
    act(() => result.current.handlePlanDetailClick(PLAN));
    expect(result.current.rightPanelType).toBe('file');
  });

  it('holds the panel on a declined Workspace toggle', () => {
    confirm.mockReturnValue(false);
    const result = open();
    act(() => result.current.handleToggleFilePanel());
    expect(result.current.rightPanelType).toBe('file');
  });

  it('leaves once the ask is accepted', () => {
    confirm.mockReturnValue(true);
    const result = open();
    act(() => result.current.handleToolCallDetailClick(TOOL_CALL));
    expect(result.current.rightPanelType).toBe('detail');
  });

  it('never asks once the panel reports clean', () => {
    confirm.mockReturnValue(false);
    const result = open();
    act(() => result.current.handleFilesDirtyChange(false));
    act(() => result.current.handleToggleFilePanel());
    expect(confirm).not.toHaveBeenCalled();
    expect(result.current.rightPanelType).toBeNull();
  });
});
