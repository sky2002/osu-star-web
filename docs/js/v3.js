// Star v3 (test): the reading of one chart from model/v3a.onnx, model/v3b.onnx, model/v3.json and model/v3-0.bin.
// Steps marked float32 round every operation with Math.fround so the readings match the published values.
import { f32 } from './pyutil.js';
import { v1Windows } from './reader.js';

export const V3_RATES = [1, 1.5];   // checked rates; others (0.5-2) are computed the same way and marked untested
const V1_W = [1, 1, 2 / 3, 1 / 3, 1 / 6];

// float16 rounding (nearest, ties to even) of a float32 value; Math.f16round where the browser has it
function f16Manual(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a >= 65520) return s * Infinity;
  let q;
  if (a < 6.103515625e-05) q = 5.960464477539063e-08;   // subnormal step 2^-24
  else {
    let e = Math.floor(Math.log2(a));
    if (2 ** e > a) e--; else if (2 ** (e + 1) <= a) e++;
    q = 2 ** (e - 10);
  }
  const v = a / q, fl = Math.floor(v), d = v - fl;
  const r = d > 0.5 ? fl + 1 : d < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1);
  return s * r * q;
}
export const f16 = typeof Math.f16round === 'function' ? Math.f16round : f16Manual;
export { f16Manual };

// Lookup tables and the per-action scoring (no network): shared by the compute worker and the helper workers.
export class V3Core {
  constructor(J, tab) {
    this.J = J;
    const sp = J.sp;
    const n = sp.n;
    this.n = n; this.mid = sp.mid; this.tab = tab;
    this.V = tab.subarray(0, 4 * n); this.D = tab.subarray(4 * n, 8 * n);
    this.umax = f32(sp.umax); this.hu = f32(sp.hu); this.uc = f32(sp.uc); this.st = f32(sp.st); this.K = sp.k;
    this.zmax = f32(sp.zmax);
    this.y0 = Float32Array.from(sp.y[0]); this.M0 = Float32Array.from(sp.M[0]); this.lz0 = f32(sp.z[0]);
    this.knots = Float32Array.from(sp.knots);
    this.c6 = f32(f32(this.st * this.st) / 6);
    this.gx = J.gl3.x.map(f32); this.gw = J.gl3.w.map(f32);
    this.P = J.grid.length;
    const q = (k) => Float64Array.from(J.q[k].flat());
    this.q0 = q('q0'); this.q1 = q('q1'); this.q2 = q('q2'); this.q3 = q('q3'); this.q4 = q('q4'); this.q5 = q('q5');
    this.dw = [0, f32(V1_W[1] - V1_W[2]), f32(V1_W[2] - V1_W[3]), f32(V1_W[3] - V1_W[4]), f32(V1_W[4])];
    this.pts = new Float64Array(64);
    // smallest float32 |z| whose u = asinh(z) reaches the table edge (the CDF is exactly 0 / 1 from there on)
    const bits = new Float32Array(1), ib = new Int32Array(bits.buffer);
    bits[0] = 1; let lo = ib[0];
    bits[0] = this.zmax; let hi = ib[0];
    while (lo < hi) {
      const m = lo + ((hi - lo) >> 1);
      ib[0] = m;
      if (f32(Math.asinh(bits[0])) >= this.uc) hi = m; else lo = m + 1;
    }
    ib[0] = lo;
    this.zEdge = bits[0];
  }

  // tabulated CDF at z (float32), channel ch (0 press / LN head, 1 LN tail)
  cdf(z, ch) {
    const neg = z < 0;
    if (z >= this.zEdge) return 1;
    if (z <= -this.zEdge) return 0;
    const u = f32(Math.asinh(z));
    const q = f32(f32(u + this.umax) / this.hu);
    let j = Math.floor(q);
    if (neg) { if (j < 0) j = 0; else if (j > this.mid - 1) j = this.mid - 1; }
    else if (j < this.mid) j = this.mid; else if (j > this.n - 2) j = this.n - 2;
    let t = f32(q - j);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const t2 = f32(t * t), t3 = f32(t2 * t);
    const h00 = f32(f32(f32(2 * t3) - f32(3 * t2)) + 1);
    const h10 = f32(f32(t3 - f32(2 * t2)) + t);
    const h01 = f32(f32(-2 * t3) + f32(3 * t2));
    const h11 = f32(t3 - t2);
    const b = ch * 2 * this.n + (neg ? 0 : this.n) + j;
    const V = this.V, D = this.D;
    const val = f32(f32(f32(f32(h00 * V[b]) + f32(h10 * D[b])) + f32(h01 * V[b + 1])) + f32(h11 * D[b + 1]));
    const S = f32(Math.exp(val));
    return neg ? S : f32(1 - S);
  }

