/**
 * What the deliverables strip is allowed to claim a turn produced.
 *
 * Both halves of a turn lie on their own: the reply names files a script never
 * wrote and links the same one twice, and the tool calls name scratch paths the
 * reply deliberately never mentioned. The strip is what the two agree on.
 */
import { describe, it, expect } from 'vitest';
import { collectTurnFiles } from '../turnFiles';

function assistant(text: string, toolCallProcesses: Record<string, unknown> = {}) {
  return { role: 'assistant', contentSegments: [{ type: 'text', content: text }], toolCallProcesses };
}

function write(order: number, path: string) {
  return { toolName: 'Write', order, toolCall: { args: { file_path: path, content: 'x' } } };
}

function edit(order: number, path: string, oldString: string, newString: string) {
  return { toolName: 'Edit', order, toolCall: { args: { file_path: path, old_string: oldString, new_string: newString } } };
}

describe('collectTurnFiles', () => {
  it('lists the files the reply links, in the order it names them', () => {
    const files = collectTurnFiles([
      assistant('See [the model](results/model.py) and [the notes](notes/summary.md).'),
    ]);
    expect(files.map((f) => f.path)).toEqual(['results/model.py', 'notes/summary.md']);
  });

  it('keeps a file only a write tool named', () => {
    const files = collectTurnFiles([
      assistant('Done, see [the chart](results/chart.html).', { a: write(0, 'results/chart.html'), b: write(1, 'data/prices.csv') }),
    ]);
    expect(files.map((f) => f.path)).toEqual(['results/chart.html', 'data/prices.csv']);
  });

  it('counts an edit as the lines it changed, not the anchor lines it carried', () => {
    const files = collectTurnFiles([
      assistant('Updated [the model](model.py).', {
        a: edit(0, 'model.py', 'def run():\n    old()\n    return 1', 'def run():\n    new()\n    also()\n    return 1'),
      }),
    ]);
    expect(files[0].stats).toEqual({ added: 2, removed: 1 });
  });

  it('sums the edits a turn made to one file and keeps it listed once', () => {
    const files = collectTurnFiles([
      assistant('', { a: edit(0, 'model.py', 'a', 'b'), b: edit(1, 'model.py', 'c', 'd\ne') }),
      assistant('Then [the model](model.py) was ready.'),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].stats).toEqual({ added: 3, removed: 2 });
  });

  it('counts a deletion as removed lines only, with no phantom line added', () => {
    // `''.split('\n')` is one element, so an empty replacement used to report
    // the line it did not add. A trailing newline is the other half: it ends
    // the last line rather than opening an empty one, and a fix that maps `''`
    // to no lines without handling it turns this pair of counts back around.
    const cut = collectTurnFiles([
      assistant('Trimmed [the model](report.md).', { a: edit(0, 'report.md', '    old()\n    stale()', '') }),
    ]);
    expect(cut[0].stats).toEqual({ added: 0, removed: 2 });

    const cutLine = collectTurnFiles([
      assistant('Trimmed [the model](report.md).', { a: edit(0, 'report.md', '    stale()\n', '') }),
    ]);
    expect(cutLine[0].stats).toEqual({ added: 0, removed: 1 });
  });

  it('reports no line count for a write, which never says what it replaced', () => {
    const files = collectTurnFiles([assistant('', { a: write(0, 'results/report.md') })]);
    expect(files[0].stats).toBeUndefined();
  });

  it('drops an image the reply shows, however it was written', () => {
    // The renderer draws `[name](x.png)` as an image too, so both forms are
    // already on screen and a card for either points at what the reader sees.
    const files = collectTurnFiles([
      assistant('![chart](results/chart.png)\nAlso [the raw plot](results/plot.png), from [the data](data/prices.csv).', {
        a: write(0, 'results/chart.png'),
        b: write(1, 'results/plot.png'),
        c: write(2, 'data/prices.csv'),
      }),
    ]);
    expect(files.map((f) => f.path)).toEqual(['data/prices.csv']);
  });

  it('keeps a name the reply wrote with parentheses in it', () => {
    // CommonMark allows one level of balanced parens in a bare destination, so
    // the reply's own link renders and opens. The card has to agree, and the
    // embedded image has to stay suppressed rather than earn a duplicate.
    const files = collectTurnFiles([
      assistant('![chart](results/chart(1).png)\nSee [the report](results/report(1).pdf).', {
        a: write(0, 'results/chart(1).png'),
        b: write(1, 'results/report(1).pdf'),
      }),
    ]);
    expect(files.map((f) => f.path)).toEqual(['results/report(1).pdf']);
  });

  it('keeps the spot in the file the reply pointed at', () => {
    const files = collectTurnFiles([assistant('See [the loop](src/run.py#L42).')]);
    expect(files[0].location).toEqual({ line: 42 });
  });

  it('carries the workspace a Flash relay named', () => {
    const files = collectTurnFiles([assistant('See [the model](__wsref__/ws-7/results/model.py).')]);
    expect(files[0]).toMatchObject({ path: 'results/model.py', workspaceId: 'ws-7' });
  });

  it('leaves out system paths, section links and folders', () => {
    const files = collectTurnFiles([
      assistant('[skills](.agents/skills/report/SKILL.md), [a section](#findings), [a folder](results/), [a route](/settings)'),
    ]);
    expect(files).toEqual([]);
  });

  it('ignores a failed write and a user message', () => {
    const files = collectTurnFiles([
      { role: 'user', content: 'write [the model](model.py)' },
      assistant('', { a: { ...write(0, 'model.py'), isFailed: true } }),
    ]);
    expect(files).toEqual([]);
  });
});
