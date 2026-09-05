/**
 * Streaming smoothness benchmark. Not part of the default e2e run.
 *
 *   PERF=1 PERF_BUILD=1 PERF_LABEL=<label> pnpm exec playwright test e2e/perf --repeat-each=3
 *   node scripts/perf-summary.mjs <baseline-label> <label>
 *
 * Streams a long reply through the mock SSE server at token cadence under CPU
 * throttling and writes one JSON per run to perf-results/. PERF_BUILD serves a
 * production build (the number that matters); without it the dev server runs,
 * which is faster to iterate on but inflates React's share. PERF_PROFILE=1 adds
 * a V8 CPU profile summarized per module, for finding what to fix next;
 * PERF_TRACE=1 adds a Chrome trace summed per event kind (Layout, Paint, ...),
 * which is where the profiler's "(program)" time goes. Requests issued during
 * the stream are tallied by path: a control that writes and refetches in a
 * loop shows up there long before it shows up in the frame numbers.
 * PERF_CPU (default 4) is the CPU throttle; PERF_CHUNK_MS / PERF_CHUNK_CHARS set
 * the token cadence. The label defaults to the git short sha.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { configureSSE, resetMockServer, mockAPI, test, expect } from '../fixtures.js';
import { sampleWorkspace, sampleThread, sseEvents } from '../helpers/mockResponses.js';
import { buildReply, buildReasoning, chunk, END_MARKER } from './streamFixture.js';
import { PROBE_SOURCE } from './metrics.js';

const WS = 'a0000001-0000-4000-8000-000000000001';
const TH = 'b0000001-0000-4000-8000-000000000001';
const CPU_RATE = Number(process.env.PERF_CPU || 4);
const CHUNK_DELAY_MS = Number(process.env.PERF_CHUNK_MS || 8);
const CHUNK_CHARS = Number(process.env.PERF_CHUNK_CHARS || 8);
// PERF_PROFILE=1 also records a V8 CPU profile and writes self-time per module.
const PROFILE = !!process.env.PERF_PROFILE;
// PERF_TRACE=1 records a Chrome trace and sums renderer time per event kind
// (Layout, UpdateLayoutTree, Paint, ...), which is where the JS profiler's
// "(program)" bucket goes.
const TRACE = !!process.env.PERF_TRACE;

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
    [`GET /threads/${TH}/turns`]: {
      thread_id: TH,
      turns: [{ turn_index: 0, edit_checkpoint_id: 'cp-edit-0', regenerate_checkpoint_id: 'cp-regen-0' }],
      retry_checkpoint_id: 'cp-retry-0',
    },
    [`GET /workspaces/${WS}/files`]: { files: [] },
  };
}

/** Reasoning, four tool calls, then the long reply, all at token cadence. */
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

