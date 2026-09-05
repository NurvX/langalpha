/**
 * Catch-up glitch repro: what the transcript does when presentation falls
 * behind state and then catches up in a burst. Not part of the default run.
 *
 *   PERF=1 pnpm exec playwright test e2e/perf/return-glitch
 *
 * Two ways to fall behind:
 *  - reload mid-stream: the in-flight run is not in the history replay, so
 *    the reconnect stream re-delivers the whole run's buffer in one burst into
 *    a fresh bubble.
 *  - hidden tab: rAF stops (typewriter, framer, scroll follow) while SSE keeps
 *    landing in state; emulated here by parking every rAF callback for a while.
 *
 * Per frame the probe samples transcript text length and scrollTop, and
 * collects layout-shift entries. A "burst frame" gains far more text than the
 * cadence or the typewriter can produce; a "drop frame" loses text (content
 * replaced or duplicated and collapsed); a "scroll jump" moves more than
 * 300 px in one frame.
 */
import { configureSSE, resetMockServer, mockAPI, test, expect } from '../fixtures.js';
import { sampleWorkspace, sampleThread, sseEvents } from '../helpers/mockResponses.js';
import { buildReply, buildReasoning, chunk, END_MARKER } from './streamFixture.js';

const WS = 'a0000001-0000-4000-8000-000000000001';
const TH = 'b0000001-0000-4000-8000-000000000001';
const CHUNK_MS = 40;
const CHUNK_CHARS = 8;
const PROMPT = 'Give me an earnings deep dive on NVDA';

