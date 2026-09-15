import { describe, it, expect } from 'vitest';
import {
  collectRecentWritePaths,
  linkCandidates,
  normalizeRefPath,
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

  it('leaves a path that is only a suffix of a listed file to the server lookup', () => {
    expect(resolveExact(['results/summary.md'], files, [])).toBeNull();
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
