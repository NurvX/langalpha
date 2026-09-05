#!/usr/bin/env node
/**
 * Summarize streaming benchmark runs: median per label, side by side.
 *
 *   node scripts/perf-summary.mjs            # every label in perf-results/
 *   node scripts/perf-summary.mjs base opt1  # only these, in this order
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('perf-results');
const want = process.argv.slice(2);
const runs = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.startsWith('streaming-') && f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  : [];
if (!runs.length) { console.log('no runs in perf-results/'); process.exit(0); }

const byLabel = new Map();
for (const r of runs) {
  if (want.length && !want.includes(r.label)) continue;
  if (!byLabel.has(r.label)) byLabel.set(r.label, []);
  byLabel.get(r.label).push(r);
}
const labels = want.length ? want.filter((l) => byLabel.has(l)) : [...byLabel.keys()];

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const ROWS = [
  ['durationMs', 'stream duration (ms)', 'lower'],
  ['fps', 'frames per second', 'higher'],
  ['gapP50', 'frame gap p50 (ms)', 'lower'],
  ['gapP95', 'frame gap p95 (ms)', 'lower'],
  ['gapP99', 'frame gap p99 (ms)', 'lower'],
  ['gapMax', 'worst frame gap (ms)', 'lower'],
  ['framesOver33', 'frames over 33 ms', 'lower'],
  ['framesOver50', 'frames over 50 ms', 'lower'],
  ['framesOver100', 'frames over 100 ms', 'lower'],
  ['frozenMs', 'time frozen (ms)', 'lower'],
  ['loafCount', 'long animation frames', 'lower'],
  ['loafTotalMs', 'LoAF total (ms)', 'lower'],
  ['loafBlockingMs', 'LoAF blocking (ms)', 'lower'],
  ['loafMaxMs', 'LoAF worst (ms)', 'lower'],
  ['longTasks', 'long tasks', 'lower'],
  ['mutations', 'DOM mutation records', 'lower'],
  ['nodesAdded', 'DOM nodes added', 'lower'],
  ['nodesRemoved', 'DOM nodes removed', 'lower'],
  ['charDataChanges', 'text node edits', 'lower'],
];

const cfg = byLabel.get(labels[0])[0].config;
console.log(`config: ${cfg.build || 'dev'} build, cpu x${cfg.cpuRate}, ${cfg.events} events, ${cfg.chunkChars} chars every ${cfg.chunkDelayMs} ms, reply ${cfg.replyChars} chars`);
console.log('runs per label: ' + labels.map((l) => `${l}=${byLabel.get(l).length}`).join(', '));
console.log('');
const w = Math.max(...labels.map((l) => l.length), 10);
console.log('metric'.padEnd(26) + labels.map((l) => l.padStart(w + 2)).join('') + (labels.length > 1 ? '   vs first' : ''));
for (const [key, name, better] of ROWS) {
  const vals = labels.map((l) => median(byLabel.get(l).map((r) => r.metrics[key] ?? 0)));
  let delta = '';
  if (labels.length > 1) {
    const a = vals[0]; const b = vals[vals.length - 1];
    if (a) {
      const pct = ((b - a) / a) * 100;
      const good = better === 'lower' ? pct < 0 : pct > 0;
      delta = `   ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% ${Math.abs(pct) < 3 ? '' : good ? 'better' : 'worse'}`;
    }
  }
  console.log(name.padEnd(26) + vals.map((v) => String(v).padStart(w + 2)).join('') + delta);
}

for (const l of labels) {
  const top = byLabel.get(l)[0].metrics.loafTop || [];
  if (!top.length) continue;
  console.log(`\nworst long animation frames (${l}, first run):`);
  for (const e of top) {
    const s = e.scripts.map((x) => `${x.fn || '?'}@${(x.src || '').split('/').pop().slice(0, 40)} ${x.dur}ms`).join('; ');
    console.log(`  ${String(e.dur).padStart(5)} ms  at ${String(e.at ?? '?').padStart(6)} ms  style+layout ${String(e.styleLayout ?? '?').padStart(3)} ms  ${s}`);
  }
}
