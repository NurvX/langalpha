import { describe, it, expect } from 'vitest';
import {
  parseFragment,
  splitFileLocation,
  headingSlugs,
  findHeadingIndex,
  countLines,
  markdownLineProbe,
  headingIndexAbove,
} from '../fileLocation';

describe('parseFragment', () => {
  it('reads line and range fragments', () => {
    expect(parseFragment('L42')).toEqual({ line: 42 });
    expect(parseFragment('L40-L55')).toEqual({ line: 40, lineEnd: 55 });
    expect(parseFragment('L40-55')).toEqual({ line: 40, lineEnd: 55 });
    expect(parseFragment('L55-L40')).toEqual({ line: 40, lineEnd: 55 });
    expect(parseFragment('L0')).toBeNull();
  });

  it('reads a PDF page', () => {
    expect(parseFragment('page=12')).toEqual({ page: 12 });
    expect(parseFragment('zoom=100&page=3')).toEqual({ page: 3 });
    expect(parseFragment('page=0')).toBeNull();
  });

  it('keeps anything else as a decoded anchor', () => {
    expect(parseFragment('risks-1')).toEqual({ anchor: 'risks-1' });
    expect(parseFragment('%E4%BC%B0%E5%80%BC')).toEqual({ anchor: '估值' });
    expect(parseFragment('')).toBeNull();
  });
});

describe('splitFileLocation', () => {
  it('splits a fragment off the path', () => {
    expect(splitFileLocation('results/report.md#valuation')).toEqual({
      path: 'results/report.md',
      location: { anchor: 'valuation' },
    });
    expect(splitFileLocation('filing.pdf#page=2')).toEqual({ path: 'filing.pdf', location: { page: 2 } });
  });

  it('splits a line suffix, ignoring a column', () => {
    expect(splitFileLocation('work/model.py:42')).toEqual({ path: 'work/model.py', location: { line: 42 } });
    expect(splitFileLocation('model.py:40-55')).toEqual({ path: 'model.py', location: { line: 40, lineEnd: 55 } });
    expect(splitFileLocation('model.py:42:7')).toEqual({ path: 'model.py', location: { line: 42 } });
  });

  it('leaves a plain path, a port or an extensionless name alone', () => {
    expect(splitFileLocation('results/report.md')).toEqual({ path: 'results/report.md', location: null });
    expect(splitFileLocation('localhost:8000')).toEqual({ path: 'localhost:8000', location: null });
    expect(splitFileLocation('Makefile:12')).toEqual({ path: 'Makefile:12', location: null });
  });
});

describe('heading anchors', () => {
  it('slugs headings the way GitHub does, numbering repeats', () => {
    expect(headingSlugs(['Risks', 'Price & Volume', 'Risks', 'Risks'])).toEqual([
      'risks',
      'price--volume',
      'risks-1',
      'risks-2',
    ]);
  });

  it('finds a heading by slug, by written text, or through the sanitizer prefix', () => {
    const headings = ['Summary', 'Valuation', 'Risks', 'Risks'];
    expect(findHeadingIndex(headings, 'valuation')).toBe(1);
    expect(findHeadingIndex(headings, 'Valuation')).toBe(1);
    expect(findHeadingIndex(headings, 'risks-1')).toBe(3);
    expect(findHeadingIndex(headings, 'user-content-summary')).toBe(0);
    expect(findHeadingIndex(headings, 'missing')).toBe(-1);
  });
});

describe('countLines', () => {
  it('does not count a trailing newline as a line', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
  });
});

describe('markdown line mapping', () => {
  const source = [
    '# Report', // 1
    '', // 2
    'Revenue grew **14%** on [strong demand](notes.md).', // 3
    '', // 4
    '## Valuation', // 5
    '', // 6
    '- [x] EV/EBITDA of 11.4x', // 7
    '', // 8
    '```python', // 9
    'print("## not a heading")', // 10
    '```', // 11
  ].join('\n');

  it('probes with the longest plain run of the source line', () => {
    expect(markdownLineProbe(source, 3)).toBe('on strong demand.');
    expect(markdownLineProbe(source, 5)).toBe('Valuation');
    expect(markdownLineProbe(source, 7)).toBe('EV/EBITDA of 11.4x');
  });

  it('skips forward over a blank line and keeps code verbatim', () => {
    expect(markdownLineProbe(source, 2)).toBe(markdownLineProbe(source, 3));
    expect(markdownLineProbe(source, 10)).toBe('print("## not a heading")');
    expect(markdownLineProbe(source, 99)).toBeNull();
  });

  it('finds the nearest heading above a line, ignoring fenced code', () => {
    expect(headingIndexAbove(source, 3)).toBe(0);
    expect(headingIndexAbove(source, 7)).toBe(1);
    expect(headingIndexAbove(source, 11)).toBe(1);
    expect(headingIndexAbove(source, 0)).toBe(-1);
  });
});