const PROBE = `(() => {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCaf = window.cancelAnimationFrame.bind(window);
  const R = (window.__raf = { frozen: false, queue: [], nextId: -1 });
  window.requestAnimationFrame = (cb) => {
    if (!R.frozen) return nativeRaf(cb);
    const id = R.nextId--;
    R.queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (id < 0) { R.queue = R.queue.filter((q) => q.id !== id); return; }
    nativeCaf(id);
  };
  R.freeze = () => { R.frozen = true; };
  R.thaw = () => {
    R.frozen = false;
    const q = R.queue; R.queue = [];
    nativeRaf((ts) => { for (const { cb } of q) { try { cb(ts); } catch (e) { console.error(e); } } });
  };

  const P = (window.__probe = { painted: [], samples: [], shifts: [], marks: {} });
  let scroller = null;
  function findScroller() {
    if (scroller && scroller.isConnected) return scroller;
    const main = document.querySelector('main') || document.body;
    for (const el of main.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50) { scroller = el; return el; }
    }
    return null;
  }
  function sample(ts) {
    const main = document.querySelector('main') || document.body;
    const s = findScroller();
    const len = main.textContent.length;
    const prev = P.samples[P.samples.length - 1];
    let note;
    if (prev && Math.abs(len - prev.len) > 5000) {
      const big = [];
      for (const el of main.querySelectorAll('*')) {
        if (el.children.length === 0 && el.textContent.length > 5000) big.push(el.tagName + '.' + String(el.className).slice(0, 60) + ':' + el.textContent.length + ':' + el.textContent.slice(0, 80));
      }
      note = big.slice(0, 5).join(' | ');
    }
    P.samples.push({ t: ts, len, top: s ? s.scrollTop : -1, h: s ? s.scrollHeight - s.clientHeight : -1, note });
    // A task queued from rAF runs after this frame is painted, and a layout or
    // resize-observer scroll lands between the two, so this is what the screen showed.
    setTimeout(() => {
      const sc = findScroller();
      const m = document.querySelector('main') || document.body;
      P.painted.push({ t: performance.now(), len: m.textContent.length, top: sc ? sc.scrollTop : -1, h: sc ? sc.scrollHeight - sc.clientHeight : -1 });
    }, 0);
    nativeRaf(sample);
  }
  nativeRaf(sample);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) P.shifts.push({ t: e.startTime, v: e.value });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  P.mark = (name) => { P.marks[name] = performance.now(); };
  // Poll the transcript's visible text and keep the snapshot around the
  // largest drop, so a vanished block can be named rather than sized.
  P.watchDrops = (ms) => {
    const main = document.querySelector('main') || document.body;
    let prev = main.innerText; let worst = 0; P.drop = null;
    const iv = setInterval(() => {
      const cur = main.innerText;
      if (prev.length - cur.length > worst) {
        worst = prev.length - cur.length;
        const before = new Set(cur.split(String.fromCharCode(10)));
        P.drop = { t: Math.round(performance.now()), size: worst, removed: prev.split(String.fromCharCode(10)).filter((l) => l.trim() && !before.has(l)).slice(0, 12) };
      }
      prev = cur;
    }, 100);
    setTimeout(() => clearInterval(iv), ms);
  };
  P.report = (since) => {
    const t0 = P.marks[since] ?? 0;
    const xs = P.samples.filter((x) => x.t >= t0);
    let bursts = 0, burstChars = 0, maxGain = 0, drops = 0, maxDrop = 0, jumps = 0, maxJump = 0, lastBurstAt = t0, awayFromBottomFrames = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i].len - xs[i - 1].len;
      if (d > 20) { bursts++; burstChars += d; lastBurstAt = xs[i].t; }
      if (d > maxGain) maxGain = d;
      if (d < 0) { drops++; if (-d > maxDrop) maxDrop = -d; }
      const j = Math.abs(xs[i].top - xs[i - 1].top);
      if (xs[i].top >= 0 && j > 300) { jumps++; if (j > maxJump) maxJump = j; }
      if (xs[i].h > 0 && xs[i].h - xs[i].top > 400) awayFromBottomFrames++;
    }
    const cls = P.shifts.filter((s) => s.t >= t0).reduce((a, s) => a + s.v, 0);
    const first = xs[0];
    const gapAtResume = first && first.h > 0 ? Math.round(first.h - first.top) : -1;
    let settleAt = -1, scrollFrames = 0;
    for (let i = 1; i < xs.length; i++) {
      if (xs[i].top !== xs[i - 1].top) scrollFrames++;
      if (settleAt < 0 && xs[i].h > 0 && xs[i].h - xs[i].top < 50) settleAt = xs[i].t;
    }
    // Text growth per 500 ms bucket for the first 12 s: the cadence delivers
    // ~100 chars per bucket, so a bucket far above that is catch-up.
    const series = [];
    for (let b = 0; b < 24; b++) {
      const a = xs.filter((x) => x.t >= t0 + b * 500 && x.t < t0 + (b + 1) * 500);
      series.push(a.length ? a[a.length - 1].len - a[0].len : 0);
    }
    const notable = [];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i].len - xs[i - 1].len; const j = xs[i].top - xs[i - 1].top;
      if (Math.abs(d) > 60 || Math.abs(j) > 300 || xs[i].note) notable.push({ t: Math.round(xs[i].t - t0), d, top: xs[i].top, j: Math.round(j), note: xs[i].note });
    }
    const bigShifts = P.shifts.filter((s) => s.t >= t0 && s.v > 0.02).map((s) => ({ t: Math.round(s.t - t0), v: +s.v.toFixed(3) }));
    // Painted frames, after the transcript first appears, that showed the
    // scroller more than 400 px short of the bottom: what the eye saw at the top.
    const ps = P.painted.filter((x) => x.t >= t0);
    const firstShown = ps.findIndex((x, i) => i > 0 && x.len - ps[i - 1].len > 500);
    const paintedAwayFrames = firstShown < 0 ? -1 : ps.slice(firstShown).filter((x) => x.h > 0 && x.h - x.top > 400).length;
    return {
      paintedAwayFrames, paintedFirstTop: firstShown < 0 ? -1 : ps[firstShown].top, paintedFirstGap: firstShown < 0 ? -1 : ps[firstShown].h - ps[firstShown].top,
      frames: xs.length, burstFrames: bursts, burstChars, maxGainPerFrame: maxGain,
      catchUpMs: Math.round(lastBurstAt - t0), dropFrames: drops, maxDrop,
      scrollJumps: jumps, maxScrollJumpPx: Math.round(maxJump), awayFromBottomFrames,
      cls: +cls.toFixed(3), shifts: P.shifts.filter((s) => s.t >= t0).length,
      textLen: xs.length ? xs[xs.length - 1].len : 0,
      growthPer500ms: series, gapAtResumePx: gapAtResume, scrollSettleMs: settleAt < 0 ? -1 : Math.round(settleAt - t0), scrollFrames,
      notable: notable.slice(0, 40), bigShifts: bigShifts.slice(0, 20),
    };
  };
})();`;

const TH2 = 'b0000002-0000-4000-8000-000000000002';

