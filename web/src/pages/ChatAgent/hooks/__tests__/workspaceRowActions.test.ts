import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';

import { queryKeys } from '@/lib/queryKeys';
import { invalidateWorkspaceMembership } from '../workspaceRowActions';

it('invalidates workspace and computer projections after membership changes', () => {
  const client = new QueryClient();
  const workspaces = queryKeys.workspaces.lists();
  const computers = queryKeys.computers.lists();
  client.setQueryData(workspaces, { workspaces: [] });
  client.setQueryData(computers, { computers: [] });

  invalidateWorkspaceMembership(client);

  expect(client.getQueryState(workspaces)?.isInvalidated).toBe(true);
  expect(client.getQueryState(computers)?.isInvalidated).toBe(true);
  client.clear();
});
