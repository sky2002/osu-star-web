// Benchmark scorer for osu-star-web "树星数 v1 (P1h)" engine, following VSRG-DanEstimation-Benchmark
// docs/runner.md conventions: rate fixed 1.0, name matching exact -> normalized -> Name(...) tolerant.
// Usage:
//   node score.mjs --rows --shard 0 --nshards 8 --out scores-shard0.json   # benchmark rows
//   node score.mjs --anchors --out anchors.json                            # the 4 files/ charts
// Dataset location: --bench <dir> > $BENCH_DIR > sibling of the repo checkout
// (../VSRG-DanEstimation-Benchmark-main next to osu-star-web-master). Anchor charts: --files <dir> >
// <bench>/../files (the 3dan substitute + CloverWisp charts used by map.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { createEngine } from '../../docs/js/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BENCH = path.resolve(opt('--bench', process.env.BENCH_DIR || path.resolve(here, '..', '..', '..', 'VSRG-DanEstimation-Benchmark-main')));
const SAMPLES = path.join(BENCH, 'samples');
const FILES_DIR = path.resolve(opt('--files', path.resolve(BENCH, '..', 'files')));
const MODE = args.includes('--anchors') ? 'anchors' : 'rows';
const SHARD = Number(opt('--shard', 0)), NSHARDS = Number(opt('--nshards', 1));
const OUT = opt('--out', MODE === 'anchors' ? 'anchors.json' : `scores-shard${SHARD}.json`);
const LIMIT = args.includes('--limit') ? Number(opt('--limit', Infinity)) : Infinity;
const WITHV2 = args.includes('--v2');   // also store the whole-chart 97% ScoreV2 reading (result.v2)

ort.env.wasm.numThreads = 1;

// minimal CSV parser: quotes + embedded commas/newlines
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
const despace = s => s.replace(/\s+/g, '').toLowerCase();

function indexPatternDir(dir) {
  const idx = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.osu')) continue;
    const base = f.slice(0, -4);
    for (const k of [base, norm(base), despace(base)]) if (!idx.has(k)) idx.set(k, path.join(dir, f));
  }
  return idx;
}

// runner.md 6.2: exact path -> normalized name -> Name(...) tolerance
function findChart(patternDirs, pattern, name) {
  const dir = patternDirs.get(pattern);
  if (!dir) return null;
  for (const k of [name, norm(name), despace(name)]) if (dir.has(k)) return dir.get(k);
  return null;
}

const engine = await createEngine({
  ort,
  loadBytes: async p => new Uint8Array(fs.readFileSync(path.resolve(here, '..', '..', 'docs', p))),
  loadJson: async p => JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'docs', p), 'utf8')),
});

const t0 = performance.now();
const out = [];

if (MODE === 'anchors') {
  const anchorFiles = [
    { id: 'reform-3rd-v2', file: 'Various Artists - Dan ~ REFORM ~ 1st Pack v2 (DDMythical) [~ 3rd ~ (Marathon)].osu' },
    { id: 'cloverwisp-theta', file: 'Various Artists - Dan ~ REFORM ~ FINAL (Ext.) (CloverWisp) [~ FINAL-THETA ~ (Marathon)].osu' },
    { id: 'cloverwisp-iota', file: 'Various Artists - Dan ~ REFORM ~ FINAL (Ext.) (CloverWisp) [~ FINAL-IOTA ~ (Marathon)].osu' },
    { id: 'cloverwisp-kappa', file: 'Various Artists - Dan ~ REFORM ~ FINAL (Ext.) (CloverWisp) [~ FINAL-KAPPA ~ (Marathon)].osu' },
  ];
  for (const a of anchorFiles) {
    const t = performance.now();
    const bytes = fs.readFileSync(path.join(FILES_DIR, a.file));
    const r = await engine.scoreBytes(bytes, { withSegments: false, withSub: false });
    out.push({ id: a.id, file: a.file, ok: r.ok, star: r.ok ? r.star : null, reliable: r.ok ? r.reliable : null,
      theta: r.ok ? r.theta : null, reasons: r.ok ? (r.flags.outOfRangeReasons || []) : [], ms: Math.round(performance.now() - t) });
    console.error(`${a.id}: ${r.ok ? 'star=' + r.star.toFixed(4) + ' reliable=' + r.reliable : 'ERR ' + r.message} (${Math.round((performance.now() - t) / 1000)}s)`);
  }
} else {
  const rows = parseCsv(fs.readFileSync(path.join(BENCH, 'samples', 'data.csv'), 'utf8'));
  const header = rows.shift();
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const tasks = rows.map(r => ({ bid: r[col.bid], name: r[col.name], pattern: r[col.pattern], expected: r[col.expected] }))
    .filter(t => t.name);
  const patternDirs = new Map(['course', 'jack', 'ln', 'speed', 'stamina', 'tech']
    .map(p => [p, indexPatternDir(path.join(SAMPLES, p))]));
  const slice = tasks.filter((_, i) => i % NSHARDS === SHARD).slice(0, LIMIT);
  console.error(`shard ${SHARD}/${NSHARDS}: ${slice.length} rows`);
  for (const [i, t] of slice.entries()) {
    const file = findChart(patternDirs, t.pattern, t.name);
    if (!file) { out.push({ ...t, found: false, got: 'Missing' }); continue; }
    const ts = performance.now();
    try {
      const bytes = fs.readFileSync(file);
      const r = await engine.scoreBytes(bytes, { withSegments: false, withSub: false, withV2: WITHV2 });
      out.push({ ...t, found: true, ok: r.ok, star: r.ok ? r.star : null, reliable: r.ok ? r.reliable : null,
        theta: r.ok ? r.theta : null, v2star: r.ok && r.v2 ? r.v2.star : null, v2theta: r.ok && r.v2 ? r.v2.theta : null,
        reason: r.ok ? null : r.reason, msg: r.ok ? null : r.message,
        reasons: r.ok ? (r.flags.outOfRangeReasons || []) : [], nActions: r.ok ? r.nActions : null, ms: Math.round(performance.now() - ts) });
    } catch (e) {
      out.push({ ...t, found: true, ok: false, got: 'Failed', msg: String(e && e.message || e) });
    }
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${slice.length} elapsed=${Math.round((performance.now() - t0) / 1000)}s`);
  }
}

fs.writeFileSync(path.resolve(here, OUT), JSON.stringify(out));
console.error(`done: ${out.length} rows -> ${OUT}, total ${Math.round((performance.now() - t0) / 1000)}s`);
