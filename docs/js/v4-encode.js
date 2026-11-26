import { checkpoint } from './task-control.js';
import { tokensFromNotes } from './tokens.js';
import { rint, f32 } from './pyutil.js';

const W = 192;
const C = 24;
const H = 6;
const S = W / H;
const T = 65;
const E = 1e-4;
const M = 15000;
const J = f32(Math.log1p(1500) / 31);
const U = Math.log1p(100);

export function v4Actions(notes, rate = 1, actions = null) {
  const tk = actions ?? tokensFromNotes(notes, rate);
  const { nNotes, nActions, times, comp, noteOf, lnH, lnT } = tk;
  const x = new Float32Array(nActions * 7);
  const columns = new Uint8Array(nActions);
  const heads = new Int32Array(nNotes);
  const starts = [[], [], [], []], ends = [[], [], [], []];
  let p = 0;
  for (let i = 0; i < nActions; i++) {
    const note = notes[noteOf[i]];
    const col = note[2], tail = comp[i], held = note[3];
    const at = i * 7;
    columns[i] = col;
    x[at + col] = 1;
    x[at + 4] = tail;
    x[at + 5] = held;
    if (!tail) heads[p++] = i;
    if (held) (tail ? ends : starts)[col].push(i);
  }
  for (let col = 0; col < 4; col++) {
    const ss = starts[col], ee = ends[col];
    for (let j = 0; j < ss.length; j++) {
      const lo = ss[j], hi = ee[j];
      const length = times[hi] - times[lo];
      x[lo * 7 + 6] = Math.log1p(Math.min(length, 1000) / 10) / U;
      x[hi * 7 + 6] = Math.log1p(length / 10) / U;
    }
  }
  const D = new Int32Array(lnH.length), duration = new Float32Array(lnH.length);
  for (let i = 0; i < lnH.length; i++) {
    D[i] = rint((times[lnT[i]] - times[lnH[i]]) * rate);
    duration[i] = D[i] / rate;
  }
  return { ...tk, x, columns, heads, D, duration };
}

function states(u, times) {
  const pre = new Float32Array(u.length), next = new Float32Array(u.length);
  const state = new Float32Array(C), pending = new Float32Array(C);
  const rates = [5000, 30000, 120000];
  const factors = [0, 0, 0];
  let anchor = times[0];
  for (let i = 0; i < times.length; i++) {
    const at = i * C;
    if (i && times[i] - times[i - 1] > E) {
      const delay = f32(times[i] - anchor);
      const rest = times[i] - anchor > 2000;
      for (let j = 0; j < 3; j++) {
        const rate = rates[j];
        const exponent = rest ? f32(f32(-2000 / rate) - f32(f32(delay - 2000) / 3000)) : f32(-delay / rate);
        factors[j] = f32(Math.exp(exponent));
      }
      for (let j = 0; j < C; j++) state[j] = f32(f32(state[j] + pending[j]) * factors[j % 3]);
      pending.fill(0);
      anchor = times[i];
    }
    pre.set(state, at);
    for (let j = 0; j < C; j++) {
      next[at + j] = j % 3 === 0 ? 0 : Math.log1p(state[j]);
      pending[j] += u[at + j];
    }
  }
  return { pre, next };
}

function selectRows(a, ids) {
  const out = new Float32Array(ids.length * W);
  for (let i = 0; i < ids.length; i++) out.set(a.subarray(ids[i] * W, (ids[i] + 1) * W), i * W);
  return out;
}

function arrange(a, count) {
  const out = new Float32Array(a.length);
  for (let h = 0; h < H; h++) {
    for (let i = 0; i < count; i++) {
      const from = i * W + h * S;
      out.set(a.subarray(from, from + S), (h * count + i) * S);
    }
  }
  return out;
}

function window(a, total, first, count) {
  const out = new Float32Array(count * W);
  for (let h = 0; h < H; h++) {
    const from = (h * total + first) * S;
    out.set(a.subarray(from, from + count * S), h * count * S);
  }
  return out;
}

function ranges(times, margin) {
  const begin = new Int32Array(times.length), end = new Int32Array(times.length);
  let lo = 0, hi = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[lo] - times[i] < -(M + E)) lo++;
    while (hi < times.length && times[hi] - times[i] <= margin + E) hi++;
    begin[i] = lo;
    end[i] = hi;
  }
  return { begin, end };
}

function geometry(times, first, stop, left, right, range) {
  const count = (stop - first) * (right - left);
  const l = new Int32Array(count), i = new Int32Array(count);
  const f = new Float32Array(count), m = new Uint8Array(count);
  let at = 0;
  for (let row = first; row < stop; row++) {
    for (let key = left; key < right; key++, at++) {
      if (key < range.begin[row] || key >= range.end[row]) continue;
      m[at] = 1;
      const dt = times[key] - times[row], abs = Math.abs(dt);
      if (abs <= E) {
        l[at] = T - 1;
        i[at] = T - 1;
        continue;
      }
      const pos = Math.min(31, f32(f32(Math.log1p(f32(f32(abs) / 10))) / J));
      const n = Math.min(30, Math.floor(pos));
      l[at] = n + (dt > 0 ? 32 : 0);
      i[at] = l[at] + 1;
      f[at] = pos - n;
    }
  }
  return { l, i, f, m };
}

