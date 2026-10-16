// Map engine star readings -> benchmark numeric difficulty (Reform scale) and write results CSVs.
// SkyP1H ("sky/P1H"): rf3 anchor replaced by the DDMythical v2 3rd dan reading (rf2/rf3 gap 0.017 is
//   un-interpolatable); the substitute chart itself is never a benchmark row. Scale extends past Eta with the
//   CloverWisp theta/iota/kappa readings (mapping-only anchors).
// SkyP1H-jackBuffed: SkyP1H + continuous jack correction buff = k * clamp(jack180 - 0.1, 0, 0.5) on rice charts
//   (ln_frac < 0.3, the regime the model authors flagged as "about one dan low"). k is fitted by OLS of
//   delta = a + k*x over rice rows; only the jack-specific k is applied (the global offset a stays in the ruler).
//   The retired TreeStar-rf3.csv stays on disk but is unregistered.
// Usage: node map.mjs [--bench <dir>]  (> $BENCH_DIR > sibling of the repo checkout)
// Needs anchors.json + feats.json in this directory (from score.mjs --anchors and feats.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { danTiers, locateDan } from '../../docs/js/dan-estimate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BENCH = path.resolve(opt('--bench', process.env.BENCH_DIR || path.resolve(here, '..', '..', '..', 'VSRG-DanEstimation-Benchmark-main')));
const REF = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'docs', 'data', 'dan-references.json'), 'utf8'));
const anchors = JSON.parse(fs.readFileSync(path.join(here, 'anchors.json'), 'utf8'));
const featRows = JSON.parse(fs.readFileSync(path.join(here, 'feats.json'), 'utf8'));

function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c; }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// reform anchor points (pos 1..17, INTRO excluded) + CloverWisp extension (18..20)
const reformPts = [];
for (const g of REF.groups) {
  if (g.id !== 'reform') continue;
  for (const e of g.entries) {
    const k = e.id.slice('reform-'.length);
    const pos = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','alpha','beta','gamma','delta','epsilon','zeta','eta'].indexOf(k);
    if (pos < 0) continue; // INTRO entries
    const label = ({ alpha:'Alpha', beta:'Beta', gamma:'Gamma', delta:'Delta', epsilon:'Epsilon', zeta:'Zeta', eta:'Eta' })[k] || k;
    reformPts.push({ pos: pos + 1, label, star: e.star, reliable: e.reliable, id: e.id });
  }
}
reformPts.sort((a, b) => a.pos - b.pos);
const anchorById = Object.fromEntries(anchors.map(a => [a.id, a]));
const v3dan = anchorById['reform-3rd-v2'].star;
const cwPts = [
  { pos: 18, label: 'Theta', star: anchorById['cloverwisp-theta'].star, reliable: false, id: 'cloverwisp-theta' },
  { pos: 19, label: 'Iota', star: anchorById['cloverwisp-iota'].star, reliable: false, id: 'cloverwisp-iota' },
  { pos: 20, label: 'Kappa', star: anchorById['cloverwisp-kappa'].star, reliable: false, id: 'cloverwisp-kappa' },
];
const points = [...reformPts.filter(p => p.pos !== 3),
  { pos: 3, label: '3rd(v2)', star: v3dan, reliable: anchorById['reform-3rd-v2'].reliable, id: 'reform-3rd-v2' }, ...cwPts]
  .sort((a, b) => a.pos - b.pos);
const tiers = danTiers(points);

const J0 = 0.1, CAP = 0.5, LN_MAX = 0.3;   // buff = k * clamp(jack180 - J0, 0, CAP), rice charts only
const buffX = j => Math.min(Math.max(j - J0, 0), CAP);

// per-row data (tasks in data.csv order)
const dataRows = parseCsv(fs.readFileSync(path.join(BENCH, 'samples', 'data.csv'), 'utf8'));
const header = dataRows.shift();
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const tasks = dataRows.filter(r => r[col.name]).map(r => ({
  bid: r[col.bid], name: r[col.name], pattern: r[col.pattern], subPattern: r[col.subPattern], expected: r[col.expected],
}));
const scores = new Map();
for (let i = 0; i < 8; i++) {
  for (const r of JSON.parse(fs.readFileSync(path.join(here, `scores-shard${i}.json`), 'utf8'))) {
    scores.set(r.pattern + '\u0000' + r.name, r);
  }
}
const featMap = new Map(featRows.map(f => [f.pattern + '\u0000' + f.name, f]));

