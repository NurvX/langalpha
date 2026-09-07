import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '@/test/utils';

// Inline dropdown, as in BulkScopeMenu.test: jsdom does not drive Radix portals.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (e?: { preventDefault: () => void }) => void;
  }) => (
    <button role="menuitem" onClick={() => onSelect?.({ preventDefault: () => {} })}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="submenu">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ data: { workspaces: [{ workspace_id: 'ws-1', name: 'Research' }] } }),
}));
vi.mock('@/pages/ChatAgent/utils/api/workspaces', () => ({
  getFlashWorkspace: vi.fn().mockResolvedValue({ workspace_id: 'flash-1' }),
}));

import { ScopeControl } from '../components/ScopeControl';
import { BulkScopeMenu } from '../components/BulkScopeMenu';
import { useFlashWorkspace } from '../hooks/useFlashWorkspace';
import { useWorkspaceOptions } from '../hooks/useWorkspaceOptions';

const workspaces = [{ id: 'ws-1', name: 'Research' }];
const flashWorkspace = { id: 'flash-1', name: 'Flash' };

describe('ScopeControl with the Flash workspace', () => {
  it('lists Flash last with its note only when the row can reach it', () => {
    const onSet = vi.fn();
    renderWithProviders(
      <ScopeControl
        workspaces={workspaces}
        scopeWorkspaceId={null}
        disabledWorkspaceIds={['flash-1']}
        flashWorkspace={flashWorkspace}
        onSetWorkspaceDisabled={onSet}
        onMove={vi.fn()}
      />,
    );
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items[0]).toBe('Research');
    expect(items[1]).toBe('Flash');
    expect(screen.getByText(/Flash reaches only the tools bound as Direct/)).toBeInTheDocument();
    // Flash is never a move destination.
    expect(items.filter((label) => label === 'Flash')).toHaveLength(1);
    // The disabled Flash entry still counts toward the label.
    expect(screen.getByText('All workspaces except 1')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('menuitem')[1]);
    expect(onSet).toHaveBeenCalledWith('flash-1', false);
  });

  it('keeps Flash out of rows that cannot reach it', () => {
    renderWithProviders(
      <ScopeControl
        workspaces={workspaces}
        scopeWorkspaceId={null}
        disabledWorkspaceIds={['flash-1']}
        onSetWorkspaceDisabled={vi.fn()}
      />,
    );
    expect(screen.queryByText('Flash')).not.toBeInTheDocument();
    expect(screen.getByText('All workspaces')).toBeInTheDocument();
  });

  it('keeps Flash out of the bulk move-to-workspace destinations', async () => {
    function Harness() {
      const { workspaces: wsOptions } = useWorkspaceOptions();
      const flash = useFlashWorkspace();
      return (
        <>
          <span data-testid="flash-resolved">{flash?.id ?? 'none'}</span>
          <BulkScopeMenu
            workspaces={wsOptions}
            everywhereCount={2}
            onEverywhere={vi.fn()}
            onlyInCount={2}
            onOnlyIn={vi.fn()}
            moveCount={2}
            onMoveTo={vi.fn()}
          />
        </>
      );
    }
    renderWithProviders(<Harness />);
    // The move list is only meaningful once Flash has actually resolved:
    // an unresolved query would pass this test for the wrong reason.
    await screen.findByText('flash-1');

    const moveSub = screen
      .getAllByTestId('submenu')
      .find((el) => el.textContent?.includes('Move into workspace'));
    expect(moveSub).toBeDefined();
    expect(within(moveSub as HTMLElement).getByText('Research')).toBeInTheDocument();
    expect(within(moveSub as HTMLElement).queryByText('Flash')).not.toBeInTheDocument();
    // Nor anywhere else in the bulk menu: the "Only in" checklist writes a
    // deny the Skills tab's ScopeControl could not display or undo.
    expect(screen.queryByText('Flash')).not.toBeInTheDocument();
  });
});
