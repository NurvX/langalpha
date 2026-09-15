/**
 * A relative link in agent output is a workspace file. Left to the browser it
 * opens the app itself in a new tab, which is what "I click and no file opens"
 * looked like for any name outside the old extension allowlist.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: () => {} }),
}));

import Markdown from '../Markdown';

function render(content: string, variant: 'chat' | 'panel' = 'chat'): string {
  return renderToStaticMarkup(<Markdown variant={variant} content={content} onOpenFile={() => {}} />);
}

describe('Markdown file links', () => {
  it.each([
    ['a deck', '[deck](results/deck.pptx)'],
    ['a macro workbook', '[model](results/model.xlsm)'],
    ['an extensionless file', '[notes](results/NOTES)'],
    ['a name with spaces', '[deck](results/Q3 deck.pptx)'],
  ])('renders %s as an in-app file link', (_label, content) => {
    const html = render(content);
    expect(html).toContain('<a class="underline hover:opacity-80');
    expect(html).not.toContain('target="_blank"');
  });

  it('makes links inside a file viewed in the panel clickable', () => {
    const html = render('[appendix](appendix.docx)', 'panel');
    expect(html).toContain('cursor-pointer');
    expect(html).not.toContain('target="_blank"');
  });

  it('keeps web links opening in a new tab', () => {
    expect(render('[site](https://example.com/report.md)')).toContain('target="_blank"');
  });
});