  // ScoreV1 of a press: windows W[1..4] (+0.5, float32)
  tapScore(mu, sig, W) {
    let s = 0;
    for (let g = 1; g < 5; g++) {
      let d = f32(this.cdf(f32(f32(W[g] - mu) / sig), 0) - this.cdf(f32(f32(-W[g] - mu) / sig), 0));
      if (d < 0) d = 0;
      s = f32(s + f32(this.dw[g] * d));
    }
    return s;
  }

  // chart constants of the long-note score (they depend only on the six windows w)
  lnConstants(w) {
    const wf = w.map(f32);
    const w4e = f32(wf[4] + 0.5), LT = f32(-1.5 * wf[5]);
    const raw = [[f32(f32(1.1) * wf[1]), f32(f32(2.2) * wf[1])], [wf[2], f32(2 * wf[2])], [wf[3], f32(2 * wf[3])]];
    const specs = raw.map(([a, b], k) => {
      const A = f32(Math.floor(f32(a + f32(1e-6))) + 0.5), B = f32(Math.floor(f32(b + f32(1e-6))) + 0.5);
      const U = Math.min(A, B);
      const h1 = Math.min(Math.max(f32(B - w4e), 0), U);
      const hk = f32(B + LT);
      return { A, B, U, h1, hk, kink: h1 < hk && hk < U, dw: this.dw[k + 1] };
    });
    return { w4e, nw4e: f32(-w4e), v14: f32(V1_W[4]), specs };
  }

  // integral over one reflection r (+1 / -1) of the head offset, in u = asinh((h - muH) / sigH)
  lnPanel(r, h1, U, hk, kink, B, muH, sigH, muT, sigT, dbg) {
    const ua = f32(Math.asinh(f32(f32(r * h1 - muH) / sigH)));
    const ub = f32(Math.asinh(f32(f32(r * U - muH) / sigH)));
    const uc = this.uc, st = this.st;
    let lo = ua < ub ? ua : ub, hi = ua < ub ? ub : ua;
    if (lo < -uc) lo = -uc; else if (lo > uc) lo = uc;
    if (hi < -uc) hi = -uc; else if (hi > uc) hi = uc;
    const ka = Math.floor(f32(f32(lo + uc) / st)) + 1;
    const kend = Math.ceil(f32(f32(hi + uc) / st));
    const pts = this.pts, kn = this.knots;
    let n = 0;
    pts[n++] = lo;
    const i0 = Math.max(ka, 0), i1 = Math.min(kend, this.K);
    for (let i = i0; i < i1; i++) { const v = kn[i]; pts[n++] = v < lo ? lo : v > hi ? hi : v; }
    pts[n++] = hi;
    if (kink) {   // insert the kink point in order (it is not clipped)
      const v = f32(Math.asinh(f32(f32(r * hk - muH) / sigH)));
      let k = n++;
      while (k > 0 && pts[k - 1] > v) { pts[k] = pts[k - 1]; k--; }
      pts[k] = v;
    }
    if (dbg) dbg.push({ lo, hi, nin: Math.max(kend - ka, 0) });
    const gx = this.gx, gw = this.gw, y = this.y0, M = this.M0, c6 = this.c6, lz = this.lz0;
    let acc = 0;
    for (let k = 1; k < n; k++) {
      const e0 = pts[k - 1];
      const half = f32(0.5 * f32(pts[k] - e0));
      if (half === 0) continue;
      const mid = f32(e0 + half);
      for (let g = 0; g < 3; g++) {
        const u = f32(mid + f32(half * gx[g]));
        const qq = f32(f32(u + uc) / st);
        let i = Math.floor(qq);
        if (i < 0) i = 0; else if (i > 47) i = 47;
        const b = f32(qq - i), a = f32(1 - b);
        const sa = f32(f32(f32(f32(a * a) * a) - a) * M[i]), sb = f32(f32(f32(f32(b * b) * b) - b) * M[i + 1]);
        const fu = f32(Math.exp(f32(f32(f32(f32(a * y[i]) + f32(b * y[i + 1])) + f32(f32(sa + sb) * c6)) - lz)));
        const s = f32(B - f32(r * f32(muH + f32(sigH * f32(Math.sinh(u))))));
        let G = f32(this.cdf(f32(f32(s - muT) / sigT), 1) - this.cdf(f32(f32(-s - muT) / sigT), 1));
        if (G < 0) G = 0;
        acc += f32(f32(fu * G) * f32(half * gw[g]));
      }
    }
    return f32(acc);
  }

