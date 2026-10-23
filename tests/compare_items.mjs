// Key-pattern items (beta): JS port (docs/js/pattern-items.js + the calibrated second layer in reader.js) vs the Python reference
// (research repo analysis/web-items-r1/wi_ref.py -> data/web-items-r1/reference-items.json and lk/<i>.bin).
//   OSU_DIFF_ROOT=<research repository root> node tests/compare_items.mjs [--mode e2e|inject] [--shard i/n] [--limit N]
// inject: the Python encoder outputs (lk, both orientations) replace the ONNX encoder, so everything after the encoder must
//         match bit for bit (stars, shares, thetas, flags, display decisions, tech tag); exit 1 on any difference.
// e2e:    the whole browser pipeline (ONNX encoder included); reports the largest differences, exit 1 if a display decision,
//         flag or tech tag differs or a star differs by more than --tol (default 1e-6).
// Both modes also check the "X 苦手要小心" hints (docs/js/ui-lib.js patternHints on the JS items and total star) against the
// Python rule in tests/fixtures/reference-hints.json (tools/hint-reference.py): key, percent, jack number and star range must be
// equal (a difference is a mismatch, exit 1). e2e also counts the charts whose hints the page hides (variable-speed charts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { unzipSync } from 'fflate';
import { createEngine } from '../docs/js/engine.js';
import { loadChart } from '../docs/js/osu.js';
import { tokensFromNotes } from '../docs/js/tokens.js';
import { classifyNotes, calibInputs, itemReadouts } from '../docs/js/pattern-items.js';
import { Reader } from '../docs/js/reader.js';
import { patternHints, PATTERN_HINTS } from '../docs/js/ui-lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
const root = process.env.OSU_DIFF_ROOT;
if (!root) { console.error('set OSU_DIFF_ROOT to the research repository root'); process.exit(2); }
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODE = arg('--mode', 'inject'), LIMIT = Number(arg('--limit', Infinity)), TOL = Number(arg('--tol', 1e-6));
const [SH, NSH] = arg('--shard', '0/1').split('/').map(Number);
ort.env.wasm.numThreads = 1;

const refDir = path.join(root, 'data', 'web-items-r1');
const ref = JSON.parse(fs.readFileSync(path.join(refDir, 'reference-items.json'), 'utf8'));
const hintRef = new Map(JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'reference-hints.json'), 'utf8')).charts.map(c => [c.i, c]));
const hintKey = hs => JSON.stringify(hs.map(x => [x.key, x.pct, x.delta, x.range]));
const engine = await createEngine({
  ort,
  loadBytes: async p => new Uint8Array(fs.readFileSync(path.join(docs, p))),
  loadJson: async p => JSON.parse(fs.readFileSync(path.join(docs, p), 'utf8')),
});
const PI = engine.patternItems, reader = engine.reader;
const oszCache = new Map();
function chartBytes(c) {
  const p = path.join(root, c.source);
  if (!c.member) return new Uint8Array(fs.readFileSync(p));
  if (!oszCache.has(p)) oszCache.set(p, unzipSync(new Uint8Array(fs.readFileSync(p))));
  return oszCache.get(p)[c.member];
}