function tables(bytes, ort) {
  const width = H / 2 * T;
  const size = width * (S + 1);
  if (bytes.byteLength !== 3 * size * 4) throw new Error('Unexpected v4 file size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (first, count) => {
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) out[i + count] = out[i] = view.getFloat32((first + i) * 4, true);
    return out;
  };
  return Array.from({ length: 3 }, (_, i) => ({
    b: new ort.Tensor('float32', read(i * size, width), [H, T]),
    w: new ort.Tensor('float32', read(i * size + width, width * S), [H, T, S]),
  }));
}

export class V4Actions {
  constructor(ort, sessions, tabs) {
    this.ort = ort;
    this.sessions = sessions;
    this.tabs = tabs;
  }

  static async create({ ort, loadBytes }) {
    const names = ['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const [raw, bytes] = await Promise.all([
      Promise.all(names.map(name => loadBytes(`model/v4${name}.onnx`))),
      loadBytes('model/v4-0.bin'),
    ]);
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const sessions = {};
    for (let i = 0; i < names.length; i++) sessions[names[i]] = await ort.InferenceSession.create(raw[i], opt);
    return new V4Actions(ort, sessions, tables(bytes, ort));
  }

  matrix(data, width) {
    return new this.ort.Tensor('float32', data, [data.length / width, width]);
  }

  async apply(stage, times, range, layer, onProgress, isCancelled = null) {
    const result = new Float32Array(times.length * W);
    const { begin, end } = range;
    const A = times.length;
    const q = arrange(stage.o1.data, A), k = arrange(stage.o2.data, A), v = arrange(stage.o3.data, A);
    let first = 0;
    while (first < A) {
      await checkpoint(isCancelled);
      let stop = Math.min(first + 192, A);
      const left = begin[first];
      while (stop - first > 1 && (stop - first) * (end[stop - 1] - left) > 131072) {
        stop = first + Math.max(1, Math.floor(131072 / (end[stop - 1] - left)));
      }
      const right = end[stop - 1], Q = stop - first, K = right - left;
      const { l, i, f, m } = geometry(times, first, stop, left, right, range);
      const shape = [1, Q, K];
      const t = this.ort.Tensor;
      const o = await this.sessions.h.run({
        q: new t('float32', window(q, A, first, Q), [1, H, Q, S]),
        k: new t('float32', window(k, A, left, K), [1, H, K, S]),
        v: new t('float32', window(v, A, left, K), [1, H, K, S]),
        l: new t('int32', l, shape), i: new t('int32', i, shape),
        f: new t('float32', f, shape), m: new t('bool', m, shape), ...this.tabs[layer],
      });
      result.set(o.o0.data, first * W);
      first = stop;
      onProgress?.((layer + first / A) * 0.3);
    }
    return this.matrix(result, W);
  }

  async run(tk, onProgress = null, trace = false, isCancelled = null) {
    const { times, x, heads, lnH, lnT, duration } = tk;
    const { a, c, d, e, f, g, i } = this.sessions;
    const range = ranges(times, 0);
    let stage = await a.run({ x: this.matrix(x, 7) });
    stage = await c.run({ x: stage.o0, y: await this.apply(stage, times, range, 0, onProgress, isCancelled) });
    const blocks = trace ? [stage.o0.data] : null;
    const { pre, next } = states(stage.o1.data, times);
    stage = await d.run({ x: stage.o0, p: this.matrix(next, C) });
    stage = await e.run({ x: stage.o0, y: await this.apply(stage, times, range, 1, onProgress, isCancelled) });
    if (blocks) blocks.push(stage.o0.data);
    const y = await this.apply(stage, times, ranges(times, 1000), 2, onProgress, isCancelled);
    const output = await f.run({ x: stage.o0, y }, trace ? ['o0', 'o1'] : ['o0']);
    stage = null;
    const h = output.o0.data;
    if (blocks) blocks.push(output.o1.data);
    await checkpoint(isCancelled);
    const p = await g.run({ x: this.matrix(selectRows(h, heads), W) });
    let Ar = new Float32Array(0), Br = Ar, rho = Ar;
    if (lnH.length) {
      await checkpoint(isCancelled);
      const x = this.matrix(selectRows(h, lnH), W), y = this.matrix(selectRows(h, lnT), W);
      const r = await i.run({ x, y, d: new this.ort.Tensor('float32', duration, [lnH.length]) });
      Ar = r.o0.data;
      Br = r.o1.data;
      rho = r.o2.data;
    }
    onProgress?.(1);
    return { h, pre, Ap: p.o0.data, Bp: p.o1.data, Ar, Br, rho, ...(blocks && { blocks }) };
  }
}
