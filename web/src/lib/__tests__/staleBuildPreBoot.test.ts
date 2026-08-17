import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { isStaleBuildError, __resetStaleBuildForTests } from '../staleBuild';

// jsdom ships no type declarations and @types/jsdom is not a dependency here.
// The surface this file uses is one constructor wide, so declare that rather
// than add a types package for a single test.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (
    html: string,
    options: { url: string; runScripts: 'outside-only' },
  ) => { window: unknown };
};

// The pre-boot half of stale-build recovery, exercised as the browser actually
// gets it: the literal <script> text out of index.html, evaluated in its own
// document. It is inline and un-importable by construction — the bundle a test
// would import from is the thing that failed — so lifting the source out of the
// HTML is the only way to reach it at all.
//
// It carries the two guards with the worst failure modes in the feature. The
// attempt bound is all that stands between a persistent /assets/ 404 and every
// open tab reloading against a broken origin forever, and the __LA_BOOTED__
// gate is all that stops a reload from discarding an agent turn that has been
// streaming for minutes. Neither is reachable from the module tests.

// The two halves are compared against the same messages below, and both apply a
// same-origin test — so the document the IIFE runs in has to share an origin
// with the one vitest gives the module, or the comparison is meaningless.
const ORIGIN = window.location.origin;
const KEY = '__la_asset_recovery__';

const source = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
const iife = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes('__LA_BOOTED__'));

interface Harness {
  win: Window & typeof globalThis & { __LA_STALE_BUILD__?: string; __LA_BOOTED__?: boolean };
  reloadsScheduled: () => number;
}

function boot({ booted = false, stamp }: { booted?: boolean; stamp?: unknown } = {}): Harness {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `${ORIGIN}/dashboard`,
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Harness['win'];
  let scheduled = 0;
  // The reload is jittered through setTimeout, so counting the scheduling is
  // equivalent and sidesteps jsdom's non-configurable location.reload.
  (win as unknown as { setTimeout: unknown }).setTimeout = () => {
    scheduled++;
    return 0;
  };
  if (stamp !== undefined) win.sessionStorage.setItem(KEY, JSON.stringify(stamp));
  if (booted) win.__LA_BOOTED__ = true;
  (win as unknown as { eval: (s: string) => void }).eval(iife!);
  return { win, reloadsScheduled: () => scheduled };
}

function firePreloadError(win: Harness['win'], message: string): void {
  const e = new win.Event('vite:preloadError') as Event & { payload?: Error };
  e.payload = new win.Error(message) as Error;
  win.dispatchEvent(e);
}

const deadChunk = `Failed to fetch dynamically imported module: ${ORIGIN}/assets/a-11111111.js`;

it('is present in index.html at all', () => {
  expect(iife, 'recovery IIFE not found — it must stay inline in <head>').toBeTruthy();
});

describe('it classifies exactly what the module half classifies', () => {
  // Two implementations of one rule, in two languages, that can never import
  // each other. This is the only place they are run against the same inputs.
  const cases: Array<[string, boolean]> = [
    [deadChunk, true],
    ['Unable to preload CSS for /assets/Chat-a1b2.css', true],
    ['Unable to preload CSS for dist/assets/x.css', false],
    ['Unable to preload CSS for https://cdn.example.com/assets/x.css', false],
  ];

  it.each(cases)('%s', (message, expected) => {
    const { win } = boot({ booted: true });
    firePreloadError(win, message);
    expect(!!win.__LA_STALE_BUILD__).toBe(expected);

    __resetStaleBuildForTests();
    expect(isStaleBuildError(new Error(message))).toBe(expected);
  });

  it('ignores a preloadError carrying no message', () => {
    const { win } = boot({ booted: true });
    firePreloadError(win, '');
    expect(win.__LA_STALE_BUILD__).toBeUndefined();
  });
});

describe('once the app has booted it never reloads', () => {
  it('publishes the reason instead of reloading', () => {
    const { win, reloadsScheduled } = boot({ booted: true });
    let detail: string | null = null;
    win.addEventListener('la:stale-build', ((e: CustomEvent<string>) => {
      detail = e.detail;
    }) as EventListener);

    firePreloadError(win, deadChunk);

    expect(detail).toBe('preload');
    expect(reloadsScheduled()).toBe(0);
  });
});

describe('before boot it reloads, but a bounded number of times', () => {
  it('records the first attempt and schedules one reload', () => {
    const { win, reloadsScheduled } = boot();
    firePreloadError(win, deadChunk);

    expect(JSON.parse(win.sessionStorage.getItem(KEY)!).n).toBe(1);
    expect(reloadsScheduled()).toBe(1);
  });

  it('does not re-stamp for a second failure inside the window', () => {
    const { win } = boot();
    firePreloadError(win, deadChunk);
    const first = win.sessionStorage.getItem(KEY);
    firePreloadError(win, deadChunk);

    expect(win.sessionStorage.getItem(KEY)).toBe(first);
  });

  it('stops reloading after the attempt cap and offers a control instead', () => {
    // The reloaded document, arriving at a build that is still dead. Leaving it
    // blank here is the exact failure this feature exists to remove.
    const { win, reloadsScheduled } = boot({ stamp: { t: 1, n: 2 } });
    firePreloadError(win, deadChunk);

    expect(reloadsScheduled()).toBe(0);
    const root = win.document.getElementById('root')!;
    expect(root.querySelector('[role=alert]')).toBeTruthy();
    expect(root.querySelector('button')).toBeTruthy();
  });

  it('clamps a future timestamp rather than trusting it', () => {
    // Unclamped, one corrupt or clock-skewed stamp switches recovery off for
    // the whole session and nothing ever says so.
    const { win } = boot({ stamp: { t: Date.now() + 9e9, n: 0 } });
    firePreloadError(win, deadChunk);

    const state = JSON.parse(win.sessionStorage.getItem(KEY)!);
    expect(state.n).toBe(1);
    expect(state.t).toBeLessThan(Date.now() + 1000);
  });
});