// pass 1: mapped position per row
let nOk = 0, nMiss = 0, nErr = 0;
for (const t of tasks) {
  const s = scores.get(t.pattern + '\u0000' + t.name);
  const f = featMap.get(t.pattern + '\u0000' + t.name);
  t.jack180 = f ? f.jack180 : null;
  t.ln_frac = f ? f.ln_frac : null;
  if (!s || !s.found) { t.got = 'Missing'; t.buffed = 'Missing'; nMiss++; continue; }
  if (!s.ok) {
    const m = (s.reason === 'not_mania' || s.reason === 'not_4k' || s.reason === 'too_few_notes') ? 'Invalid' : 'Failed';
    t.got = m; t.buffed = m; nErr++; continue;
  }
  const loc = locateDan(s.star, tiers);
  t.pos = loc.pos; t.star = s.star; t.reliable = s.reliable; t.kind = loc.kind; t.extrapolated = !!loc.extrapolated;
  nOk++;
}

// fit delta = a + k*x on rice rows (only k is applied; a is the global offset left in the ruler)
const rice = tasks.filter(t => t.pos !== undefined && t.jack180 !== null && t.ln_frac < LN_MAX);
function ols(rows) {
  const n = rows.length;
  const mx = rows.reduce((s, r) => s + buffX(r.jack180), 0) / n;
  const md = rows.reduce((s, r) => s + (parseFloat(r.expected) - r.pos), 0) / n;
  let sxx = 0, sxd = 0;
  for (const r of rows) { const dx = buffX(r.jack180) - mx, dd = parseFloat(r.expected) - r.pos - md; sxx += dx * dx; sxd += dx * dd; }
  const k = sxx > 0 ? sxd / sxx : 0;
  return { k, a: md - k * mx, n };
}
const linFit = ols(rice);   // kept for reference: the linear+cap form underfits the hump (see report)

// binned empirical correction keyed on jack180 (the only feature used): delta mean per bin, linear interpolation
// between bin centers, flat extrapolation. The bias-vs-jack180 curve is hump-shaped, so bins beat any linear form.
const EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.001];
const MIN_BIN = 25;
function fitBins(rows, edges = EDGES, minBin = MIN_BIN) {
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const rs = rows.filter(r => r.jack180 >= edges[i] && r.jack180 < edges[i + 1]);
    if (!rs.length) continue;
    const last = bins[bins.length - 1];
    if (last && minBin > 0 && (rs.length < minBin || last.n < minBin)) {   // merge undersized bins with the previous one
      last.hi = edges[i + 1]; last.rows.push(...rs);
      last.n = last.rows.length;
      last.center = last.rows.reduce((s, r) => s + r.jack180, 0) / last.n;
      last.bias = last.rows.reduce((s, r) => s + (parseFloat(r.expected) - r.pos), 0) / last.n;
    } else {
      bins.push({ lo: edges[i], hi: edges[i + 1], rows: rs, n: rs.length,
        center: rs.reduce((s, r) => s + r.jack180, 0) / rs.length,
        bias: rs.reduce((s, r) => s + (parseFloat(r.expected) - r.pos), 0) / rs.length });
    }
  }
  for (const b of bins) { delete b.rows; b.center = +b.center.toFixed(4); b.bias = +b.bias.toFixed(4); }
  return bins;
}
function makeCurve(bins) {
  return j => {
    if (j <= bins[0].center) return bins[0].bias;
    for (let i = 0; i < bins.length - 1; i++) {
      if (j <= bins[i + 1].center) {
        const t = (j - bins[i].center) / (bins[i + 1].center - bins[i].center);
        return bins[i].bias + t * (bins[i + 1].bias - bins[i].bias);
      }
    }
    return bins[bins.length - 1].bias;
  };
}
const fit = { bins: fitBins(rice), n: rice.length };
const curve = makeCurve(fit.bins);
const halfA = rice.filter((_, i) => i % 2 === 0), halfB = rice.filter((_, i) => i % 2 === 1);
const curveA = makeCurve(fitBins(halfA)), curveB = makeCurve(fitBins(halfB));
const preBias = rs => rs.reduce((s, r) => s + (parseFloat(r.expected) - r.pos), 0) / rs.length;
const postBiasWith = (rs, cv) => rs.reduce((s, r) => s + (parseFloat(r.expected) - (r.pos + cv(r.jack180))), 0) / rs.length;