function overrides(state) {
  const ws = sampleWorkspace();
  const th = sampleThread();
  const th2 = { ...sampleThread(), id: TH2, thread_id: TH2, title: 'Other thread' };
  return {
    [`GET /threads/${TH2}`]: th2,
    [`GET /threads/${TH2}/status`]: { can_reconnect: false, status: 'idle' },
    [`GET /threads/${TH2}/turns`]: { thread_id: TH2, turns: [], retry_checkpoint_id: null },
    'GET /workspaces': { workspaces: [ws], total: 1, limit: 20, offset: 0 },
    [`GET /workspaces/${WS}`]: ws,
    'GET /threads': { threads: [th, th2], total: 2 },
    [`GET /threads/${TH}`]: th,
    [`GET /threads/${TH}/status`]: (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(state.reconnectable ? { can_reconnect: true, status: 'streaming', run_id: 'run-1' } : { can_reconnect: false, status: 'idle' }),
    }),
    [`GET /threads/${TH}/turns`]: {
      thread_id: TH,
      turns: [{ turn_index: 0, edit_checkpoint_id: 'cp-edit-0', regenerate_checkpoint_id: 'cp-regen-0' }],
      retry_checkpoint_id: 'cp-retry-0',
    },
    [`GET /workspaces/${WS}/files`]: { files: [] },
  };
}

function buildEvents() {
  const events = [];
  events.push(sseEvents.messageChunk('start', 'reasoning_signal'));
  for (const c of chunk(buildReasoning(), CHUNK_CHARS)) events.push(sseEvents.messageChunk(c, 'reasoning'));
  events.push(sseEvents.messageChunk('complete', 'reasoning_signal'));
  const calls = ['toolu_p1', 'toolu_p2', 'toolu_p3', 'toolu_p4'];
  events.push(sseEvents.toolCalls(calls.map((id, i) => ({ name: 'bash', args: { command: `echo ${i}` }, id }))));
  events.push(sseEvents.finishToolCalls());
  for (const id of calls) events.push({ ...sseEvents.toolCallResult(id, 'ok'), delayAfter: 150 });
  for (const c of chunk(buildReply(), CHUNK_CHARS)) events.push(sseEvents.messageChunk(c));
  events.push(sseEvents.finishStop());
  events.push(sseEvents.creditUsage());
  return events;
}

/** Index of the first event whose text carries `marker`. */
function indexOfMarker(events, marker) {
  let acc = '';
  for (let i = 0; i < events.length; i++) {
    const d = events[i]?.data;
    const c = typeof d === 'string' ? (() => { try { return JSON.parse(d); } catch { return null; } })() : d;
    const text = c?.content ?? c?.data?.content ?? '';
    if (typeof text === 'string') acc += text;
    if (acc.includes(marker)) return i;
  }
  return -1;
}

