/**
 * Typewriter feel benchmark. Not part of the default e2e run.
 *
 *   PERF=1 PERF_LABEL=<label> pnpm exec playwright test e2e/perf/typewriter.spec.js
 *
 * Streams the long reply at a fast model's pace twice: once as an even token
 * stream and once in lumps (what a proxy or a Redis batch delivers), and
 * records what the eye would notice in the reveal: how far the text trails
 * the model, how long it keeps typing after the model stopped, stalls, and
 * jumps. Writes one JSON per scenario to perf-results/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { configureSSE, resetMockServer, mockAPI, test, expect } from '../fixtures.js';
import { sampleWorkspace, sampleThread, sseEvents } from '../helpers/mockResponses.js';
import { buildReply, chunk, END_MARKER } from './streamFixture.js';

const WS = 'a0000001-0000-4000-8000-000000000001';
const TH = 'b0000001-0000-4000-8000-000000000001';
// ~500 chars/s, the pace of a fast model.
const SCENARIOS = [
  { name: 'even', chars: 16, delayMs: 32 },
  { name: 'lumpy', chars: 160, delayMs: 320 },
];

function label() {
  if (process.env.PERF_LABEL) return process.env.PERF_LABEL;
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unlabeled'; }
}

function overrides() {
  const ws = sampleWorkspace();
  const th = sampleThread();
  return {
    'GET /workspaces': { workspaces: [ws], total: 1, limit: 20, offset: 0 },
    [`GET /workspaces/${WS}`]: ws,
    'GET /threads': { threads: [th], total: 1 },
    [`GET /threads/${TH}`]: th,
    [`GET /threads/${TH}/status`]: { can_reconnect: false, status: 'idle' },
    [`GET /threads/${TH}/turns`]: { thread_id: TH, turns: [{ turn_index: 0, edit_checkpoint_id: 'cp-edit-0', regenerate_checkpoint_id: 'cp-regen-0' }], retry_checkpoint_id: 'cp-retry-0' },
    [`GET /workspaces/${WS}/files`]: { files: [] },
  };
}

// Per frame: transcript text length and whether the composer still shows the
// stop control (the stream is live). The stop control flips on the final
// event, which stamps when the model finished without asking the client.
const PROBE = `(() => {
  const P = (window.__tw = { frames: [], running: false });
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
  function tick(ts) {
    if (P.running) {
      const main = document.querySelector('main') || document.body;
      const live = !!document.querySelector('button[aria-label="Stop"]');
      const sc = findScroller();
      P.frames.push([ts, main.textContent.length, live ? 1 : 0, sc ? sc.scrollTop : -1, sc ? sc.scrollHeight - sc.clientHeight : -1]);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  P.start = () => { P.frames = []; P.running = true; };
  P.stop = () => { P.running = false; return P.frames; };
})();`;

function analyze(frames, replyChars) {
  // Resample to fixed 50 ms buckets so the numbers do not depend on the
  // machine's frame rate (headless Chromium runs rAF at ~110 fps, no vsync).
  const STEP = 50;
  const t0 = frames[0][0], t1 = frames[frames.length - 1][0];
  const at = [];
  let j = 0;
  for (let t = t0; t <= t1; t += STEP) {
    while (j + 1 < frames.length && frames[j + 1][0] <= t) j++;
    at.push([t, frames[j][1], frames[j][2]]);
  }
  let first = -1, last = -1;
  for (let i = 1; i < at.length; i++) if (at[i][1] > at[i - 1][1]) { if (first < 0) first = i; last = i; }
  if (first < 0) return null;
  const liveFrames = frames.filter((f) => f[2]).length;
  let liveEnd = -1;
  for (let i = first; i < at.length; i++) if (at[i][2] === 0 && at[i - 1][2] === 1) { liveEnd = i; break; }
  const modelDoneAt = liveEnd > 0 ? at[liveEnd][0] : null;
  const gains = [];
  let stalls = 0, stallBuckets = 0, run = 0, maxGain = 0, maxGainAt = 0, firstStallAt = -1;
  for (let i = first; i <= last; i++) {
    const g = at[i][1] - at[i - 1][1];
    gains.push(g);
    if (g > maxGain) { maxGain = g; maxGainAt = Math.round(at[i][0] - at[first][0]); }
    // A stall: no visible progress for 150 ms or more while the model is still talking.
    if (g <= 0 && at[i][2] === 1) { run++; if (run === 3) { stalls++; if (firstStallAt < 0) firstStallAt = Math.round(at[i][0] - at[first][0]); } if (run >= 3) stallBuckets++; } else run = 0;
  }
  const sorted = gains.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
  const sd = Math.sqrt(gains.reduce((a, b) => a + (b - mean) ** 2, 0) / gains.length);
  // Follow scroll while the model is talking: how far the view sits above the
  // bottom, how often it moves backwards, and how uneven its motion is.
  const live = frames.filter((f) => f[2] === 1 && f[3] >= 0);
  const dist = live.map((f) => f[4] - f[3]).sort((a, b) => a - b);
  let back = 0; const moves = [];
  for (let i = 1; i < live.length; i++) { const d = live[i][3] - live[i - 1][3]; if (d < -1) back++; if (d > 0) moves.push(d); }
  const mmean = moves.reduce((a, b) => a + b, 0) / (moves.length || 1);
  const msd = Math.sqrt(moves.reduce((a, b) => a + (b - mmean) ** 2, 0) / (moves.length || 1));
  const follow = live.length ? {
    distP50: Math.round(dist[Math.floor(dist.length * 0.5)]), distP95: Math.round(dist[Math.floor(dist.length * 0.95)]), distMax: Math.round(dist[dist.length - 1]),
    backwardFrames: back, movingFrames: moves.length, moveCv: +(msd / (mmean || 1)).toFixed(2), maxMovePx: Math.round(Math.max(...moves, 0)),
  } : null;
  const fgaps = [];
  for (let i = 1; i < frames.length; i++) fgaps.push(frames[i][0] - frames[i - 1][0]);
  fgaps.sort((a, b) => a - b);
  return {
    revealMs: Math.round(at[last][0] - at[first][0]),
    // How long the text keeps typing after the model stopped (null: stop control never seen).
    tailAfterModelMs: modelDoneAt === null ? null : Math.round(at[last][0] - modelDoneAt),
    stalls, stallMs: stallBuckets * STEP, firstStallAtMs: firstStallAt,
    // Buckets that showed more than three times the typical amount: a visible jump.
    jumps: gains.filter((g) => g > Math.max(3 * median, 60)).length,
    maxGainPer50ms: maxGain, maxGainAtMs: maxGainAt, medianGainPer50ms: median,
    // Text still hidden when the model finished: what the final frame has to pop or type.
    backlogAtModelDone: modelDoneAt === null ? at[last][1] - at[Math.max(first, last - 1)][1] : null,
    // Unevenness of the reveal, bucket to bucket (0 = perfectly steady).
    speedCv: +(sd / mean).toFixed(2),
    meanCharsPerSec: Math.round(mean * 1000 / STEP),
    frameGapP95: +fgaps[Math.floor(fgaps.length * 0.95)].toFixed(1),
    liveFrames, replyChars, follow,
  };
}

// Headed gives real vsync; the reveal is judged at the screen's refresh rate.
test.use({ headless: !process.env.PERF_HEADED });

test.describe('typewriter feel', () => {
  test.skip(!process.env.PERF, 'set PERF=1 to run the typewriter benchmark');
  test.setTimeout(180_000);
  test.beforeEach(async () => { await resetMockServer(); });

  for (const sc of SCENARIOS) {
    test(`fast model, ${sc.name} arrival`, async ({ page }, testInfo) => {
      await page.addInitScript(PROBE);
      await mockAPI(page, overrides());
      await configureSSE({ method: 'GET', path: `/api/v1/threads/${TH}/messages/replay`, events: [sseEvents.replayDone()], delay: 10 });
      const reply = buildReply();
      const events = [];
      for (const c of chunk(reply, sc.chars)) events.push(sseEvents.messageChunk(c));
      events.push({ ...sseEvents.finishStop(), delayAfter: 0 });
      events.push(sseEvents.creditUsage());
      await configureSSE({ method: 'POST', path: `/api/v1/threads/${TH}/messages`, events, delay: sc.delayMs });

      await page.goto(`/chat/t/${TH}`);
      await page.waitForSelector('textarea', { timeout: 10000 });
      await page.waitForTimeout(500);
      await page.locator('textarea').fill('Give me an earnings deep dive on NVDA');
      await page.evaluate(() => window.__tw.start());
      await page.locator('button[aria-label="Send message"]').click();
      await expect(page.getByText(END_MARKER)).toBeVisible({ timeout: 150_000 });
      await page.waitForTimeout(1500);
      const frames = await page.evaluate(() => window.__tw.stop());
      const m = analyze(frames, reply.length);
      const run = { label: label(), scenario: sc, at: new Date().toISOString(), metrics: m };
      const dir = path.resolve('perf-results');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `typewriter-${sc.name}-${run.label}-${Date.now()}-${testInfo.repeatEachIndex}.json`), JSON.stringify(run, null, 2));
      console.log(`[typewriter ${sc.name} ${run.label}] ${JSON.stringify(m)}`);
      expect(m).not.toBeNull();
    });
  }
});