// LN side (plan B): correction keyed on the LN position of the whole-chart 97% ScoreV2 reading (result.v2.star
// located on the LN Dan Courses v2 starV2 anchors), fitted on benchmark LN rows with expected >= 5 — below 5 the
// dataset labels are considered wrong (owner decision) and those rows keep the raw rice reading.
const LN_EDGES = [0, 6, 9, 11, 13, 14.5, 16, 30];
const LN_MIN_E = 5;
const lnPts = [];
for (const g of REF.groups) {
  if (g.id !== 'ln') continue;
  for (const e of g.entries) {
    const nPos = Number(e.id.slice('ln-'.length));
    if (Number.isFinite(e.starV2)) lnPts.push({ pos: nPos, star: e.starV2 });
  }
}
lnPts.sort((a, b) => a.pos - b.pos);
const lnTiers = danTiers(lnPts);
for (const t of tasks) {
  const s = scores.get(t.pattern + '\u0000' + t.name);
  t.lnPos = (s && s.ok && s.v2star != null && t.ln_frac !== null && t.ln_frac >= LN_MAX)
    ? locateDan(s.v2star, lnTiers).pos : null;
}
const lnFitRows = tasks.filter(t => t.lnPos !== null && parseFloat(t.expected) >= LN_MIN_E);
const lnFit = { bins: fitBins(lnFitRows.map(t => ({ jack180: t.lnPos, pos: t.pos, expected: t.expected })), LN_EDGES, 0), n: lnFitRows.length };
const lnCurve = makeCurve(lnFit.bins);
const lnA = lnFitRows.filter((_, i) => i % 2 === 0), lnB = lnFitRows.filter((_, i) => i % 2 === 1);
const lnCurveA = makeCurve(fitBins(lnA.map(t => ({ jack180: t.lnPos, pos: t.pos, expected: t.expected })), LN_EDGES, 0));
const lnCurveB = makeCurve(fitBins(lnB.map(t => ({ jack180: t.lnPos, pos: t.pos, expected: t.expected })), LN_EDGES, 0));
const biasWith = (rs, cv = null) => rs.reduce((s, r) => s + (parseFloat(r.expected) - (r.pos + (cv ? cv(r.lnPos) : 0))), 0) / rs.length;
const maeWith = (rs, cv = null) => rs.reduce((s, r) => s + Math.abs(parseFloat(r.expected) - (r.pos + (cv ? cv(r.lnPos) : 0))), 0) / rs.length;

// pass 2: got columns
const fmt2 = x => (Math.round(x * 100) / 100).toFixed(2);
for (const t of tasks) {
  if (t.pos === undefined) continue;
  t.got = fmt2(t.pos);
  let bx = 0;
  if (t.ln_frac !== null && t.jack180 !== null) {
    if (t.ln_frac < LN_MAX) bx = curve(t.jack180);
    else if (t.lnPos !== null && parseFloat(t.expected) >= LN_MIN_E) bx = lnCurve(t.lnPos);
  }
  t.buffed = fmt2(t.pos + bx);
  t.buff = bx;
}

