// Module worker: loads the model once, then scores one .osu at a time (protocol in README / app.js).
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { createEngine, VERSION, FROZEN } from './engine.js';
import { createPool } from './pool.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const base = new URL('../', import.meta.url);
let engine = null;
let queue = Promise.resolve();

async function loadBytes(p) {
  const r = await fetch(new URL(p, base));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function loadJson(p) {
  const r = await fetch(new URL(p, base));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

self.onmessage = (ev) => {
  const m = ev.data;
  queue = queue.then(() => handle(m)).catch(err => {
    self.postMessage({ type: 'error', id: m && m.id, message: String(err && err.message || err) });
  });
};

async function handle(m) {
  if (m.type === 'init') {
    try {
      const ports = m.ports || [];
      engine = await createEngine({ ort, loadBytes, loadJson, makePool: ports.length ? R => createPool(R, ports) : null });
      self.postMessage({ type: 'ready', version: VERSION, frozen: FROZEN, loadMs: engine.loadMs, helpers: engine.pool ? engine.pool.size : 0 });
    } catch (e) {
      self.postMessage({ type: 'error', message: '模型加载失败：' + String(e && e.message || e) });
    }
    return;
  }
  if (m.type === 'cnn') {   // new star only, for a chart the page already scored with P1h (theta* comes from that result)
    let cnn;
    try {
      if (!engine) throw new Error('model not loaded');
      cnn = await engine.cnnOnly(m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes), {
        rate: m.rate || 1, theta: m.theta, hit: m.hit || '', odOverride: Number.isFinite(m.odOverride) ? m.odOverride : null });
    } catch (e) {
      cnn = { ok: false, reason: 'run_error', text: '新星数计算出错：' + String(e && e.message || e) };
    }
    self.postMessage({ type: 'result', id: m.id, result: { cnnOnly: true, cnn } });
    return;
  }
  if (m.type === 'score') {
    const id = m.id;
    let result;
    try {
      if (!engine) throw new Error('model not loaded');
      let last = -1;
      result = await engine.scoreBytes(m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes), {
        oszHasOsb: !!m.oszHasOsb,
        rate: m.rate || 1,
        hit: m.hit || '',
        odOverride: Number.isFinite(m.odOverride) ? m.odOverride : null,
        withSub: !!m.withSub,
        withItems: !!m.withItems,   // key-pattern items (beta): the web page asks for them; the tosu counter does not
        withCnn: !!m.withCnn,       // new star (test): only with the experimental switch on
        onProgress: (stage, pct) => {
          const p = Math.round(pct);
          if (p !== last) { last = p; self.postMessage({ type: 'progress', id, stage, pct: p }); }
        },
      });
    } catch (e) {
      result = { ok: false, reason: 'parse_error', message: '计算出错：' + String(e && e.message || e) };
    }
    if (result.ok) { result.lnFrac = result.features.ln_frac; delete result.features; delete result.acc; }   // keep the message small; the page only needs the LN share
    self.postMessage({ type: 'result', id, result });
  }
}
