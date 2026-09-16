/**
 * The deliverables deck: one turn's files, on the bubble that ends it.
 *
 * A steered turn paints several assistant bubbles and a turn can still be
 * streaming, so the deck has to pick a single settled tail and gather the whole
 * turn's files onto it, including ones named by a bubble that never reaches the
 * screen. Collapsed it shows one card: the stripe opens the file on its face
 * and the count chip fans the rest out, so neither click can be mistaken for
 * the other.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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

const names = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.turn-file-card'))
    .map((el) => el.querySelector('.turn-file-name')?.textContent ?? '');

/** The stripe, which is the card's primary target: the whole row opens the
 *  file, so a test clicks it rather than the Open pill beside it. */
const stripe = (container: HTMLElement, i = 0) =>
  container.querySelectorAll('.turn-file-card')[i].querySelector('.turn-file-hit') as HTMLElement;

/** The count chip on a collapsed deck, the only thing that fans it. */
const chip = (container: HTMLElement) =>
  container.querySelector('.turn-file-count') as HTMLElement;

describe('turn deliverables deck', () => {
  it('opens a lone file on the first click, in the workspace the reply named', () => {
    const onOpenFile = vi.fn();
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Built [the review](__wsref__/ws-7/results/review.md#L12).')],
      { onOpenFile },
    );

    expect(names(container)).toEqual(['review.md']);
    fireEvent.click(stripe(container));
    expect(onOpenFile).toHaveBeenCalledWith('results/review.md', 'ws-7', { line: 12 });
  });

  it('holds several files behind one card, and the chip is what fans them out', () => {
    const onOpenFile = vi.fn();
    const { container } = renderList(
      [
        userMsg('u0'),
        assistant('a0', 'Wrote [the review](results/review.md) and [the deck](results/deck.pptx).'),
      ],
      { onOpenFile },
    );

    // Collapsed: the front card carries the count, the peek behind it is blank.
    const deck = container.querySelector('[data-testid="turn-files"]')!;
    expect(deck.getAttribute('data-fanned')).toBe('false');
    expect(names(container)).toEqual(['review.md', '']);

    // The stripe means the file on its face, even with a deck behind it.
    fireEvent.click(stripe(container));
    expect(onOpenFile).toHaveBeenCalledWith('results/review.md', undefined, undefined);
    expect(deck.getAttribute('data-fanned')).toBe('false');

    fireEvent.click(chip(container));
    expect(deck.getAttribute('data-fanned')).toBe('true');
    expect(names(container)).toEqual(['review.md', 'deck.pptx']);

    fireEvent.click(stripe(container, 1));
    expect(onOpenFile).toHaveBeenLastCalledWith('results/deck.pptx', undefined, undefined);
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
    const withDeck = bubbles.filter((b) => b.querySelector('.turn-file-card'));
    expect(withDeck).toHaveLength(1);
    expect(withDeck[0].getAttribute('data-message-id')).toBe('a0-cont');

    fireEvent.click(chip(container));
    expect(names(container)).toEqual(['report.md', 'prices.csv']);
  });

  it('waits for the turn to settle before claiming what it produced', () => {
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Saving [the report](results/report.md)', { isStreaming: true })],
      { onOpenFile: vi.fn() },
    );
    expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
  });

  it('shows nothing for a turn that only wrote its own scaffolding', () => {
    const { container } = renderList(
      [
        userMsg('u0'),
        assistant('a0', 'Ran [the fetcher](scripts/fetch.py).', {
          toolCallProcesses: { a: write(0, 'scripts/fetch.py'), b: write(1, 'run.sh') },
        }),
      ],
      { onOpenFile: vi.fn() },
    );
    expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
  });

  it('offers Download beside Open, and only where the host permits saving', async () => {
    const onDownloadFile = vi.fn();
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Built [the review](results/review.md).')],
      { onOpenFile: vi.fn(), onDownloadFile },
    );

    fireEvent.pointerDown(
      container.querySelector('.turn-file-more') as HTMLElement,
      { button: 0, ctrlKey: false },
    );
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['chat.turnFiles.open', 'chat.turnFiles.download']);
    fireEvent.click(items[1]);
    expect(onDownloadFile).toHaveBeenCalledWith('results/review.md', undefined);
  });

  it('leaves the menu open-only when the host grants no download', async () => {
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Built [the review](results/review.md).')],
      { onOpenFile: vi.fn() },
    );

    fireEvent.pointerDown(
      container.querySelector('.turn-file-more') as HTMLElement,
      { button: 0, ctrlKey: false },
    );
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['chat.turnFiles.open']);
  });

  it('shows nothing for a turn whose only file is an image the reply already drew', () => {
    const { container } = renderList(
      [userMsg('u0'), assistant('a0', 'Here it is: ![chart](results/chart.png)', { toolCallProcesses: { w: write(0, 'results/chart.png') } })],
      { onOpenFile: vi.fn() },
    );
    expect(container.querySelector('[data-testid="turn-files"]')).toBeNull();
  });
});
