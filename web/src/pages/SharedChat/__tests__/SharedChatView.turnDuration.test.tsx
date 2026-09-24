/**
 * A shared transcript folds like any other, so it needs the same two numbers.
 *
 * This view replays the public stream itself rather than going through
 * `replayHistory`, so every field the fold reads has to be picked up here too.
 * Without them the row still renders, and says the bare `Worked` over a turn
 * whose duration the payload was carrying all along.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const capturedMessages: Record<string, unknown>[][] = [];

vi.mock('react-router-dom', () => ({
  useParams: () => ({ shareToken: 'tok' }),
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ isLoggedIn: false }) }));
vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

vi.mock('../../ChatAgent/components/MessageList', () => ({
  default: ({ messages }: { messages: Record<string, unknown>[] }) => {
    capturedMessages.push(messages);
    return <div data-testid="message-list" />;
  },
}));

vi.mock('../../ChatAgent/components/FilePanel', () => ({ default: () => null }));

vi.mock('../../ChatAgent/contexts/WorkspaceContext', () => ({
  WorkspaceProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const STARTED = '2026-09-21T15:04:00.000Z';
const SETTLED = '2026-09-21T15:05:18.000Z';

const replayEvents = [
  {
    event: 'user_message',
    turn_index: 0,
    role: 'user',
    content: 'how long did that take',
    timestamp: STARTED,
    run_completed_at: SETTLED,
  },
  {
    event: 'message_chunk',
    turn_index: 0,
    role: 'assistant',
    content_type: 'reasoning_signal',
    content: 'start',
  },
  {
    event: 'message_chunk',
    turn_index: 0,
    role: 'assistant',
    content_type: 'reasoning',
    content: 'weighing it up',
  },
  {
    event: 'message_chunk',
    turn_index: 0,
    role: 'assistant',
    content_type: 'reasoning_signal',
    content: 'complete',
    elapsed_ms: 23000,
  },
  {
    event: 'message_chunk',
    turn_index: 0,
    role: 'assistant',
    content_type: 'text',
    content: '78 seconds.',
  },
  { event: 'replay_done' },
];

vi.mock('../api', () => ({
  getSharedThread: vi.fn(async () => ({ title: 'Shared', workspace_name: null })),
  replaySharedThread: vi.fn(async (_token: string, onEvent: (e: unknown) => void) => {
    replayEvents.forEach(onEvent);
  }),
  getSharedFiles: vi.fn(async () => []),
  readSharedFile: vi.fn(async () => ''),
  downloadSharedFileAs: vi.fn(async () => undefined),
  fetchSharedServeObjectUrl: vi.fn(async () => ''),
  fetchSharedServeArrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
}));

import SharedChatView from '../SharedChatView';

const latest = () => capturedMessages[capturedMessages.length - 1];

describe('SharedChatView turn duration', () => {
  beforeEach(() => {
    capturedMessages.length = 0;
  });

  it('stamps the turn end on the bubble that closes it', async () => {
    render(<SharedChatView />);
    await waitFor(() => expect(capturedMessages.length).toBeGreaterThan(0));

    await waitFor(() => {
      const assistant = latest().find((m) => m.role === 'assistant');
      expect(assistant?.completedAt).toBe(Date.parse(SETTLED));
    });

    // The other end of the subtraction, which the fold reads off the user bubble.
    const user = latest().find((m) => m.role === 'user');
    expect((user?.timestamp as Date).getTime()).toBe(Date.parse(STARTED));
  });

  it('carries the reasoning duration onto the row that shows it', async () => {
    render(<SharedChatView />);
    await waitFor(() => expect(capturedMessages.length).toBeGreaterThan(0));

    await waitFor(() => {
      const assistant = latest().find((m) => m.role === 'assistant');
      const processes = assistant?.reasoningProcesses as Record<string, Record<string, unknown>>;
      const [process] = Object.values(processes ?? {});
      expect(process?.elapsedMs).toBe(23000);
    });
  });
});