async function startStream(page, state, events) {
  await page.addInitScript(PROBE);
  await mockAPI(page, overrides(state));
  await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`, events: [sseEvents.replayDone()], delay: 10 });
  await configureSSE({ method: 'POST', path: `/api/v1/threads/${TH}/messages`, events, delay: CHUNK_MS });
  await page.goto(`/chat/t/${TH}`);
  await page.waitForSelector('textarea', { timeout: 10000 });
  await page.locator('textarea').fill(PROMPT);
  await page.locator('button[aria-label="Send message"]').click();
}

test.describe('catch-up glitch', () => {
  test.skip(!process.env.PERF, 'set PERF=1 to run the catch-up repro');
  test.setTimeout(180_000);
  test.beforeEach(async () => { await resetMockServer(); });

  test('reload mid-stream', async ({ page }) => {
    const state = { reconnectable: false };
    const events = buildEvents();
    await startStream(page, state, events);
    const marker = 'Section 3';
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
    const k = indexOfMarker(events, marker) + 40;
    // 2 ms apart so each event is its own socket read, as through a proxy; 0 lets
    // Node coalesce the whole backlog into one read and one React render.
    const backlog = events.slice(0, k).map((e) => ({ ...e, delayAfter: Number(process.env.PERF_BACKLOG_MS ?? 2) }));
    const tail = events.slice(k);
    state.reconnectable = true;
    await configureSSE({
      method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`,
      events: [sseEvents.userMessage(PROMPT), sseEvents.replayDone()], delay: 10,
    });
    // PERF_NO_CAUGHT_UP=1 omits the marker (a server without it): the client
    // falls back to a timer and the typewriter's catch-up rule.
    const boundary = process.env.PERF_NO_CAUGHT_UP ? [] : [{ ...sseEvents.caughtUp(), delayAfter: 0 }];
    await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/stream`, events: [...backlog, ...boundary, ...tail], delay: CHUNK_MS });

    await page.reload();
    await page.waitForSelector('textarea', { timeout: 10000 });
    await page.waitForFunction(() => !!window.__probe, null, { timeout: 10000 });
    await page.evaluate(() => window.__probe.watchDrops(8000));
    await expect(page.getByText(END_MARKER)).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => window.__probe.report());
    console.log('[reload] ' + JSON.stringify(r));
    console.log('[reload-drop] ' + JSON.stringify(await page.evaluate(() => window.__probe.drop)));
  });

  for (const target of ['thread', 'dashboard']) {
    test(`in-app navigation to ${target} and back mid-stream`, async ({ page }) => {
      const state = { reconnectable: false };
      const events = buildEvents();
      await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH2}/messages/replay`, events: [sseEvents.replayDone()], delay: 10 });
      await startStream(page, state, events);
      await expect(page.getByText('Section 2', { exact: false }).first()).toBeVisible({ timeout: 60_000 });
      const dest = target === 'thread' ? `/chat/t/${TH2}` : '/dashboard';
      if (target === 'dashboard') {
        // Leaving the chat route unmounts it and drops the live stream; the
        // return is a reconnect, served here the way the reload case is.
        const k = indexOfMarker(events, 'Section 3') + 40;
        const backlog = events.slice(0, k).map((e) => ({ ...e, delayAfter: Number(process.env.PERF_BACKLOG_MS ?? 2) }));
        state.reconnectable = true;
        await configureSSE({
          method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`,
          events: [sseEvents.userMessage(PROMPT), sseEvents.replayDone()], delay: 10,
        });
        const boundary = process.env.PERF_NO_CAUGHT_UP ? [] : [{ ...sseEvents.caughtUp(), delayAfter: 0 }];
        await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/stream`, events: [...backlog, ...boundary, ...events.slice(k)], delay: CHUNK_MS });
      }
      // Router-level navigation without a document load: pushState + popstate.
      await page.evaluate((d) => { history.pushState({}, '', d); dispatchEvent(new PopStateEvent('popstate')); }, dest);
      await page.waitForTimeout(500);
      console.log(`[nav:${target}] away url=` + await page.evaluate(() => location.pathname) + ' chatTextLen=' + await page.evaluate(() => (document.querySelector('main') || document.body).textContent.length));
      await page.waitForTimeout(6000);
      await page.evaluate(() => { window.__probe.mark('resume'); history.back(); });
      await page.waitForTimeout(50);
      console.log(`[nav:${target}] back url=` + await page.evaluate(() => location.pathname));
      await expect(page.getByText(END_MARKER)).toBeVisible({ timeout: 120_000 });
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => window.__probe.report('resume'));
      console.log(`[nav:${target}] ` + JSON.stringify(r));
    });
  }

  test('hidden tab mid-stream', async ({ page }) => {
    const state = { reconnectable: false };
    const events = buildEvents();
    await startStream(page, state, events);
    await expect(page.getByText('Section 2', { exact: false }).first()).toBeVisible({ timeout: 60_000 });
    if (process.env.PERF_HEADED) {
      // A real background tab: rAF paused, timers throttled, no layout, no
      // smooth-scroll ticks. Needs --headed; headless tabs never go hidden.
      const other = await page.context().newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await page.waitForTimeout(8000);
      await page.evaluate(() => window.__probe.mark('resume'));
      await page.bringToFront();
      const vis = await page.evaluate(() => document.visibilityState);
      console.log('[hidden] visibility after return: ' + vis);
      await other.close();
    } else {
      const len = () => page.evaluate(() => (document.querySelector('main') || document.body).textContent.length);
      await page.evaluate(() => window.__raf.freeze());
      const atFreeze = await len();
      await page.waitForTimeout(6000);
      const atThaw = await len();
      await page.evaluate(() => { window.__probe.mark('resume'); window.__raf.thaw(); });
      await page.waitForTimeout(100); const after100 = await len();
      await page.waitForTimeout(900); const after1000 = await len();
      await page.waitForTimeout(2000); const after3000 = await len();
      console.log(`[hidden] len freeze=${atFreeze} thaw=${atThaw} +100ms=${after100} +1s=${after1000} +3s=${after3000}`);
    }
    await expect(page.getByText(END_MARKER)).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => window.__probe.report('resume'));
    console.log('[hidden] ' + JSON.stringify(r));
  });
});