  // ScoreV1 score of a long note (head and tail together), before the miss factors
  lnScore(muH, sigH, muT, sigT, C, dbg = null) {
    let full = f32(1 - this.cdf(f32(f32(C.nw4e - muT) / sigT), 1));
    if (full < 0) full = 0;
    let out = f32(C.v14 * (full < 1 ? full : 1));
    if (dbg) dbg.full = full;
    for (const S of C.specs) {
      let pin = f32(this.cdf(f32(f32(S.h1 - muH) / sigH), 0) - this.cdf(f32(f32(-S.h1 - muH) / sigH), 0));
      if (pin < 0) pin = 0;
      const ref = dbg ? [] : null;
      const tot = f32(this.lnPanel(1, S.h1, S.U, S.hk, S.kink, S.B, muH, sigH, muT, sigT, ref)
        + this.lnPanel(-1, S.h1, S.U, S.hk, S.kink, S.B, muH, sigH, muT, sigT, ref));
      out = f32(out + f32(S.dw * f32(f32(full * pin) + tot)));
      if (dbg) (dbg.specs || (dbg.specs = [])).push({ pin, tot, ref });
    }
    return out;
  }

  // mu, sigma, miss probability and ScoreV1 of every action at level p for one orientation (x = { lk, dpi, dmu })
  level(p, x, comp, isHead, lnH, lnT, W, C, rate, mu, sig, pi, v1) {
    const A = comp.length;
    const { lk, dpi, dmu } = x;
    const fr = f32(rate);
    for (let a = 0; a < A; a++) {
      const k = p * 2 + comp[a];
      const l = lk[a];
      let ls = this.q0[k] + this.q1[k] * l;
      if (ls < -5) ls = -5; else if (ls > 8) ls = 8;
      let s = f32(Math.exp(ls)), m = f32(this.q2[k] + this.q3[k] * l + dmu[a]);
      if (rate !== 1) { m = f32(m * fr); s = f32(s * fr); }
      mu[a] = m; sig[a] = s;
      pi[a] = f32(1 / (1 + Math.exp(-(this.q4[k] + this.q5[k] * l + dpi[a]))));
    }
    for (let a = 0; a < A; a++) v1[a] = comp[a] || isHead[a] ? 0 : f32(this.tapScore(mu[a], sig[a], W) * f32(1 - pi[a]));
    for (let j = 0; j < lnH.length; j++) {
      const h = lnH[j], t = lnT[j];
      const sl = this.lnScore(mu[h], sig[h], mu[t], sig[t], C);
      v1[h] = f32(f32(f32(1 - pi[h]) * f32(1 - pi[t])) * sl);
    }
  }

  // levels p0..p1-1, both orientations xs = [x0, x1]: sum over actions of the orientation-mean ScoreV1 per level
  readoutRange(xs, comp, lnH, lnT, w, rate, p0, p1) {
    const A = comp.length;
    const isHead = new Uint8Array(A);
    for (const h of lnH) isHead[h] = 1;
    const W = w.slice(0, 5).map(v => f32(f32(v) + 0.5));
    const C = this.lnConstants(w);
    const mu = new Float32Array(A), sig = new Float32Array(A), pi = new Float32Array(A), v1 = new Float32Array(A);
    const out = new Float64Array(p1 - p0);
    for (let p = p0; p < p1; p++) {
      let s = 0;
      for (const x of xs) {
        this.level(p, x, comp, isHead, lnH, lnT, W, C, rate, mu, sig, pi, v1);
        for (let a = 0; a < A; a++) s += 0.5 * v1[a];
      }
      out[p - p0] = s;
    }
    return out;
  }
}

