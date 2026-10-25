// End-to-end check of the new star (test): the whole JS pipeline (engine.js withCnn: hand features, s29 theta*, CNN36 ONNX,
// tree-cnn36.json) vs the Python reference in tests/fixtures/reference-cnn36-star.json (research repo analysis/cnn36-web-r1/tree),
// at NoMod and DT. The reference uses the Python features + theta*, so differences also carry the known JS-vs-Python theta* gap
// that tests/compare.mjs checks for the P1h star.
//   OSU_DIFF_ROOT=<research repository root> node tests/compare_cnn36_star.mjs [--every K] [--limit N] [--tol 0.01]
// Exit code 1 if any chart differs by more than --tol stars.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { unzipSync } from 'fflate';
import { createEngine } from '../docs/js/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
const root = process.env.OSU_DIFF_ROOT;
if (!root) { console.error('set OSU_DIFF_ROOT to the research repository root'); process.exit(2); }
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const EVERY = opt('--every', 1), LIMIT = opt('--limit', Infinity), TOL = opt('--tol', 0.01);
ort.env.wasm.numThreads = 1;

const engine = await createEngine({
  ort,
  loadBytes: async p => new Uint8Array(fs.readFileSync(path.join(docs, p))),
  loadJson: async p => JSON.parse(fs.readFileSync(path.join(docs, p), 'utf8')),
});
const ref = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'reference-cnn36-star.json'), 'utf8'));
const oszCache = new Map();
function chartBytes(c) {
  const p = path.join(root, c.source);
  if (!c.member) return new Uint8Array(fs.readFileSync(p));
  if (!oszCache.has(p)) oszCache.set(p, unzipSync(new Uint8Array(fs.readFileSync(p))));
  return oszCache.get(p)[c.member];
}

const rows = [];
const charts = ref.charts.filter((_, i) => i % EVERY === 0).slice(0, LIMIT);
for (const c of charts) {
  const bytes = chartBytes(c);
  for (const [rate, want] of [[1, c], [1.5, c.dt]]) {
    if (!want) continue;
    const r = await engine.scoreBytes(bytes, { rate, withSegments: false, withSub: false, withV2: false, withItems: false, withCnn: true });
    const row = { source: c.source, member: c.member, rate };
    if (!r.ok || !r.cnn || !r.cnn.ok) { row.error = r.ok ? (r.cnn && r.cnn.text) : r.detail; rows.push(row); continue; }
    Object.assign(row, { d_star: r.cnn.star - want.star, d_cnn: r.cnn.cnnReading - want.cnn, d_p1h: r.star - want.star_P1h, cnn_ms: r.cnn.ms });
    rows.push(row);
  }
}
const ok = rows.filter(r => !r.error);
const maxAbs = k => Math.max(...ok.map(r => Math.abs(r[k])));
const bad = rows.filter(r => r.error || Math.abs(r.d_star) > TOL);
const ms = ok.map(r => r.cnn_ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  charts: charts.length, runs: rows.length, errors: rows.filter(r => r.error).length,
  max_abs: { new_star: maxAbs('d_star'), cnn_reading: maxAbs('d_cnn'), p1h_star: maxAbs('d_p1h') },
  cnn_ms: { median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] },
  over_tol: bad.slice(0, 10),
}, null, 1));
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out', 'compare_cnn36_star.json'), JSON.stringify(rows, null, 1));
process.exit(bad.length ? 1 : 0);
