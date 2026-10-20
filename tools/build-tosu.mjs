// Builds the tosu counter folder and zip from tosu/ plus the web page's reader (docs/js, docs/model, docs/vendor/ort):
//   node tools/build-tosu.mjs      -> dist/osu-star-tosu/ and dist/osu-star-tosu.zip
// The folder is what goes into tosu's static (counters) folder; the reader files are copied unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const outDir = path.join(root, 'dist', 'osu-star-tosu');
// the worker's import graph (js/worker.js -> engine, reader, ...) and the helper worker
const JS = ['worker.js', 'sl-worker.js', 'pool.js', 'engine.js', 'reader.js', 'osu.js', 'tokens.js', 'tdist.js', 'features.js',
  'tree.js', 'md5.js', 'pyutil.js', 'dan-estimate.js', 'dan-reference.js', 'ui-lib.js', 'acc-ladder.js', 'pattern-items.js'];
const MODEL = ['reader.json', 'tree.json', 'support.json', 'support-dt.json', 'encoder.onnx', 'acc-ladder.json', 'pattern-items.json'];

fs.rmSync(outDir, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
for (const f of fs.readdirSync(path.join(root, 'tosu'))) copy(path.join(root, 'tosu', f), path.join(outDir, f));
for (const f of JS) copy(path.join(docs, 'js', f), path.join(outDir, 'js', f));
copy(path.join(docs, 'data', 'dan-references.json'), path.join(outDir, 'data', 'dan-references.json'));
for (const f of MODEL) copy(path.join(docs, 'model', f), path.join(outDir, 'model', f));
// ui-lib.js (segment curve) imports fflate for the web page's .osz reader
for (const f of ['fflate.mjs', 'LICENSE']) copy(path.join(docs, 'vendor', 'fflate', f), path.join(outDir, 'vendor', 'fflate', f));
for (const f of fs.readdirSync(path.join(docs, 'vendor', 'ort'))) copy(path.join(docs, 'vendor', 'ort', f), path.join(outDir, 'vendor', 'ort', f));

// every relative import of the copied modules must resolve inside the folder
const missing = [];
for (const f of [...JS.map(x => path.join(outDir, 'js', x)), path.join(outDir, 'counter.js'), path.join(outDir, 'mods.js')]) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const p = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(p)) missing.push(`${path.relative(outDir, f)} -> ${m[1]}`);
  }
}
if (missing.length) { console.error('unresolved imports:\n  ' + missing.join('\n  ')); process.exit(1); }

const files = {};
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files['osu-star-tosu/' + path.relative(outDir, p).split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(p));
  }
};
walk(outDir);
const zip = zipSync(files, { level: 9 });
fs.writeFileSync(path.join(root, 'dist', 'osu-star-tosu.zip'), zip);
const total = Object.values(files).reduce((s, b) => s + b.length, 0);
console.log(`${Object.keys(files).length} files, ${(total / 1e6).toFixed(1)} MB -> dist/osu-star-tosu.zip ${(zip.length / 1e6).toFixed(1)} MB`);
