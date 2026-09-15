import { describe, it, expect } from 'vitest';
import {
  collectRecentWritePaths,
  linkCandidates,
  nameGlob,
  normalizeRefPath,
  pickUnambiguous,
  rankNameMatches,
  resolveByName,
  resolveExact,
} from '../fileRefResolver';

describe('normalizeRefPath', () => {
  it('strips the sandbox root and folds dot segments', () => {
    expect(normalizeRefPath('/home/workspace/results/report.md')).toBe('results/report.md');
    expect(normalizeRefPath('file:///home/daytona/results/report.md')).toBe('results/report.md');
    expect(normalizeRefPath('./results/../data/./x.csv')).toBe('data/x.csv');
  });

  it('keeps a true absolute path absolute', () => {
    expect(normalizeRefPath('/tmp/out.csv')).toBe('/tmp/out.csv');
    expect(normalizeRefPath('/large_tool_results/abc')).toBe('/large_tool_results/abc');
  });
});

describe('linkCandidates', () => {
  it('reads a link against the linking file first, then from the root', () => {
    expect(linkCandidates('charts/fig.png', 'results/report.md')).toEqual(['results/charts/fig.png', 'charts/fig.png']);
  });

  it('offers one candidate when both readings agree', () => {
    expect(linkCandidates('../data/x.csv', 'results/report.md')).toEqual(['data/x.csv']);
    expect(linkCandidates('x.csv', 'report.md')).toEqual(['x.csv']);
  });

  it('does not rebase an absolute link', () => {
    expect(linkCandidates('/home/workspace/data/x.csv', 'results/report.md')).toEqual(['data/x.csv']);
  });
});

describe('resolveExact', () => {
  const files = ['results/report.md', 'work/task/results/summary.md', 'data/x.csv'];

  it('opens an exact path from the list or this thread’s writes', () => {
    expect(resolveExact(['results/report.md'], files, [])).toBe('results/report.md');
    expect(resolveExact(['results/new.md'], files, ['results/new.md'])).toBe('results/new.md');
  });

  it('opens the unique file whose path ends with the reference', () => {
    expect(resolveExact(['results/summary.md'], files, [])).toBe('work/task/results/summary.md');
  });

  it('never matches a bare name here', () => {
    expect(resolveExact(['summary.md'], files, [])).toBeNull();
  });

  it('prefers a written file when several paths end with the reference', () => {
    const many = ['a/results/summary.md', 'b/results/summary.md'];
    expect(resolveExact(['results/summary.md'], many, [])).toBeNull();
    expect(resolveExact(['results/summary.md'], many, ['b/results/summary.md'])).toBe('b/results/summary.md');
  });
});

describe('resolveByName', () => {
  it('takes the newest write with the name', () => {
    expect(resolveByName('report.md', [], ['results/v2/report.md', 'results/report.md'])).toBe('results/v2/report.md');
  });

  it('falls back to a name unique in the list', () => {
    expect(resolveByName('x/report.md', ['results/report.md'], [])).toBe('results/report.md');
    expect(resolveByName('report.md', ['a/report.md', 'b/report.md'], [])).toBeNull();
  });
});

describe('rankNameMatches + pickUnambiguous', () => {
  it('opens a single namesake', () => {
    const ranked = rankNameMatches(['deck.pptx'], ['results/deck.pptx', 'results/deck.pdf']);
    expect(ranked).toEqual(['results/deck.pptx']);
    expect(pickUnambiguous(['deck.pptx'], ranked)).toBe('results/deck.pptx');
  });

  it('opens the one hit carrying the full reference among namesakes', () => {
    const hits = ['old/report.md', 'work/results/report.md'];
    const ranked = rankNameMatches(['results/report.md'], hits);
    expect(ranked[0]).toBe('work/results/report.md');
    expect(pickUnambiguous(['results/report.md'], ranked)).toBe('work/results/report.md');
  });

  it('leaves the choice to the user when namesakes tie', () => {
    const ranked = rankNameMatches(['report.md'], ['a/report.md', 'b/report.md']);
    expect(pickUnambiguous(['report.md'], ranked)).toBeNull();
  });

  it('sorts system-directory hits last unless the reference points there', () => {
    const hits = ['.agents/x/report.md', 'results/deep/report.md'];
    expect(rankNameMatches(['report.md'], hits)[0]).toBe('results/deep/report.md');
    expect(rankNameMatches(['.agents/report.md'], hits)[0]).toBe('.agents/x/report.md');
  });
});

describe('collectRecentWritePaths', () => {
  const call = (toolName: string, path: string, order: number, isFailed = false) => ({
    toolName,
    toolCall: { args: { file_path: path } },
    isFailed,
    order,
  });

  it('lists Write and Edit paths newest first, once each', () => {
    const messages = [
      { toolCallProcesses: { a: call('Write', '/home/workspace/results/a.md', 1), b: call('Read', 'results/r.md', 2) } },
      { role: 'user' },
      {
        toolCallProcesses: {
          c: call('Edit', 'results/a.md', 1),
          d: call('Write', 'results/b.md', 2),
          e: call('Write', 'results/failed.md', 3, true),
        },
      },
    ];
    expect(collectRecentWritePaths(messages)).toEqual(['results/b.md', 'results/a.md']);
  });
});

describe('nameGlob', () => {
  it('searches by name, and falls back to everything for glob syntax', () => {
    expect(nameGlob('results/report.md')).toBe('**/report.md');
    expect(nameGlob('results/[draft] report.md')).toBe('**/*');
  });
});
