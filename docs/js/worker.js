import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { createEngine, VERSION, FROZEN } from './engine.js';
import { createPool } from './pool.js';
import { createResourceLoader } from './resources.js';
import { CancelledError, checkCancelled, checkpoint } from './task-control.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const send = m => self.postMessage(m);
const assets = createResourceLoader(new URL('../', import.meta.url), send);
const cancelledIds = new Set();
const waiting = [];
let active = null, engine = null, ports = [];

self.onmessage = ({ data: m }) => {
  if (m.type === 'cancel') {
    const at = waiting.findIndex(({ id }) => id === m.id);
    if (at !== -1) {
      waiting.splice(at, 1);
      send({ type: 'cancelled', id: m.id });
    } else if (active?.id === m.id && active.controller) {
      cancelledIds.add(m.id);
      active.controller.abort();
    }
    return;
  }
  waiting.push(m);
  if (!active) void drain();
};

async function drain() {
  while (waiting.length) {
    const m = waiting.shift();
    const controller = m.type === 'init' ? null : new AbortController();
    active = { id: m.id, controller };
    const isCancelled = controller && Object.assign(
      () => controller.signal.aborted || cancelledIds.has(m.id), { signal: controller.signal });
    try {
      if (m.type === 'init') {
        if (m.ports?.length) ports = m.ports;
        if (!engine) engine = await createEngine({
          ort, ...assets, makePool: ports.length ? R => createPool(R, ports) : null,
          loadRuntime: () => assets.loadBytes('vendor/ort/ort-wasm-simd-threaded.wasm'),
        });
        send({ type: 'ready', version: VERSION, frozen: FROZEN, loadMs: engine.loadMs, helpers: engine.pool?.size || 0 });
      } else {
        const result = await run(m, isCancelled);
        await checkpoint(isCancelled);
        if (result) {
          for (const phase of ['v4', 'v3', 'cnn']) {
            const reading = result[phase];
            if (reading?.reason === 'load_error') send({ type: 'load_error', phase, file: reading.file || '', message: reading.text, id: m.id });
          }
          send({ type: 'result', id: m.id, result });
        }
      }
    } catch (e) {
      if (e instanceof CancelledError || isCancelled?.()) {
        send({ type: 'cancelled', id: m.id });
      } else if (m.type === 'init') {
        const message = '计算资源加载失败：' + (e?.message || e);
        send({ type: 'load_error', phase: 'init', file: e?.file || '', message });
        send({ type: 'error', message, restart: !e?.file });
      } else {
        send({ type: 'error', id: m.id, message: '计算出错：' + (e?.message || e) });
      }
    } finally {
      cancelledIds.delete(m.id);
      active = null;
    }
  }
}

async function run(m, isCancelled) {
  await checkpoint(isCancelled);
  if (!engine) throw new Error('计算资源尚未就绪');
  const bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
  const options = {
    oszHasOsb: !!m.oszHasOsb, rate: m.rate || 1, hit: m.hit || '',
    odOverride: Number.isFinite(m.odOverride) ? m.odOverride : null,
    isCancelled, onProgress: progressFor(m.id, isCancelled),
  };
  if (m.type === 'cnn') return { cnnOnly: true, cnn: await engine.cnnOnly(bytes, { ...options, theta: m.theta }) };
  if (m.type === 'v3') return { v3Only: true, v3: await engine.v3Only(bytes, options) };
  if (m.type === 'v4') return { v4Only: true, v4: await engine.v4Only(bytes, options) };
  if (m.type === 'score') {
    const result = await engine.scoreBytes(bytes, {
      ...options, withSub: !!m.withSub, withItems: !!m.withItems, withSegments: m.withSegments !== false,
      withCnn: !!m.withCnn, withV3: !!m.withV3, withV4: !!m.withV4,
    });
    if (result.ok) {
      result.lnFrac = result.features.ln_frac;
      delete result.features;
      delete result.acc;
    }
    return result;
  }
}

function progressFor(id, isCancelled) {
  let last = -1, previousStage;
  return (stage, pct) => {
    checkCancelled(isCancelled);
    const p = Math.round(pct);
    if (p === last && stage === previousStage) return;
    last = p;
    previousStage = stage;
    send({ type: 'progress', id, stage, pct: p });
  };
}
