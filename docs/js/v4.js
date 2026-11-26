import { f16 } from './v3.js';
import { v4Actions, V4Actions } from './v4-encode.js';
import { itemInputs, itemReadout, segmentReadout } from './v4-items.js';
import { V4Score } from './v4-score.js';
import { CancelledError, checkpoint, untilCancelled } from './task-control.js';

const round = Math.fround;
const target = 0.96;
const epsilon = 1e-4;
const W = 192;
const C = W + 4;

export function v4HelperCount(available, nNotes, nLongNotes) {
  return Math.min(available, nNotes * 402 + nLongNotes * 602 > 12000000 ? 2 : 4);
}

function prefix(scores, n, levels) {
  const out = new Float64Array((n + 1) * levels);
  for (let k = 0; k < levels; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += scores[k * n + i];
      out[k * (n + 1) + i + 1] = sum;
    }
  }
  return out;
}

function averageRange(grid, values, scorer, from, to, isCancelled) {
  if (from === to) return null;
  const N = scorer.n + 1;
  const count = to - from;
  const fixed = Float64Array.from(grid, (_, k) => (values[k * N + to] - values[k * N + from]) / count);
  return { fixed, async at(t) {
    t = round(t);
    let sum = 0;
    for (let i = from; i < to; i++) {
      if (isCancelled && (i - from) % 256 === 0) await checkpoint(isCancelled);
      sum += scorer.at(i, t);
    }
    return sum / count;
  } };
}

function averageWeighted(grid, scores, scorer, weights, isCancelled) {
  const ids = [], w = [];
  let count = 0;
  for (let i = 0; i < weights.length; i++) {
    const a = weights[i];
    if (!(a > 0)) continue;
    ids.push(i);
    w.push(a);
    count += a;
  }
  if (!count) return null;
  const fixed = Float64Array.from(grid, (_, k) => {
    let sum = 0;
    const offset = k * scorer.n;
    for (let i = 0; i < ids.length; i++) sum += w[i] * scores[offset + ids[i]];
    return sum / count;
  });
  return { fixed, async at(t) {
    t = round(t);
    let sum = 0;
    for (let i = 0; i < ids.length; i++) {
      if (isCancelled && i % 256 === 0) await checkpoint(isCancelled);
      sum += w[i] * scorer.at(ids[i], t);
    }
    return sum / count;
  } };
}

async function root(data, grid, top, u) {
  if (!data) return { theta: null, flag: '' };
  const { fixed, at } = data;
  if (!fixed.every(Number.isFinite)) throw new Error('读数异常');
  const end = grid.length - 1;
  const high = () => ({
    theta: top + Math.max(Math.log(Math.max(1 - fixed[end], 1e-12)) - Math.log(1 - target), 0) / u,
    flag: 'extrap_high',
  });
  if (fixed[0] >= target) {
    const dx = 0.004;
    const slope = Math.max(((await at(grid[0] + dx)) - fixed[0]) / dx, 0.01);
    return { theta: grid[0] - (fixed[0] - target) / slope, flag: 'extrap_low' };
  }
  let k = 1;
  while (k < end && fixed[k] < target) k++;
  if (k === end || grid[k - 1] >= top) return high();
  let lo = grid[k - 1], hi = grid[k];
  let flo = fixed[k - 1] - target, fhi = fixed[k] - target;
  let theta = lo;
  for (let i = 0; i < 8; i++) {
    const dx = Math.max(hi - lo, 1e-16);
    const dy = Math.max(fhi - flo, 1e-16);
    theta = lo - flo * dx / dy;
    const f = (await at(theta)) - target;
    if (Math.abs(f) <= 2e-6 * dy / dx) break;
    if (f >= 0) { hi = theta; fhi = f; }
    else { lo = theta; flo = f; }
  }
  return theta > top ? high() : { theta, flag: '' };
}

export function binValues(actions, h, fixed, config) {
  const { times, comp, heads } = actions;
  const n = times.length;
  const lk = new Float32Array(n).fill(NaN);
  for (let i = 0; i < heads.length; i++) {
    const loss = Math.max(epsilon, Math.min(1 - epsilon, 1 - fixed[i]));
    lk[heads[i]] = Math.log(loss) - Math.log1p(-loss);
  }
  const t0 = times[0];
  const T = Math.floor((times[n - 1] - t0) / config.bms) + 1;
  const length = Math.min(T, config.nb);
  const F = new Float32Array(length * C);
  const judged = new Int32Array(length);
  const peak = new Float32Array(length).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const b = Math.floor((times[i] - t0) / config.bms);
    if (b >= length) break;
    const o = b * C;
    for (let c = 0; c < W; c++) F[o + c] += h[i * W + c];
    F[o + W]++;
    if (comp[i] === 0) F[o + W + 1]++;
    const value = lk[i];
    if (!Number.isNaN(value)) {
      judged[b]++;
      F[o + W + 2] += value;
      peak[b] = Math.max(peak[b], value);
    }
  }
  const L = Math.max(length, 8);
  const x = new Float32Array(C * L), m = new Uint8Array(L);
  const center = Float32Array.from(config.hs.m), scale = Float32Array.from(config.hs.s);
  for (let b = 0; b < length; b++) {
    const o = b * C;
    const count = F[o + W];
    if (!count) continue;
    m[b] = 1;
    for (let c = 0; c < W; c++) F[o + c] = round(F[o + c] / count);
    F[o + W + 2] = round(F[o + W + 2] / Math.max(1, judged[b]));
    F[o + W + 3] = judged[b] ? peak[b] : 0;
    for (let c = 0; c < C; c++) {
      F[o + c] = f16(F[o + c]);
      x[c * L + b] = round(round(F[o + c] - center[c]) / scale[c]);
    }
  }
  return { F, T, L, x, m, lk };
}

