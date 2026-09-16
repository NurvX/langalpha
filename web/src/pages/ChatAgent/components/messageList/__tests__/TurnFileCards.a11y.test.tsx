/**
 * What the deck's front card is called, in the locale a reader actually hears.
 *
 * The deck's own suite mocks `t` to return its key, which is right for asserting
 * behavior and useless for asserting a label. These cases run the real locale
 * resources, because the defect they lock was in the copy: an `aria-label`
 * replaces the name rendered inside the same button, so a label that only
 * counted the files left the front one unnameable.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { TurnFileCards } from '../TurnFileCards';
import type { TurnFile } from '../../../utils/turnFiles';

const files: TurnFile[] = [
  { path: 'results/review.md' },
  { path: 'results/deck.pptx' },
];

const label = () => screen.getAllByRole('button')[0].getAttribute('aria-label') ?? '';

describe('collapsed deck card, accessible name', () => {
  it('leads with the file it is showing, so speech input can say it', () => {
    render(<TurnFileCards files={files} onOpenFile={vi.fn()} />);

    // Voice control matches a prefix of the accessible name, so the filename
    // has to come first, not be buried after the count.
    expect(label()).toBe('review.md, show all 2 files from this turn');
  });

  it('still says how many files the card stands for', () => {
    render(<TurnFileCards files={[...files, { path: 'results/model.py' }]} onOpenFile={vi.fn()} />);
    expect(label()).toContain('3');
  });

  it('names the file plainly when the deck holds only one', () => {
    render(<TurnFileCards files={[files[0]]} onOpenFile={vi.fn()} />);
    expect(label()).toBe('Open results/review.md');
  });

  it('keeps the name in zh-CN, where the count string is a different shape', async () => {
    await i18n.changeLanguage('zh-CN');
    try {
      render(<TurnFileCards files={files} onOpenFile={vi.fn()} />);
      expect(label()).toBe('review.md，展开本轮的 2 个文件');
    } finally {
      // Unmount first: switching back under a live tree re-renders outside act.
      cleanup();
      await i18n.changeLanguage('en-US');
    }
  });
});