function f32File(p) { const b = fs.readFileSync(p); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
function f64File(p) { const b = fs.readFileSync(p); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }

async function injected(c, bytes) {
  const text = new TextDecoder('utf-8').decode(bytes);
  const chart = loadChart(text);
  const tk = tokensFromNotes(chart.notes, 1);
  const A = tk.nActions;
  const lk = f32File(path.join(refDir, 'lk', `${c.i}.bin`));
  if (lk.length !== 2 * A) throw new Error(`lk length ${lk.length} != 2 x ${A}`);
  const ls = [0, 1].map(m => { const l = new Float32Array(2 * A); for (let a = 0; a < A; a++) { l[2 * a] = lk[m * A + a]; l[2 * a + 1] = lk[m * A + a]; } return l; });
  const P = reader.P;
  const v1a = new Float64Array(P * A), v1c = new Float64Array(P * A);
  const cal = calibInputs(tk, PI);
  for (const l of ls) {
    Reader.accumulate(v1a, reader.secondLayerRange(l, tk.comp, tk.lnH, tk.lnT, chart.od, 0, P), 0, A);
    Reader.accumulate(v1c, reader.secondLayerRange(l, tk.comp, tk.lnH, tk.lnT, chart.od, 0, P, 1, '', cal), 0, A);
  }
  return itemReadouts({ PI, reader, tk, cls: classifyNotes(chart.notes), v1a, v1c, star: c.star });
}

// layers: on the charts of data/web-items-r1/dump (Python per-layer dumps), compare sigma / pi (orientation 0) and the per-action
// v1 of arms U and C, then the readouts computed by the JS code from the Python v1 arrays (must equal the reference exactly)
async function layers() {
  const dumped = JSON.parse(fs.readFileSync(path.join(refDir, 'dump', 'dump.json'), 'utf8')).charts.filter(x => !x.error);
  const byI = new Map(ref.charts.map(c => [c.i, c]));
  const P = reader.P;
  const acc = { sigU: [0, 0], piU: [0, 0], sigC: [0, 0], piC: [0, 0], v1U: [0, 0], v1C: [0, 0] };   // [elements differing, total]
  const mxl = { sigU: 0, piU: 0, sigC: 0, piC: 0, v1U: 0, v1C: 0 };
  const calOnly = [0, 0];       // C-arm sigma / pi elements differing where the U arm matches (differences added by the cal terms)
  const readoutDiff = [];
  const rmx = {};
  for (const { i } of dumped) {
    const c = byI.get(i);
    const chart = loadChart(new TextDecoder('utf-8').decode(chartBytes(c)));
    const tk = tokensFromNotes(chart.notes, 1);
    const A = tk.nActions;
    const lk = f32File(path.join(refDir, 'lk', `${i}.bin`));
    const ls = [0, 1].map(m => { const l = new Float32Array(2 * A); for (let a = 0; a < A; a++) { l[2 * a] = lk[m * A + a]; l[2 * a + 1] = lk[m * A + a]; } return l; });
    const cal = calibInputs(tk, PI);
    const v1a = new Float64Array(P * A), v1c = new Float64Array(P * A);
    const dU = { sig: new Float32Array(P * A), pi: new Float32Array(P * A) }, dC = { sig: new Float32Array(P * A), pi: new Float32Array(P * A) };
    ls.forEach((l, m) => {
      Reader.accumulate(v1a, reader.secondLayerRange(l, tk.comp, tk.lnH, tk.lnT, chart.od, 0, P, 1, '', null, m ? null : dU), 0, A);
      Reader.accumulate(v1c, reader.secondLayerRange(l, tk.comp, tk.lnH, tk.lnT, chart.od, 0, P, 1, '', cal, m ? null : dC), 0, A);
    });
    const D = k => path.join(refDir, 'dump', `${i}-${k}.bin`);
    const py = { sigU: f32File(D('sigmaU')), piU: f32File(D('piU')), sigC: f32File(D('sigmaC')), piC: f32File(D('piC')), v1U: f64File(D('v1U')), v1C: f64File(D('v1C')) };
    const js = { sigU: dU.sig, piU: dU.pi, sigC: dC.sig, piC: dC.pi, v1U: v1a, v1C: v1c };
    for (const k of Object.keys(js)) {
      for (let j = 0; j < js[k].length; j++) {
        acc[k][1]++;
        if (js[k][j] !== py[k][j]) { acc[k][0]++; mxl[k] = Math.max(mxl[k], Math.abs(js[k][j] - py[k][j]) / Math.max(1e-30, Math.abs(py[k][j]))); }
      }
    }
    for (let j = 0; j < P * A; j++) {
      if (js.sigU[j] === py.sigU[j] && js.piU[j] === py.piU[j]) { calOnly[1]++; if (js.sigC[j] !== py.sigC[j] || js.piC[j] !== py.piC[j]) calOnly[0]++; }
    }
    const it = itemReadouts({ PI, reader, tk, cls: classifyNotes(chart.notes), v1a: py.v1U, v1c: py.v1C, star: c.star });
    const bad = [];
    const same = (a, b) => (a === null || a === undefined ? NaN : a) === b || (Number.isNaN(a) && b === null) || (a === b);
    if (it.thetaAll !== c.theta_all) bad.push('theta_all'); if (it.thetaU !== c.theta_all_U) bad.push('theta_all_U');
    if (it.kMain !== c.k_main) bad.push('k_main'); if (it.flagAll !== c.flag_all) bad.push('flag_all'); if (it.techTag !== c.tech_tag) bad.push('tech_tag');
    for (const k of KEYS) for (const f of ['star', 's', 'theta', 'share', 'n', 'display', 'flag']) {
      const a = it.items[k][f], b = c.items[k][f];
      if (!(a === b || (Number.isNaN(a) && b === null))) { bad.push(`${k}.${f}`); if (typeof a === 'number') rmx[f] = Math.max(rmx[f] || 0, Math.abs(a - b)); }
    }
    rmx.theta_all = Math.max(rmx.theta_all || 0, Math.abs(it.thetaAll - c.theta_all));
    readoutDiff.push([i, bad]);
  }
  const summary = { mode: 'layers', charts: dumped.length, element_mismatch: acc, max_rel_diff: mxl,
    cal_term_only_mismatch: calOnly, readouts_from_python_v1: { charts: readoutDiff.length, n_unequal: readoutDiff.filter(x => x[1].length).length, max_abs: rmx, unequal: readoutDiff.filter(x => x[1].length) } };
  fs.mkdirSync(path.join(here, 'out'), { recursive: true });
  fs.writeFileSync(path.join(here, 'out', 'compare-items-layers.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  process.exit(summary.readouts_from_python_v1.unequal.length || calOnly[0] ? 1 : 0);
}

const KEYS = ['jack', 'speed', 'trill_tA', 'ln', 'kashou', 'trill', 'tech_rA'];
const FIELDS = ['star', 's', 'theta', 'share'];
const num = v => (v === null || v === undefined ? NaN : v);
if (MODE === 'layers') await layers();
const rows = [];
const mx = {};
const bump = (k, d) => { if (!(mx[k] >= d)) mx[k] = d; };
let n = 0;
for (const c of ref.charts) {
  if (c.i % NSH !== SH) continue;
  if (n++ >= LIMIT) break;
  const t0 = performance.now();
  let it, jsStar = null, sv = null;
  try {
    if (MODE === 'inject') it = await injected(c, chartBytes(c));
    else {
      const r = await engine.scoreBytes(chartBytes(c), { withSegments: false, withSub: false, withV2: false });
      if (!r.ok) throw new Error(r.detail || r.message);
      it = r.items; jsStar = r.star; sv = !!(r.flags && r.flags.sv);
    }
  } catch (e) { rows.push({ i: c.i, source: c.source, member: c.member, error: String(e && e.message || e) }); continue; }
  const row = { i: c.i, set: c.set, source: c.source, member: c.member, ms: performance.now() - t0, diffs: {}, mismatch: [] };
  const d = (k, a, b) => {
    a = num(a); b = num(b);
    const v = Number.isNaN(a) && Number.isNaN(b) ? 0 : Math.abs(a - b);
    row.diffs[k] = Number.isNaN(v) ? Infinity : v;
    bump(k, row.diffs[k]);
  };
  d('theta_all', it.thetaAll, c.theta_all); d('theta_all_U', it.thetaU, c.theta_all_U); d('k_main', it.kMain, c.k_main);
  if (jsStar !== null) d('star_total', jsStar, c.star);
  if (it.flagAll !== c.flag_all) row.mismatch.push('flag_all');
  for (const k of KEYS) {
    const a = it.items[k], b = c.items[k];
    for (const f of FIELDS) d(`${k}.${f}`, a[f], b[f]);
    if (a.n !== b.n) row.mismatch.push(`${k}.n`);
    if (a.display !== b.display) row.mismatch.push(`${k}.display`);
    if (a.flag !== b.flag) row.mismatch.push(`${k}.flag`);
  }
  if (it.techTag !== c.tech_tag) row.mismatch.push('tech_tag');
  // hints: JS rule on the JS items (and the JS total star in e2e, the Python star in inject) vs the Python rule on the Python items
  const hr = hintRef.get(c.i);
  const hs = patternHints(it.items, jsStar !== null ? jsStar : c.star);
  row.hints = hs.map(x => [x.key, x.pct, x.delta, x.range]);
  row.sv = sv;
  if (!hr || hintKey(hs) !== hintKey(hr.hints)) row.mismatch.push('hints');
  // margins (informational): share distance from each threshold's rounding edge (e.g. 44.5 % for jack), and for a shown jack
  // hint the total star's distance from the 3–7 range edges (2.995 / 7.005)
  row.hintEdge = Math.min(...Object.entries(PATTERN_HINTS).map(([k, H]) => {
    const v = it.items[k].s;
    return Number.isFinite(v) ? Math.abs(v - (H.min - 0.5) / 100) : Infinity;
  }));
  const st = jsStar !== null ? jsStar : c.star;
  row.starEdge = hs.some(x => x.key === 'jack') ? Math.min(Math.abs(st - 2.995), Math.abs(st - 7.005)) : Infinity;
  rows.push(row);
}
const ok = rows.filter(r => !r.error);
const starKeys = ['jack.star', 'speed.star', 'trill_tA.star'];
const exact = k => ok.filter(r => r.diffs[k] === 0).length;
const summary = {
  mode: MODE, shard: `${SH}/${NSH}`, charts: rows.length, compared: ok.length, errors: rows.filter(r => r.error).map(r => [r.i, r.source, r.member, r.error]),
  by_set: Object.fromEntries(['test_beatmap', 'ranked200'].map(s => [s, ok.filter(r => r.set === s).length])),
  max_abs: mx,
  exact_counts: Object.fromEntries([...starKeys, 'theta_all', 'theta_all_U', 'k_main'].map(k => [k, exact(k)])),
  mismatches: ok.filter(r => r.mismatch.length).map(r => [r.i, r.source, r.member, r.mismatch]),
  largest_three_items: ok.map(r => [r.i, Math.max(...starKeys.map(k => r.diffs[k]))]).sort((a, b) => b[1] - a[1]).slice(0, 5),
  ms_median: ok.map(r => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)], tol: TOL,
  hints: {
    charts_with_hint: Object.fromEntries(['jack', 'speed', 'ln'].map(k => [k, ok.filter(r => r.hints.some(x => x[0] === k)).length])),
    jack_with_number: ok.filter(r => r.hints.some(x => x[0] === 'jack' && x[2] !== null)).length,
    mismatch: ok.filter(r => r.mismatch.includes('hints')).length,
    sv_charts_hidden_on_page: MODE === 'e2e' ? ok.filter(r => r.sv && r.hints.length).length : null,
    min_share_margin_to_threshold_edge: Math.min(...ok.map(r => r.hintEdge)),
    min_star_margin_to_range_edge: Math.min(...ok.map(r => r.starEdge)),
  },
};
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out', `compare-items-${MODE}-${SH}of${NSH}.json`), JSON.stringify({ summary, rows }, null, 0));
console.log(JSON.stringify(summary, null, 1));
const bad = summary.errors.length || summary.mismatches.length
  || (MODE === 'inject' ? Object.values(mx).some(v => v !== 0) : starKeys.some(k => mx[k] > TOL));
process.exit(bad ? 1 : 0);