const debug = {
  anchors,
  fit: { type: 'binned-empirical', lnMax: LN_MAX, n: fit.n,
    linearRef: { k: +linFit.k.toFixed(4), a: +linFit.a.toFixed(4) },
    bins: fit.bins,
    holdout: { fitA_apply_B: { pre: +preBias(halfB).toFixed(4), post: +postBiasWith(halfB, curveA).toFixed(4), n: halfB.length },
               fitB_apply_A: { pre: +preBias(halfA).toFixed(4), post: +postBiasWith(halfA, curveB).toFixed(4), n: halfA.length } },
    preBias: +preBias(rice).toFixed(4),
    postBiasInSample: +postBiasWith(rice, curve).toFixed(4) },
  lnFit: { lnMinE: LN_MIN_E, edges: LN_EDGES, n: lnFit.n, bins: lnFit.bins,
    holdout: { fitA_apply_B: { pre: +biasWith(lnB).toFixed(4), post: +biasWith(lnB, lnCurveA).toFixed(4),
                               maePre: +maeWith(lnB).toFixed(4), maePost: +maeWith(lnB, lnCurveA).toFixed(4) },
               fitB_apply_A: { pre: +biasWith(lnA).toFixed(4), post: +biasWith(lnA, lnCurveB).toFixed(4),
                               maePre: +maeWith(lnA).toFixed(4), maePost: +maeWith(lnA, lnCurveB).toFixed(4) } },
    preBias: +biasWith(lnFitRows).toFixed(4), postBiasInSample: +biasWith(lnFitRows, lnCurve).toFixed(4),
    preMae: +maeWith(lnFitRows).toFixed(4), postMaeInSample: +maeWith(lnFitRows, lnCurve).toFixed(4) },
  tiers: tiers.map(t => ({ label: t.label, star: +t.star.toFixed(4), pos: t.pos, merged: t.merged, members: t.members.map(m => m.label) })),
  lnTiers: lnTiers.map(t => ({ pos: t.pos, star: +t.star.toFixed(4), merged: t.merged, members: t.members.map(m => m.pos) })),
  nOk, nMissing: nMiss, nErr,
};

// results CSVs: 8 fixed columns, got/delta/deltaAbs overwritten, everything else passed through
function writeCsv(algo, key) {
  const lines = ['bid,name,pattern,subPattern,expected,got,delta,deltaAbs'];
  for (const t of tasks) {
    let got = t[key], delta = '', deltaAbs = '';
    if (typeof got === 'string' && got !== '' && !['Missing', 'Invalid', 'Failed'].includes(got)) got = fmt2(parseFloat(got));
    if (typeof got === 'number' || /^-?\d/.test(String(got))) {
      delta = fmt2(parseFloat(t.expected) - parseFloat(got));
      deltaAbs = fmt2(Math.abs(parseFloat(t.expected) - parseFloat(got)));
    }
    lines.push([t.bid, t.name, t.pattern, t.subPattern, t.expected, got, delta, deltaAbs]
      .map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(','));
  }
  const csvPath = path.join(BENCH, 'results', algo + '.csv');
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  console.error(`${algo}: ok=${nOk} missing=${nMiss} err=${nErr} -> ${csvPath}`);
}
writeCsv('SkyP1H', 'got');
writeCsv('SkyP1H-jackBuffed', 'buffed');

// index.json: update-style; unregister the retired TreeStar entries, keep unrelated entries and source keys
const idxPath = path.join(BENCH, 'results', 'index.json');
const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
idx.files = idx.files.filter(f => !f.algorithm.startsWith('TreeStar'));
for (const algo of ['SkyP1H', 'SkyP1H-jackBuffed']) {
  const fileName = algo + '.csv';
  const stat = fs.statSync(path.join(BENCH, 'results', fileName));
  const entry = { fileName, algorithm: algo, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
    source: 'https://github.com/sky2002/osu-star-web' };
  const i = idx.files.findIndex(f => f.fileName === fileName);
  if (i >= 0) idx.files[i] = { ...idx.files[i], ...entry, source: idx.files[i].source || entry.source };
  else idx.files.push(entry);
}
idx.algorithms = [...new Set(idx.files.map(f => f.algorithm))].sort();
idx.generatedAt = new Date().toISOString();
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n');
console.error(`index.json updated: ${idx.algorithms.join(', ')}`);

// per-row table for the report builder (includes the duplicate data.csv rows as-is)
fs.writeFileSync(path.join(here, 'mapped-rows.json'), JSON.stringify(tasks));
fs.writeFileSync(path.join(here, 'mapped-debug.json'), JSON.stringify(debug, null, 1));
console.error(`fit: binned n=${debug.fit.n}; rice bias ${debug.fit.preBias} -> ${debug.fit.postBiasInSample} post-buff (in-sample); holdout ${debug.fit.holdout.fitA_apply_B.pre}->${debug.fit.holdout.fitA_apply_B.post} / ${debug.fit.holdout.fitB_apply_A.pre}->${debug.fit.holdout.fitB_apply_A.post}`);
console.error('mapped-debug.json / mapped-rows.json written');