/** Self time per module and per function from a V8 CPU profile. */
function summarizeProfile(p) {
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const selfUs = new Map();
  for (let i = 0; i < p.samples.length; i++) {
    selfUs.set(p.samples[i], (selfUs.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
  }
  const moduleOf = (url) => {
    if (!url) return '(native/anonymous)';
    const dep = url.match(/\/node_modules\/\.vite\/deps\/([^?]+)/);
    if (dep) return `dep:${dep[1].replace(/\.js$/, '')}`;
    const nm = url.match(/\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    if (nm) return `dep:${nm[1]}`;
    const src = url.match(/\/src\/(.+?)(\?|$)/);
    if (src) return `src/${src[1]}`;
    return url.replace(/\?.*$/, '').split('/').slice(-2).join('/');
  };
  const byModule = new Map();
  const byFunction = new Map();
  for (const [id, us] of selfUs) {
    const n = nodes.get(id);
    if (!n) continue;
    const { functionName, url, lineNumber } = n.callFrame;
    const mod = moduleOf(url);
    byModule.set(mod, (byModule.get(mod) || 0) + us);
    const fn = `${functionName || '(anonymous)'} ${mod}:${lineNumber}`;
    byFunction.set(fn, (byFunction.get(fn) || 0) + us);
  }
  const top = (m) => [...m].map(([k, us]) => [k, Math.round(us / 1000)]).sort((a, b) => b[1] - a[1]).slice(0, 40);
  return { byModule: top(byModule), byFunction: top(byFunction) };
}

/** Wall time per trace event name, for the renderer main thread only. */
function summarizeTrace(events) {
  const byName = new Map();
  const count = new Map();
  const open = new Map();
  for (const e of events) {
    if (e.cat && !/devtools\.timeline/.test(e.cat)) continue;
    if (e.ph === 'X' && typeof e.dur === 'number') {
      byName.set(e.name, (byName.get(e.name) || 0) + e.dur);
      count.set(e.name, (count.get(e.name) || 0) + 1);
    } else if (e.ph === 'B') {
      open.set(`${e.name}:${e.tid}`, e.ts);
    } else if (e.ph === 'E') {
      const k = `${e.name}:${e.tid}`;
      if (open.has(k)) {
        byName.set(e.name, (byName.get(e.name) || 0) + (e.ts - open.get(k)));
        count.set(e.name, (count.get(e.name) || 0) + 1);
        open.delete(k);
      }
    }
  }
  return [...byName].map(([k, us]) => [k, Math.round(us / 1000), count.get(k)]).sort((a, b) => b[1] - a[1]).slice(0, 25);
}

test.describe('streaming smoothness', () => {
  test.skip(!process.env.PERF, 'set PERF=1 to run the smoothness benchmark');
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    await resetMockServer();
  });

  test('long reply at token cadence', async ({ page }, testInfo) => {
    await page.addInitScript(PROBE_SOURCE);
    await mockAPI(page, overrides());
    await configureSSE({
      method: 'GET',
      path: `/api/v1/threads/${TH}/messages/replay`,
      events: [sseEvents.replayDone()],
      delay: 10,
    });
    const events = buildEvents();
    await configureSSE({
      method: 'POST',
      path: `/api/v1/threads/${TH}/messages`,
      events,
      delay: CHUNK_DELAY_MS,
    });

    await page.goto(`/chat/t/${TH}`);
    await page.waitForSelector('textarea', { timeout: 10000 });

    const cdp = await page.context().newCDPSession(page);
    if (CPU_RATE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    if (PROFILE) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    }
    // Let the throttled page settle before the clock starts.
    await page.waitForTimeout(500);
    if (PROFILE) await cdp.send('Profiler.start');
    const traceEvents = [];
    if (TRACE) {
      cdp.on('Tracing.dataCollected', (d) => traceEvents.push(...d.value));
      await cdp.send('Tracing.start', {
        traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] },
        transferMode: 'ReportEvents',
      });
    }

    const reqs = new Map();
    page.on('request', (r) => { const k = `${r.method()} ${new URL(r.url()).pathname}`; reqs.set(k, (reqs.get(k) || 0) + 1); });
    await page.locator('textarea').fill('Give me an earnings deep dive on NVDA');
    await page.evaluate(() => window.__smooth.start(document.querySelector('main') || document.body));
    await page.locator('button[aria-label="Send message"]').click();

    await expect(page.getByText(END_MARKER)).toBeVisible({ timeout: 150_000 });
    // The typewriter and the last fold animations run past the final chunk.
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => window.__smooth.stop());
    let profile = null;
    if (PROFILE) {
      const { profile: p } = await cdp.send('Profiler.stop');
      profile = summarizeProfile(p);
    }
    let trace = null;
    if (TRACE) {
      const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      await done;
      trace = summarizeTrace(traceEvents);
    }
    if (CPU_RATE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    const run = {
      label: label(),
      at: new Date().toISOString(),
      config: { build: process.env.PERF_BUILD ? 'production' : 'dev', cpuRate: CPU_RATE, chunkDelayMs: CHUNK_DELAY_MS, chunkChars: CHUNK_CHARS, events: events.length, replyChars: buildReply().length },
      metrics: m,
      profile,
      trace,
    };
    const dir = path.resolve('perf-results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `streaming-${run.label}-${Date.now()}-${testInfo.repeatEachIndex}.json`);
    fs.writeFileSync(file, JSON.stringify(run, null, 2));

    const { durationMs, fps, gapP95, gapMax, framesOver50, frozenMs, loafCount, loafMaxMs, mutations } = m;
    console.log(`[perf ${run.label}] ${durationMs}ms fps=${fps} p95=${gapP95}ms max=${gapMax}ms >50ms=${framesOver50} frozen=${frozenMs}ms loaf=${loafCount}/${loafMaxMs}ms mutations=${mutations}`);
    if (profile) {
      console.log(`[perf ${run.label}] self time by module (ms):`);
      for (const [mod, ms] of profile.byModule.slice(0, 18)) console.log(`    ${String(ms).padStart(6)}  ${mod}`);
      console.log(`[perf ${run.label}] top functions (ms):`);
      for (const [fn, ms] of profile.byFunction.slice(0, 18)) console.log(`    ${String(ms).padStart(6)}  ${fn}`);
    }
    if (trace) {
      console.log(`[perf ${run.label}] requests during the stream:`);
      for (const [k, n] of [...reqs].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(n).padStart(6)}  ${k}`);
      console.log(`[perf ${run.label}] trace time by event (ms, count):`);
      for (const [name, ms, n] of trace) console.log(`    ${String(ms).padStart(6)}  ${String(n).padStart(6)}  ${name}`);
    }
    expect(m.frames).toBeGreaterThan(0);
  });
});