export class V4 {
  constructor(ort, config, actions, session) {
    Object.assign(this, { ort, config, actions, session });
    this.pools = new WeakMap();
  }

  static async create({ ort, loadBytes, loadJson }) {
    const assets = { ort, loadBytes, loadJson };
    const [config, bytes, actions] = await Promise.all([
      loadJson('model/v4.json'), loadBytes('model/v4b.onnx'), V4Actions.create(assets),
    ]);
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return new V4(ort, config, actions, session);
  }

  initPool(pool) {
    if (!pool?.size) return Promise.resolve(null);
    if (!this.pools.has(pool)) {
      this.pools.set(pool, pool.broadcast({ type: 'v4init' }).then(() => pool, () => null));
    }
    return this.pools.get(pool);
  }

  async run(notes, { od, rate = 1, hit = '', odOverride = null, flags = {}, pool = null,
    onProgress = null, debug = false, tokens = null, isCancelled = null } = {}) {
    const config = this.config;
    const grid = config.grid;
    const t0 = performance.now();
    const actions = v4Actions(notes, rate, tokens);
    if (!actions.nNotes) throw new Error('谱面没有物件。');
    const { nActions, nNotes, lnH, heads, D } = actions;
    const { h, pre, blocks, ...outputs } = await this.actions.run(actions, p => onProgress?.(60 * p), debug, isCancelled);
    await checkpoint(isCancelled);
    const t1 = performance.now();
    const layout = { nActions, nNotes, lnH, heads, D };
    const scorer = new V4Score(outputs, layout, od, rate, hit);
    const live = await untilCancelled(this.initPool(pool), isCancelled);
    let scores;
    if (live) {
      try {
        const count = v4HelperCount(live.size, nNotes, lnH.length);
        const chunks = await Promise.all(Array.from({ length: count }, (_, j) => {
          const start = Math.floor(grid.length * j / count), end = Math.floor(grid.length * (j + 1) / count);
          return live.callOn(j, { type: 'v4run', outputs, layout, od, rate, hit, levels: grid.slice(start, end) }, isCancelled);
        }));
        scores = new Float32Array(nNotes * grid.length);
        let offset = 0;
        for (const chunk of chunks) { scores.set(chunk, offset); offset += chunk.length; }
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        scores = await scorer.readRows(grid, isCancelled);
      }
    } else scores = await scorer.readRows(grid, isCancelled);
    await checkpoint(isCancelled);
    const totals = prefix(scores, nNotes, grid.length);
    const full = averageRange(grid, totals, scorer, 0, nNotes, isCancelled);
    const { theta, flag } = await root(full, grid, config.top, config.u0);
    const withItems = !flags.sv;
    const itemsUntested = rate !== 1 || hit !== '' || odOverride !== null;
    const { weights, windows } = itemInputs(actions, pre, withItems);
    const itemRoots = weights ? [] : null;
    for (const w of weights ?? []) {
      const weighted = averageWeighted(grid, scores, scorer, w, isCancelled);
      itemRoots.push((await root(weighted, grid, config.top, config.u1)).theta);
    }
    const windowRoots = [];
    for (const { from, to } of windows) {
      const range = averageRange(grid, totals, scorer, from, to, isCancelled);
      windowRoots.push((await root(range, grid, config.top, config.u0)).theta);
    }
    onProgress?.(90);
    const t2 = performance.now();
    const bins = binValues(actions, h, await scorer.readRows([0], isCancelled, true), config);
    const { x, m, L } = bins;
    const Tensor = this.ort.Tensor;
    const res = await this.session.run({
      x: new Tensor('float32', x, [1, C, L]),
      m: new Tensor('bool', m, [1, L]),
      t: new Tensor('float32', Float32Array.of(theta), [1]),
    });
    const H = Array.from(res.o0.data);
    const mean = H.reduce((a, b) => a + b, 0) / H.length;
    const star = config.sc[0] + config.sc[1] * mean;
    if (!Number.isFinite(star) || !Number.isFinite(theta)) throw new Error('读数异常');
    await checkpoint(isCancelled);
    const losses = withItems ? Float32Array.from(await scorer.readRows([theta], isCancelled), value => 1 - value) : null;
    const items = withItems ? itemReadout({ weights, roots: itemRoots, losses, star, theta, config }) : { items: null, stamina: null };
    const segments = segmentReadout({ windows, roots: windowRoots, star, theta, config });
    const untested = (rate !== 1 && rate !== 1.5) || hit !== '' || odOverride !== null;
    onProgress?.(100);
    const ms = { a: t1 - t0, b: t2 - t1, c: performance.now() - t2 };
    const result = { star, theta, flag, untested, itemsUntested, ...items, ...segments, ms };
    if (debug) result.debug = { actions, h, pre, blocks, ...outputs, ...bins, scores, H, losses, windows, weights, itemRoots, windowRoots };
    return result;
  }
}
