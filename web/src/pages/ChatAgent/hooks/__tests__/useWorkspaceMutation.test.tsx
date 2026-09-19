import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceMutation } from '../useWorkspaceMutation';

it('refreshes sibling details and computers after a shared resource change', async () => {
  const client = new QueryClient();
  const sibling = queryKeys.workspaces.detail('sibling');
  const computers = queryKeys.computers.lists();
  client.setQueryData(sibling, { resource_tier: 'standard' });
  client.setQueryData(computers, [{ resource_tier: 'standard' }]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useWorkspaceMutation<string>({
    mutationFn: vi.fn().mockResolvedValue({}),
    affectsComputer: true,
    errorTitleKey: 'workspace.specFailed',
  }), { wrapper });
  await act(async () => { expect(await result.current.run('active', 'performance')).toBe(true); });
  expect(client.getQueryState(sibling)?.isInvalidated).toBe(true);
  expect(client.getQueryState(computers)?.isInvalidated).toBe(true);
  client.clear();
});
