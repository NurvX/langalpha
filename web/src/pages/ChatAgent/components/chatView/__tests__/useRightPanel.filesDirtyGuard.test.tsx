import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useRightPanel } from '../useRightPanel';
import type { PlanData } from '../types';
import type { ToolCallProcessRecord } from '../../ToolCallDetailView';

// The Files panel's drafts live in its mount, and closing the panel unmounts
// it. With a draft open that exit asks first, and a declined ask leaves the
// panel where it is. A tool result or a plan is a tab of the same panel, so
// opening one never asks.

function open() {
  const setFilePanelWorkspaceId = vi.fn();
  const { result } = renderHook(() => useRightPanel({
    isMobile: false,
    workspaceId: 'ws',
    isActive: true,
    containerRef: { current: null },
    setFilePanelWorkspaceId,
    messages: [{ id: 'm1', toolCallProcesses: { tc1: TOOL_CALL } }],
  }), { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
  act(() => result.current.handleToggleFilePanel());
  expect(result.current.rightPanelType).toBe('file');
  act(() => result.current.handleFilesDirtyChange(true));
  return result;
}

const TOOL_CALL = { toolCall: { id: 'tc1' }, toolCallResult: { artifact: null } } as unknown as ToolCallProcessRecord;
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
  it('opens a tool-call detail as a Files tab without asking', () => {
    confirm.mockReturnValue(false);
    const result = open();
    act(() => result.current.handleToolCallDetailClick('tc1'));
    expect(confirm).not.toHaveBeenCalled();
    expect(result.current.rightPanelType).toBe('file');
    expect(result.current.panelTarget).toMatchObject({ kind: 'tool', toolCallId: 'tc1' });
  });

  it('opens a plan detail as a Files tab without asking', () => {
    confirm.mockReturnValue(false);
    const result = open();
    act(() => result.current.handlePlanDetailClick('p1', PLAN));
    expect(confirm).not.toHaveBeenCalled();
    expect(result.current.rightPanelType).toBe('file');
    expect(result.current.panelTarget).toMatchObject({ kind: 'plan', planId: 'p1', plan: PLAN });
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
    act(() => result.current.handleToggleFilePanel());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.current.rightPanelType).toBeNull();
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
