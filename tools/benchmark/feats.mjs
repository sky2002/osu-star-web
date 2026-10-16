// Extract jack180 / ln_frac for every benchmark row (feature pipeline only, no ONNX) -> feats.json.
// Same name matching as score.mjs. Usage: node feats.mjs [--bench <dir>]  (> $BENCH_DIR > sibling of the repo checkout)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsuFeat } from '../../docs/js/osu.js';
import { prepareFeatureNotes, feats } from '../../docs/js/features.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BENCH = path.resolve(opt('--bench', process.env.BENCH_DIR || path.resolve(here, '..', '..', '..', 'VSRG-DanEstimation-Benchmark-main')));

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
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
const despace = s => s.replace(/\s+/g, '').toLowerCase();

const rows = parseCsv(fs.readFileSync(path.join(BENCH, 'samples', 'data.csv'), 'utf8'));
const header = rows.shift();
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const dirs = {};
for (const p of ['course', 'jack', 'ln', 'speed', 'stamina', 'tech']) {
  const idx = new Map();
  for (const f of fs.readdirSync(path.join(BENCH, 'samples', p))) {
    if (!f.endsWith('.osu')) continue;
    const b = f.slice(0, -4);
    for (const k of [b, norm(b), despace(b)]) if (!idx.has(k)) idx.set(k, path.join(BENCH, 'samples', p, f));
  }
  dirs[p] = idx;
}
const out = [];
for (const r of rows) {
  const name = r[col.name], pattern = r[col.pattern];
  if (!name) continue;
  const d = dirs[pattern];
  const file = d ? (d.get(name) || d.get(norm(name)) || d.get(despace(name))) : null;
  if (!file) { out.push({ pattern, name, jack180: null, ln_frac: null }); continue; }
  const text = new TextDecoder('utf-8').decode(fs.readFileSync(file));
  try {
    const pf = prepareFeatureNotes(parseOsuFeat(text));
    const F = feats(pf.s, pf.c, pf.e, pf.od);
    out.push({ pattern, name, jack180: F.jack180, ln_frac: F.ln_frac });
  } catch { out.push({ pattern, name, jack180: null, ln_frac: null }); }
}
fs.writeFileSync(path.join(here, 'feats.json'), JSON.stringify(out));
console.error(`feats.json: ${out.length} rows, null-features: ${out.filter(x => x.jack180 === null).length}`);