export class V3 extends V3Core {
  constructor(J, tab, sa, sb, ort) {
    super(J, tab);
    this.sa = sa; this.sb = sb; this.ort = ort;
    this.tm = Float64Array.from(J.tok.m); this.ts = Float64Array.from(J.tok.s);
    this.logCols = new Uint8Array(17);
    for (const d of J.tok.d) this.logCols[d] = 1;
    this.g = J.g.map(f32);
    this.hm = Float32Array.from(J.hs.m); this.hsd = Float32Array.from(J.hs.s);
  }

  static async create({ ort, loadBytes, loadJson }) {
    const [J, a, b] = await Promise.all([loadJson('model/v3.json'), loadBytes('model/v3a.onnx'), loadBytes('model/v3b.onnx')]);
    const bin = await loadBytes('model/' + J.sp.file);
    const tab = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    if (tab.length !== 8 * J.sp.n) throw new Error(`${J.sp.file}: unexpected size`);
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [sa, sb] = await Promise.all([ort.InferenceSession.create(a, opt), ort.InferenceSession.create(b, opt)]);
    return new V3(J, tab, sa, sb, ort);
  }

  // standardised tokens [A*17] (float32), the mirrored copy, and the per-action clock gaps (ms, float64)
  standardise(tk) {
    const A = tk.nActions, raw = tk.tokens, tau = this.J.tok.tau, c = this.J.clk;
    const z = new Float32Array(A * 17), gap = new Float64Array(A);
    for (let a = 0; a < A; a++) {
      for (let d = 0; d < 17; d++) {
        let x = raw[a * 17 + d];
        if (this.logCols[d]) x = Math.log1p(Math.expm1(x) * 1000 / tau);
        z[a * 17 + d] = f32((x - this.tm[d]) / this.ts[d]);
      }
      const z16 = f32((raw[a * 17 + c.col] - c.m) / c.s);
      gap[a] = Math.expm1(z16 * c.s + c.m) * 1000;
    }
    const zm = z.slice();
    for (let a = 0; a < A; a++) {
      const b = a * 17 + 10;
      zm[b] = z[b + 3]; zm[b + 1] = z[b + 2]; zm[b + 2] = z[b + 1]; zm[b + 3] = z[b];
    }
    return { z, zm, gap };
  }

  // one orientation: windows of 256 actions (192 kept), two look-ahead masks -> l [A*2], e [A*4], h [A*128] (raw outputs)
  async encode(z, gap, A, onProgress = null) {
    const [WIN, CORE, HALO] = this.J.win;
    const { lay, tol } = this.J.clk;
    const L1 = lay[0] + tol, L2 = lay[1] + tol;
    const nW = Math.ceil(A / CORE);
    const l = new Float32Array(A * 2), e = new Float32Array(A * 4), h = new Float32Array(A * 128);
    const CH = 16;
    const tm = new Float64Array(WIN);
    const T = this.ort.Tensor;
    for (let w0 = 0; w0 < nW; w0 += CH) {
      const nw = Math.min(CH, nW - w0);
      const xw = new Float32Array(nw * WIN * 17), valid = new Uint8Array(nw * WIN);
      const m1 = new Uint8Array(nw * WIN * WIN), m2 = new Uint8Array(nw * WIN * WIN);
      for (let w = 0; w < nw; w++) {
        const start = (w0 + w) * CORE - HALO;
        let cum = 0;
        for (let p = 0; p < WIN; p++) {
          const s = start + p;
          if (s >= 0 && s < A) {
            valid[w * WIN + p] = 1;
            xw.set(z.subarray(s * 17, s * 17 + 17), (w * WIN + p) * 17);
            cum += gap[s];
          }
          tm[p] = cum;
        }
        for (let i = 0; i < WIN; i++) {
          const vi = valid[w * WIN + i], o = (w * WIN + i) * WIN;
          for (let j = 0; j < WIN; j++) {
            if (!valid[w * WIN + j]) continue;
            if (!vi) { m1[o + j] = 1; m2[o + j] = 1; continue; }
            const dt = tm[j] - tm[i];
            if (dt <= L1) m1[o + j] = 1;
            if (dt <= L2) m2[o + j] = 1;
          }
        }
      }
      const res = await this.sa.run({
        xw: new T('float32', xw, [nw, WIN, 17]), valid: new T('bool', valid, [nw, WIN]),
        m1: new T('bool', m1, [nw, 1, WIN, WIN]), m2: new T('bool', m2, [nw, 1, WIN, WIN]),
      });
      const o0 = res.o0.data, o1 = res.o1.data, o2 = res.o2.data;
      for (let w = 0; w < nw; w++) {
        const a0 = (w0 + w) * CORE, a1 = Math.min(a0 + CORE, A);
        for (let a = a0; a < a1; a++) {
          const r = w * WIN + HALO + (a - a0);
          l[a * 2] = o0[r * 2]; l[a * 2 + 1] = o0[r * 2 + 1];
          for (let k = 0; k < 4; k++) e[a * 4 + k] = o1[r * 4 + k];
          h.set(o2.subarray(r * 128, r * 128 + 128), a * 128);
        }
      }
      if (onProgress) onProgress(Math.min(1, (w0 + nw) / nW));
    }
    return { l, e, h };
  }

