/**
 * The deliverables strip: one turn's files, on the bubble that ends it.
 *
 * A steered turn paints several assistant bubbles and a turn can still be
 * streaming, so the strip has to pick a single settled tail and gather the
 * whole turn's files onto it, including ones named by a bubble that never
 * reaches the screen.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '@/test/utils';
import MessageList from '../MessageList';
import { MessageActionsProvider, type MessageActions } from '../messageList/MessageActionsContext';
import type { MessageRecord } from '../messageList/types';

vi.mock('framer-motion', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  const FRAMER_ONLY_PROPS = new Set([
    'initial', 'animate', 'exit', 'transition', 'variants',
    'whileHover', 'whileTap', 'whileInView', 'layout', 'layoutId',
    'onAnimationComplete', 'onAnimationStart',
  ]);
  const createEl = ReactActual.createElement as (type: unknown, props?: unknown, ...children: unknown[]) => React.ReactElement;
  const make = (Comp: React.ElementType | string) =>
    function MotionStub({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) {
      const domProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!FRAMER_ONLY_PROPS.has(k)) domProps[k] = v;
      }
      return createEl(Comp, domProps, children);
    };
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (_t, key: string) => (key === 'create' ? make : make(key)),
    }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
    animate: () => ({ stop: () => {} }),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../Markdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}));

vi.mock('@/hooks/useUser', () => ({ useUser: () => ({ user: null }) }));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', setTheme: () => {} }),
}));

type Msg = Record<string, unknown>;

const assistant = (id: string, text: string, overrides: Msg = {}): Msg => ({
  id,
  role: 'assistant',
  content: text,
  contentType: 'text',
  timestamp: new Date(),
  isStreaming: false,
  contentSegments: [{ type: 'text', content: text, order: 0 }],
  reasoningProcesses: {},
  toolCallProcesses: {},
  ...overrides,
});

const userMsg = (id: string, overrides: Msg = {}): Msg => ({
  id, role: 'user', content: 'ask', contentType: 'text', timestamp: new Date(), isStreaming: false, ...overrides,
});

const write = (order: number, path: string) => ({
  toolName: 'Write', order, isFailed: false, toolCall: { name: 'Write', args: { file_path: path, content: 'x' } },
});

function renderList(messages: Msg[], actions: MessageActions) {
  return renderWithProviders(
    <MessageActionsProvider actions={actions}>
      <MessageList messages={messages as MessageRecord[]} isLoading={false} />
    </MessageActionsProvider>,
  );
}

const cards = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.turn-file .turn-file-name')).map((el) => el.textContent);

describe('turn deliverables strip', () => {
  it('opens the file the card names, in the workspace the reply named', () => {
    const onOpenFile = vi.fn();
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Built [the model](__wsref__/ws-7/results/model.py#L12).')],
      { onOpenFile },
    );

    expect(cards(container)).toEqual(['model.py']);
    fireEvent.click(container.querySelector('.turn-file')!);
    expect(onOpenFile).toHaveBeenCalledWith('results/model.py', 'ws-7', { line: 12 });
  });

  it('gathers the whole turn onto its last bubble and leaves the earlier one bare', () => {
    const { container } = renderList(
      [
        userMsg('u0'),
        assistant('a0', 'Working on it.', { toolCallProcesses: { w: write(0, 'data/prices.csv') } }),
        userMsg('u1-steering', { steeringDelivered: true }),
        assistant('a0-cont', 'Done, see [the report](results/report.md).', { isSteering: true }),
      ],
      { onOpenFile: vi.fn() },
    );

    const bubbles = Array.from(container.querySelectorAll('[data-message-id]'));
    const withCards = bubbles.filter((b) => b.querySelector('.turn-file'));
    expect(withCards).toHaveLength(1);
    expect(withCards[0].getAttribute('data-message-id')).toBe('a0-cont');
    expect(cards(container)).toEqual(['report.md', 'prices.csv']);
  });

  it('waits for the turn to settle before claiming what it produced', () => {
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Saving [the report](results/report.md)', { isStreaming: true })],
      { onOpenFile: vi.fn() },
    );
    expect(cards(container)).toEqual([]);
  });

  it('holds the overflow behind one control rather than growing past the reply', () => {
    const links = ['one.md', 'two.md', 'three.md', 'four.md', 'five.md', 'six.md']
      .map((name) => `[${name}](results/${name})`)
      .join(' and ');
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', `Wrote ${links}.`)],
      { onOpenFile: vi.fn() },
    );

    expect(cards(container)).toHaveLength(5);
    fireEvent.click(container.querySelector('.turn-files-more')!);
    expect(cards(container)).toHaveLength(6);
  });

  it('shows nothing for a turn whose only file is an image the reply already drew', () => {
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Here it is: ![chart](results/chart.png)', { toolCallProcesses: { w: write(0, 'results/chart.png') } })],
      { onOpenFile: vi.fn() },
    );
    expect(container.querySelector('.turn-files')).toBeNull();
  });
});
