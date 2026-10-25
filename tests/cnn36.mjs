// Agreement check: CNN36 in JS (docs/js/cnn36.js grid + model/cnn36.onnx in onnxruntime-web wasm) vs the Python reference
// (research repo analysis/cnn36-web-r1/cnn_ref.py) on every chart of tests/fixtures/reference-cnn36.json at 1.0x and 1.5x.
//   OSU_DIFF_ROOT=<research repository root> node tests/cnn36.mjs [--limit N] [--threads 1] [--tol 1e-3]
// Notes come from the site's own path (osu.js parseOsuFeat -> features.js prepareFeatureNotes, times not divided by the rate).
// Exit code 1 on any grid hash / length mismatch or any reading (one of the 20, or their mean) off by more than --tol.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { unzipSync } from 'fflate';
import { parseOsuFeat } from '../docs/js/osu.js';
import { prepareFeatureNotes } from '../docs/js/features.js';
import { cnnGrid, Cnn36 } from '../docs/js/cnn36.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
const root = process.env.OSU_DIFF_ROOT;
if (!root) { console.error('set OSU_DIFF_ROOT to the research repository root'); process.exit(2); }
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const LIMIT = opt('--limit', Infinity), THREADS = opt('--threads', 1), TOL = opt('--tol', 1e-3);
ort.env.wasm.numThreads = THREADS;

const t0 = performance.now();
const session = await ort.InferenceSession.create(fs.readFileSync(path.join(docs, 'model', 'cnn36.onnx')),
  { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
const cnn = new Cnn36(session, ort);
const loadMs = performance.now() - t0;
const ref = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'reference-cnn36.json'), 'utf8'));
const oszCache = new Map();
function chartBytes(c) {
  const p = path.join(root, c.source);
  if (!c.member) return new Uint8Array(fs.readFileSync(p));
  if (!oszCache.has(p)) oszCache.set(p, unzipSync(new Uint8Array(fs.readFileSync(p))));
  return oszCache.get(p)[c.member];
}
const rows = [];
let n = 0;
const tAll = performance.now();
for (const c of ref.charts) {
  if (n++ >= LIMIT) break;
  const fn = prepareFeatureNotes(parseOsuFeat(new TextDecoder('utf-8').decode(chartBytes(c))));
  for (const at of c.at) {
    const t1 = performance.now();
    const g = cnnGrid(fn.s, fn.c, fn.e, fn.od, at.rate);
    const gridMs = performance.now() - t1;
    const sha = crypto.createHash('sha256').update(new Uint8Array(g.data.buffer, g.data.byteOffset, g.data.byteLength)).digest('hex');
    const t2 = performance.now();
    const r = await cnn.readings(g);
    const onnxMs = performance.now() - t2;
    let d = 0, mean = 0;
    for (let k = 0; k < 20; k++) { d = Math.max(d, Math.abs(r[k] - at.readings[k])); mean += r[k]; }
    mean /= 20;
    const row = { source: c.source, member: c.member, rate: at.rate, L: g.L, notes: fn.s.length, gridSame: sha === at.grid_sha256 && g.L === at.L && g.last === at.last,
      dMax20: d, dMean: mean - at.reading, reading: mean, gridMs, onnxMs };
    rows.push(row);
    console.log(`${row.gridSame ? 'ok  ' : 'GRID'} ${at.rate}x L ${String(g.L).padStart(6)} (${(g.L / 6000).toFixed(1)} min) grid ${gridMs.toFixed(1)} ms onnx ${onnxMs.toFixed(0)} ms `
      + `max|d20| ${d.toExponential(1)} d_mean ${row.dMean.toExponential(1)}  ${path.basename(c.member || c.source)}`);
  }
}
const totalMs = performance.now() - tAll;
const big = [...rows].sort((a, b) => b.dMax20 - a.dMax20).slice(0, 5);
const ms = rows.map(r => r.gridMs + r.onnxMs).sort((a, b) => a - b);
const summary = {
  charts: Math.min(n, ref.charts.length), runs: rows.length, threads: THREADS, tol: TOL,
  grid_mismatch: rows.filter(r => !r.gridSame).map(r => [r.source, r.member, r.rate]),
  max_abs_d_reading20: Math.max(...rows.map(r => r.dMax20)), max_abs_d_mean: Math.max(...rows.map(r => Math.abs(r.dMean))),
  n_over_1e4: rows.filter(r => r.dMax20 > 1e-4).length, n_over_tol: rows.filter(r => r.dMax20 > TOL || Math.abs(r.dMean) > TOL).length,
  largest: big.map(r => ({ source: r.source, member: r.member, rate: r.rate, L: r.L, d: r.dMax20 })),
  ms_per_run_median: ms[Math.floor(ms.length / 2)], ms_per_run_max: ms[ms.length - 1],
  slowest: [...rows].sort((a, b) => b.onnxMs - a.onnxMs).slice(0, 3).map(r => ({ member: r.member || r.source, rate: r.rate, L: r.L, onnx_ms: Math.round(r.onnxMs), grid_ms: Math.round(r.gridMs) })),
  load_ms: Math.round(loadMs), total_s: +(totalMs / 1000).toFixed(1),
  rss_mb_end: Math.round(process.memoryUsage().rss / 2 ** 20),   // wasm memory only grows, so this is about the peak
};
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out', `cnn36-rows-t${THREADS}.json`), JSON.stringify(rows, null, 0));
fs.writeFileSync(path.join(here, 'out', `cnn36-summary-t${THREADS}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(summary.grid_mismatch.length || summary.n_over_tol ? 1 : 0);