  // each action's own column: lk = l / g, and the two offsets for its kind (press / release)
  columns(enc, comp) {
    const A = comp.length;
    const lk = new Float32Array(A), dpi = new Float32Array(A), dmu = new Float32Array(A);
    for (let a = 0; a < A; a++) {
      const c = comp[a];
      lk[a] = f32(enc.l[a * 2 + c] / this.g[c]);
      dpi[a] = enc.e[a * 4 + c];
      dmu[a] = enc.e[a * 4 + 2 + c];
    }
    return { lk, dpi, dmu };
  }

  // accuracy curve over the 37 levels (sum over actions / number of notes), locally or split over a helper pool
  async readout(xs, tk, w, rate, pool = null) {
    const P = this.P, sums = new Float64Array(P);
    if (!pool || !pool.size) sums.set(this.readoutRange(xs, tk.comp, tk.lnH, tk.lnT, w, rate, 0, P));
    else {
      // small blocks of levels; each helper takes the next block when it finishes one (the cost per level is uneven)
      const B = 2;
      let next = 0;
      const lane = async (i) => {
        while (next < P) {
          const p0 = next, p1 = Math.min(P, p0 + B);
          next = p1;
          sums.set(await pool.callOn(i, { type: 'v3run', xs, comp: tk.comp, lnH: tk.lnH, lnT: tk.lnT, w, rate, p0, p1 }), p0);
        }
      };
      await Promise.all(Array.from({ length: Math.min(pool.size, P) }, (_, i) => lane(i)));
    }
    const acc = new Float64Array(P);
    for (let p = 0; p < P; p++) acc[p] = sums[p] / tk.nNotes;
    return acc;
  }

  // theta*: where the running-minimum curve of log(1 - acc) crosses log(1 - thr), linear between levels
  theta(acc) {
    const grid = this.J.grid, P = grid.length, thr = this.J.thr;
    const z = new Float64Array(P);
    for (let p = 0; p < P; p++) z[p] = Math.log(Math.min(Math.max(1 - acc[p], 1e-12), 1));
    for (let p = 1; p < P; p++) if (z[p] > z[p - 1]) z[p] = z[p - 1];
    const zt = Math.log(1 - thr);
    let t, flag = '';
    if (!z.every(Number.isFinite)) return { theta: NaN, flag: 'missing' };
    if (z[0] <= zt) { t = grid[0]; flag = 'censored_low'; }
    else if (z[P - 1] > zt) { t = grid[P - 1]; flag = 'censored_high'; }
    else {
      let k = 0; while (!(z[k] <= zt)) k++;
      const z0 = z[k - 1], z1 = z[k];
      t = z0 !== z1 ? grid[k - 1] + (grid[k] - grid[k - 1]) * (z0 - zt) / (z0 - z1) : grid[k];
    }
    if (!flag) {
      const [lo, hi] = this.J.rng;
      if (t < lo) flag = 'extrap_low'; else if (t > hi) flag = 'extrap_high';
    }
    return { theta: t, flag };
  }

  // 320 ms bins of the orientation-mean outputs: 132 columns per bin, rounded to float16 -> { F [T*132], T }
  bins(times, comp, hbar, lkbar) {
    const A = comp.length, bms = this.J.bms, t0 = times[0];
    const bin = new Int32Array(A);
    for (let a = 0; a < A; a++) bin[a] = Math.floor((times[a] - t0) / bms);
    const T = bin[A - 1] + 1;
    const F = new Float32Array(T * 132);
    const cnt = new Float32Array(T), hd = new Float32Array(T), ls = new Float32Array(T), lm = new Float32Array(T).fill(-Infinity);
    for (let a = 0; a < A; a++) {
      const b = bin[a], o = b * 132;
      for (let d = 0; d < 128; d++) F[o + d] = f32(F[o + d] + hbar[a * 128 + d]);
      cnt[b] = f32(cnt[b] + 1);
      if (comp[a] === 0) hd[b] = f32(hd[b] + 1);
      ls[b] = f32(ls[b] + lkbar[a]);
      if (lkbar[a] > lm[b]) lm[b] = lkbar[a];
    }
    for (let b = 0; b < T; b++) {
      const o = b * 132, c = cnt[b] > 1 ? cnt[b] : 1;
      for (let d = 0; d < 128; d++) F[o + d] = f16(f32(F[o + d] / c));
      F[o + 128] = f16(cnt[b]); F[o + 129] = f16(hd[b]);
      F[o + 130] = f16(f32(ls[b] / c)); F[o + 131] = f16(cnt[b] > 0 ? lm[b] : 0);
    }
    return { F, T };
  }

  // network input [132, L] (channel first) from the first nb bins and the bin mask
  levelInput(F, T) {
    const n = Math.min(T, this.J.nb), L = Math.max(n, 8);
    const x = new Float32Array(132 * L), m = new Uint8Array(L);
    for (let b = 0; b < n; b++) {
      if (!(F[b * 132 + 128] > 0)) continue;
      m[b] = 1;
      for (let c = 0; c < 132; c++) x[c * L + b] = f32(f32(F[b * 132 + c] - this.hm[c]) / this.hsd[c]);
    }
    return { x, m, n, L };
  }

  async levelNet({ x, m, L }, theta) {
    const T = this.ort.Tensor;
    const res = await this.sb.run({ x: new T('float32', x, [1, 132, L]), m: new T('bool', m, [1, L]), t: new T('float32', Float32Array.of(theta), [1]) });
    return Array.from(res.o0.data);
  }

  // whole chart: tk = tokensFromNotes(notes, rate); od = the OD used for the windows
  async run(tk, { od, rate = 1, hit = '', pool = null, onProgress = null }) {
    const A = tk.nActions;
    const prog = onProgress || (() => {});
    const t0 = performance.now();
    const w = v1Windows(od, rate, hit);
    const { z, zm, gap } = this.standardise(tk);
    const e0 = await this.encode(z, gap, A, f => prog(30 * f));
    const e1 = await this.encode(zm, gap, A, f => prog(30 + 30 * f));
    const xs = [this.columns(e0, tk.comp), this.columns(e1, tk.comp)];
    const t1 = performance.now();
    const acc = await this.readout(xs, tk, w, rate, pool);
    const { theta, flag } = this.theta(acc);
    prog(90);
    const t2 = performance.now();
    const hb = e0.h, h1 = e1.h;
    for (let i = 0; i < hb.length; i++) hb[i] = f32(0.5 * f32(hb[i] + h1[i]));
    const lkb = new Float32Array(A);
    for (let a = 0; a < A; a++) lkb[a] = f32(0.5 * f32(xs[0].lk[a] + xs[1].lk[a]));
    const { F, T } = this.bins(tk.times, tk.comp, hb, lkb);
    const H = await this.levelNet(this.levelInput(F, T), theta);
    let s = 0;
    for (const v of H) s += v;
    const mean = s / H.length;
    prog(100);
    const t3 = performance.now();
    return { theta, flag, H, mean, star: this.J.star[0] + this.J.star[1] * mean, acc,
      ms: { encode: t1 - t0, readout: t2 - t1, head: t3 - t2 } };
  }
}
