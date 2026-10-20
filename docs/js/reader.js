// theta* reader of r2-final-s29, ported from analysis/public-star-r1/ps_engine.PublicStarEngine.per_action (v1 only),
// dan-readout rules.py (expected ScoreV1 accuracy from per-action Student-t errors) and anchor.theta_star_grid.
// The encoder runs in onnxruntime-web; everything after it is plain JS. Float32 steps of the PyTorch reference are
// mirrored with Math.fround so the per-action scores match closely.
import { f32 } from './pyutil.js';

const V1_W = [1, 1, 2 / 3, 1 / 3, 1 / 6];
const V2_W = [1, 300 / 305, 200 / 305, 100 / 305, 50 / 305];
// osu_diff.stable_scorev2.WINDOW_RANGES: (OD 0, OD 5, OD 10) per window MAX, 300, 200, 100, 50, earliest
const V2_RANGES = [[22.4, 19.4, 13.9], [64, 49, 34], [97, 82, 67], [127, 112, 97], [151, 136, 121], [188, 173, 158]];
const GL_X = [-0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.755404408355003, -0.6178762444026438,
  -0.45801677765722737, -0.2816035507792589, -0.09501250983763744, 0.09501250983763744, 0.2816035507792589,
  0.45801677765722737, 0.6178762444026438, 0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
// numpy.polynomial.legendre.leggauss(16) (numpy 2.5.3), copied exactly
const GL_W = [0.027152459411754176, 0.062253523938647456, 0.0951585116824926, 0.12462897125553407, 0.1495959888165767,
  0.16915651939500265, 0.18260341504492364, 0.18945061045506864, 0.18945061045506864, 0.18260341504492364,
  0.16915651939500265, 0.1495959888165767, 0.12462897125553407, 0.0951585116824926, 0.062253523938647456, 0.027152459411754176];
const GX = GL_X.map(f32), GW = GL_W.map(f32);

// osu_diff.stable_judgement.hit_windows(od, mods): MAX, 300, 200, 100, 50, earliest (integer map-time windows).
// rate 1.5 = DT bit (x 1.5), 0.75 = HT bit (x 0.75), applied in double before truncation as stable does.
// Other constant rates (lazer speed_change, 0.5-2) use the same map-time scaling; hit 'hr' / 'ez' divides / multiplies by 1.4
// before the rate (stable order). OD up to 11 is accepted for lazer Difficulty Adjust with extended limits.
export const RATES = [1, 0.75, 1.5];
export const RATE_MIN = 0.5, RATE_MAX = 2;
export function checkJudge(od, rate, hit) {
  if (!Number.isFinite(od) || od < 0 || od > 11) throw new Error('OD must be finite and between 0 and 11');
  if (!Number.isFinite(rate) || rate < RATE_MIN || rate > RATE_MAX) throw new Error(`rate must be between ${RATE_MIN} and ${RATE_MAX}`);
  if (hit !== '' && hit !== 'hr' && hit !== 'ez') throw new Error("hit must be '', 'hr' or 'ez'");
}
function scaleWindow(v, rate, hit) {
  if (hit === 'hr') v /= 1.4; else if (hit === 'ez') v *= 1.4;
  return v * rate;
}
export function v1Windows(od, rate = 1, hit = '') {
  checkJudge(od, rate, hit);
  const diff = f32(10 - f32(od));
  return [16, ...[34, 67, 97, 121, 158].map(b => f32(b + f32(3 * diff)))].map(v => Math.trunc(scaleWindow(v, rate, hit)));
}

// osu_diff.stable_scorev2.hit_windows(od, SCORE_V2 | mod bit): float32 OD, double arithmetic, the earliest window unscaled
export function v2Windows(od, rate = 1, hit = '') {
  checkJudge(od, rate, hit);
  const d = f32(od);
  return V2_RANGES.map(([lo, mid, hi], i) => {
    let v = d > 5 ? mid + (hi - mid) * (d - 5) / 5 : d < 5 ? mid - (mid - lo) * (5 - d) / 5 : mid;
    if (i < 5) v = scaleWindow(v, rate, hit);
    return Math.trunc(v);
  });
}

export class Reader {
  constructor(R, table, session, ort) {
    this.R = R; this.tab = table; this.sess = session; this.ort = ort;
    this.G = 8193; this.P = R.theta_grid.length;
    this.nu = Float32Array.from(R.t_nus_f32);
    this.logc = Float32Array.from(R.t_logc.map(f32));
    this.gs = R.group_scale.map(f32);
    this.terms = {};
    for (const k of ['ls0', 'ls1', 'mu0', 'mu1', 'lg0', 'lg1']) this.terms[k] = Float64Array.from(R.terms[k].flat());
    this.dw = [0, f32(V1_W[1] - V1_W[2]), f32(V1_W[2] - V1_W[3]), f32(V1_W[3] - V1_W[4]), f32(V1_W[4])];
    this.dw2 = V2_W.map((v, g) => f32(g < 4 ? v - V2_W[g + 1] : v));
    this.lnSpecs = [[1.1, 2.2, V1_W[1] - V1_W[2]], [1, 2, V1_W[2] - V1_W[3]], [1, 2, V1_W[3] - V1_W[4]]];
  }

  cdf(z, q) {
    const u = f32(z / f32(Math.abs(z) + 4));
    let pos = f32(f32(u + 1) * 4096);
    if (pos < 0) pos = 0; else if (pos > 8192) pos = 8192;
    let i0 = Math.floor(pos); if (i0 > 8191) i0 = 8191;
    const fr = f32(pos - i0);
    const b = q * this.G + i0;
    const v0 = this.tab[b], v1 = this.tab[b + 1];
    return f32(v0 + f32(f32(v1 - v0) * fr));
  }

  pdf(z, q) {
    const nu = this.nu[q];
    return f32(Math.exp(f32(this.logc[q] - f32(f32(0.5 * f32(nu + 1)) * f32(Math.log1p(f32(f32(z * z) / nu)))))));
  }

  pint(lo, hi, mu, sig, q) {
    const d = f32(this.cdf(f32(f32(hi - mu) / sig), q) - this.cdf(f32(f32(lo - mu) / sig), q));
    return d > 0 ? d : 0;
  }

  headScore(mu, sig, q, W) {   // W: 5 windows (+0.5) float32
    let s = 0;
    for (let g = 1; g < 5; g++) s = f32(s + f32(this.dw[g] * this.pint(-W[g], W[g], mu, sig, q)));
    return s;
  }

  headScoreV2(mu, sig, q, W) {   // rules.head_score with V2_W (the MAX window counts)
    let s = 0;
    for (let g = 0; g < 5; g++) s = f32(s + f32(this.dw2[g] * this.pint(-W[g], W[g], mu, sig, q)));
    return s;
  }

  // rules.v2_tail_score constants (integer V2 windows w[6])
  v2TailConstants(w) {
    const eps = f32(1e-6);
    const Tg = w.slice(0, 5).map(x => f32(Math.floor(f32(f32(1.5 * x) + eps)) + 0.5));
    return { Tg, w4e: f32(w[4] + 0.5), L3: f32(Math.ceil(f32(f32(1.5 * w[3]) - eps)) - 0.5), v4: f32(V2_W[4]) };
  }

  v2Tail(mu, sig, q, C) {   // rules.v2_tail_score -> [score, score if the head was missed]
    let s = 0;
    for (let g = 0; g < 5; g++) {
      s = f32(s + f32(this.dw2[g] * this.pint(-Math.min(C.Tg[g], C.w4e), Math.min(C.Tg[g], C.L3), mu, sig, q)));
    }
    s = f32(s + f32(C.v4 * this.pint(-C.Tg[4], -C.w4e, mu, sig, q)));
    return [s, f32(C.v4 * this.pint(-C.Tg[4], C.L3, mu, sig, q))];
  }

  // mu, sigma, miss probability of action a for profile p (same arithmetic as secondLayerRange)
  msp(l, comp, a, p, rate) {
    const T = this.terms, ci = comp[a], k = p * 2 + ci;
    const lk = ci ? l[a * 2 + 1] : l[a * 2];
    let ls = T.ls0[k] + T.ls1[k] * lk;
    if (ls < -5) ls = -5; else if (ls > 8) ls = 8;
    let sig = f32(Math.exp(ls)), mu = f32(T.mu0[k] + T.mu1[k] * lk);
    if (rate !== 1) { sig = f32(sig * rate); mu = f32(mu * rate); }
    return [mu, sig, f32(1 / (1 + Math.exp(-(T.lg0[k] + T.lg1[k] * lk))))];
  }

  // ScoreV2 scores of the long-note heads and tails of one orientation, added (x 0.5) into V[p * 2L + j] (j < L heads, then
  // tails): ps_engine.per_action v2 restricted to the LN actions
  lnV2Accumulate(l, comp, lnH, lnT, od, rate, V, hit = '') {
    const L = lnH.length;
    const w = v2Windows(od, rate, hit);
    const W = w.slice(0, 5).map(v => f32(v + 0.5));
    const C = this.v2TailConstants(w);
    for (let p = 0; p < this.P; p++) {
      for (let j = 0; j < L; j++) {
        const [muH, sigH, piH] = this.msp(l, comp, lnH[j], p, rate);
        const [muT, sigT, piT] = this.msp(l, comp, lnT[j], p, rate);
        const [st, cap] = this.v2Tail(muT, sigT, p * 2 + 1, C);
        V[p * 2 * L + j] += 0.5 * f32(this.headScoreV2(muH, sigH, p * 2, W) * f32(1 - piH));
        V[p * 2 * L + L + j] += 0.5 * f32(f32(1 - piT) * f32(f32(f32(1 - piH) * st) + f32(piH * cap)));
      }
    }
  }

  // ScoreV2 head scores of the taps (not LN heads, not releases) of one orientation, summed per level into V[p] (x 0.5):
  // ps_engine.per_action v2 restricted to the taps; with lnV2 this gives the whole-chart acc_v2 (LN line, 97 % ScoreV2)
  tapV2Accumulate(l, comp, head, od, rate, V, hit = '') {
    const w = v2Windows(od, rate, hit);
    const W = w.slice(0, 5).map(v => f32(v + 0.5));
    const A = comp.length;
    for (let p = 0; p < this.P; p++) {
      let s = 0;
      for (let a = 0; a < A; a++) {
        if (comp[a] || head[a]) continue;
        const [mu, sig, pi] = this.msp(l, comp, a, p, rate);
        s += 0.5 * f32(this.headScoreV2(mu, sig, p * 2, W) * f32(1 - pi));
      }
      V[p] += s;
    }
  }

  // chart constants of rules.v1_ln_score (they depend only on the OD windows)
  lnConstants(w) {
    const c = { w4e: f32(w[4] + 0.5), A: new Float64Array(3), B: new Float64Array(3), U: new Float64Array(3), dw: new Float64Array(3) };
    const wins = [w[1], w[2], w[3]];
    for (let k = 0; k < 3; k++) {
      const [fa, fb, dwv] = this.lnSpecs[k];
      c.A[k] = f32(Math.floor(f32(f32(f32(fa) * wins[k]) + f32(1e-6))) + 0.5);
      c.B[k] = f32(Math.floor(f32(f32(f32(fb) * wins[k]) + f32(1e-6))) + 0.5);
      c.U[k] = Math.min(c.A[k], c.B[k]);
      c.dw[k] = f32(dwv);
    }
    c.v14 = f32(V1_W[4]);
    return c;
  }

  lnScore(muH, sigH, qH, muT, sigT, qT, C) {   // rules.v1_ln_score
    const w4e = C.w4e;
    const fullRaw = f32(1 - this.cdf(f32(f32(-w4e - muT) / sigT), qT));
    const nm = Math.min(Math.max(fullRaw, 0), 1);
    let out = f32(C.v14 * nm);
    const full = fullRaw > 0 ? fullRaw : 0;
    const m0 = f32(Math.abs(muH) + f32(4 * sigH));
    for (let k = 0; k < 3; k++) {
      const B = C.B[k], U = C.U[k];
      const m = Math.min(m0, U);
      let tot = 0;
      for (let half_i = 0; half_i < 2; half_i++) {
        const a0 = half_i ? m : 0, a1 = half_i ? U : m;
        const half = f32(0.5 * f32(a1 - a0));
        const mid = f32(a0 + half);
        let acc = 0;
        for (let i = 0; i < 16; i++) {
          const h = f32(mid + f32(half * GX[i]));
          const fh = f32(f32(this.pdf(f32(f32(h - muH) / sigH), qH) + this.pdf(f32(f32(-h - muH) / sigH), qH)) / sigH);
          const s = f32(B - h);
          let G;
          if (s >= w4e) G = full;
          else {
            const ins = f32(this.cdf(f32(f32(s - muT) / sigT), qT) - this.cdf(f32(f32(-s - muT) / sigT), qT));
            G = ins > 0 ? ins : 0;
          }
          acc += f32(f32(fh * G) * GW[i]);
        }
        tot = f32(tot + f32(f32(acc) * half));
      }
      out = f32(out + f32(C.dw[k] * tot));
    }
    return out;
  }

  // standardised tokens [A*17] f32 for one orientation -> l [A][2] (divided by the group scale)
  async encode(xs, A, onProgress, progBase, progSpan) {
    const { window: WIN, core: CORE, halo: HALO } = this.R;
    const la = this.R.lookahead;
    const nW = Math.ceil(A / CORE);
    const l = new Float32Array(A * 2);
    const CH = 16;
    for (let w0 = 0; w0 < nW; w0 += CH) {
      const nw = Math.min(CH, nW - w0);
      const xw = new Float32Array(nw * WIN * 17);
      const valid = new Uint8Array(nw * WIN);
      const m1 = new Uint8Array(nw * WIN * WIN), m2 = new Uint8Array(nw * WIN * WIN);
      const tm = new Float64Array(WIN);
      for (let w = 0; w < nw; w++) {
        const start = (w0 + w) * CORE - HALO;
        let cum = 0;
        for (let p = 0; p < WIN; p++) {
          const sl = start + p;
          const ok = sl >= 0 && sl < A;
          valid[w * WIN + p] = ok ? 1 : 0;
          if (ok) {
            xw.set(xs.subarray(sl * 17, sl * 17 + 17), (w * WIN + p) * 17);
            cum += Math.expm1(xs[sl * 17 + la.gap_dim] * la.scale16 + la.mean16) * 1000;
          }
          tm[p] = cum;
        }
        const L1 = la.per_layer[0] + la.tol_ms, L2 = la.per_layer[1] + la.tol_ms;
        for (let i = 0; i < WIN; i++) {
          const vi = valid[w * WIN + i];
          const o = (w * WIN + i) * WIN;
          for (let j = 0; j < WIN; j++) {
            if (!valid[w * WIN + j]) continue;
            if (!vi) { m1[o + j] = 1; m2[o + j] = 1; continue; }
            const dt = tm[j] - tm[i];
            if (dt <= L1) m1[o + j] = 1;
            if (dt <= L2) m2[o + j] = 1;
          }
        }
      }
      const T = this.ort.Tensor;
      const res = await this.sess.run({
        xw: new T('float32', xw, [nw, WIN, 17]), valid: new T('bool', valid, [nw, WIN]),
        m1: new T('bool', m1, [nw, 1, WIN, WIN]), m2: new T('bool', m2, [nw, 1, WIN, WIN]),
      });
      const out = res.l.data;
      for (let w = 0; w < nw; w++) {
        const a0 = (w0 + w) * CORE;
        const a1 = Math.min(a0 + CORE, A);
        for (let a = a0; a < a1; a++) {
          const p = HALO + (a - a0);
          const o = (w * WIN + p) * 2;
          l[a * 2] = f32(out[o] / this.gs[0]);
          l[a * 2 + 1] = f32(out[o + 1] / this.gs[1]);
        }
      }
      if (onProgress) onProgress(progBase + progSpan * Math.min(1, (w0 + nw) / nW));
    }
    return l;
  }

  // per-action v1 scores (float32) for profiles p0..p1-1 of one orientation: S[(p-p0)*A + a].
  // rate != 1 (analysis/web-rate-r1, = dt-crowd r1 ps_rate): scored in map time, mu and sigma x rate against the mod windows
  // cal (key-pattern items, pattern-items.js calibInputs): arm C of research pattern-items r1 pi_engine.PIEngine.second, the
  // jack-calib term (per profile) and the burst-trill-calib arm L term added to the log-scale and miss logit of presses
  // dbg (tests only): { sig, pi } Float32Arrays [(p1 - p0) * A] receive the per-action sigma and miss probability
  secondLayerRange(l, comp, lnH, lnT, od, p0, p1, rate = 1, hit = '', cal = null, dbg = null) {
    const A = comp.length, T = this.terms;
    const w = v1Windows(od, rate, hit);
    const W = w.slice(0, 5).map(v => f32(v + 0.5));
    const LC = this.lnConstants(w);
    const isLnHead = new Uint8Array(A);
    for (const h of lnH) isLnHead[h] = 1;
    const mu = new Float32Array(A), sig = new Float32Array(A), pi = new Float32Array(A);
    const S = new Float32Array((p1 - p0) * A);
    for (let p = p0; p < p1; p++) {
      for (let a = 0; a < A; a++) {
        const ci = comp[a];
        const k = p * 2 + ci;
        const lk = ci ? l[a * 2 + 1] : l[a * 2];
        let ls = T.ls0[k] + T.ls1[k] * lk;
        if (cal) {
          let lg = T.lg0[k] + T.lg1[k] * lk;
          if (!ci) {
            const J = cal.J, g = cal.jg[a];
            const kk = (1 / (1 + Math.exp(-(((J[0] + J[1] * this.R.theta_grid[p]) - g) / J[2])))) * (g < J[11] ? 1 : 0);
            ls = ls + kk * (((J[3] + J[4] * cal.jr[a]) + J[5] * cal.jc[a]) + J[6] * cal.jl[a]);
            lg = lg + kk * (((J[7] + J[8] * cal.jr[a]) + J[9] * cal.jc[a]) + J[10] * cal.jl[a]);
            ls = ls + cal.dsb[a];
            lg = lg + cal.dpb[a];
          }
          if (ls < -5) ls = -5; else if (ls > 8) ls = 8;
          sig[a] = f32(Math.exp(ls));
          mu[a] = f32(T.mu0[k] + T.mu1[k] * lk);
          pi[a] = f32(1 / (1 + Math.exp(-lg)));
          continue;
        }
        if (ls < -5) ls = -5; else if (ls > 8) ls = 8;
        sig[a] = f32(Math.exp(ls));
        mu[a] = f32(T.mu0[k] + T.mu1[k] * lk);
        if (rate !== 1) { sig[a] = f32(sig[a] * rate); mu[a] = f32(mu[a] * rate); }
        pi[a] = f32(1 / (1 + Math.exp(-(T.lg0[k] + T.lg1[k] * lk))));
      }
      const row = (p - p0) * A;
      if (dbg) { dbg.sig.set(sig, row); dbg.pi.set(pi, row); }
      for (let a = 0; a < A; a++) {
        if (comp[a] || isLnHead[a]) continue;
        S[row + a] = f32(this.headScore(mu[a], sig[a], p * 2, W) * f32(1 - pi[a]));
      }
      for (let j = 0; j < lnH.length; j++) {
        const h = lnH[j], t = lnT[j];
        const sl = this.lnScore(mu[h], sig[h], p * 2, mu[t], sig[t], p * 2 + 1, LC);
        S[row + h] = f32(f32(f32(1 - pi[h]) * f32(1 - pi[t])) * sl);
      }
    }
    return S;
  }

  static accumulate(v1a, S, p0, A) {
    const o = p0 * A;
    for (let i = 0; i < S.length; i++) v1a[o + i] += 0.5 * S[i];
  }

  // all profiles of one orientation, locally or split over a helper pool (pool.run(l, comp, lnH, lnT, od, p0, p1, rate, hit, cal) -> S)
  async secondLayer(l, tk, od, v1a, pool, rate = 1, hit = '', cal = null) {
    const A = tk.nActions, P = this.P;
    if (!pool || !pool.size) {
      Reader.accumulate(v1a, this.secondLayerRange(l, tk.comp, tk.lnH, tk.lnT, od, 0, P, rate, hit, cal), 0, A);
      return;
    }
    const k = Math.min(pool.size, P);
    const parts = [];
    for (let i = 0; i < k; i++) {
      const p0 = Math.floor(i * P / k), p1 = Math.floor((i + 1) * P / k);
      parts.push(pool.run(l, tk.comp, tk.lnH, tk.lnT, od, p0, p1, rate, hit, cal).then(S => ({ S, p0 })));
    }
    for (const { S, p0 } of await Promise.all(parts)) Reader.accumulate(v1a, S, p0, A);
  }

  async perAction(tk, od, onProgress, pool = null, rate = 1, withLn = true, hit = '') {
    const A = tk.nActions;
    const { token_mean: mt, token_scale: st } = this.R;
    const xs = new Float32Array(A * 17);
    for (let a = 0; a < A; a++) for (let d = 0; d < 17; d++) xs[a * 17 + d] = f32((tk.tokens[a * 17 + d] - mt[d]) / st[d]);
    const xm = xs.slice();
    for (let a = 0; a < A; a++) {
      const b = a * 17 + 10;
      const c0 = xm[b], c1 = xm[b + 1];
      xm[b] = xm[b + 3]; xm[b + 1] = xm[b + 2]; xm[b + 2] = c1; xm[b + 3] = c0;
    }
    const v1a = new Float64Array(this.P * A);
    const lnV2 = new Float64Array(withLn ? this.P * 2 * tk.lnH.length : 0);   // ScoreV2 of LN heads / tails (rice-ln-od r1, face item)
    const tapV2 = new Float64Array(withLn ? this.P : 0);                       // ScoreV2 of the taps, summed per level (LN line)
    const head = new Uint8Array(A);
    for (const x of tk.lnH) head[x] = 1;
    const ls = [];
    const prog = onProgress || (() => {});
    if (pool && pool.size) {
      // overlap: helpers score orientation 0 while the encoder runs orientation 1
      const l0 = await this.encode(xs, A, prog, 0, 30);
      const s0 = this.secondLayer(l0, tk, od, v1a, pool, rate, hit);
      if (withLn) { this.lnV2Accumulate(l0, tk.comp, tk.lnH, tk.lnT, od, rate, lnV2, hit); this.tapV2Accumulate(l0, tk.comp, head, od, rate, tapV2, hit); }
      const l1 = await this.encode(xm, A, prog, 30, 30);
      await s0; prog(75);
      const s1 = this.secondLayer(l1, tk, od, v1a, pool, rate, hit);
      if (withLn) { this.lnV2Accumulate(l1, tk.comp, tk.lnH, tk.lnT, od, rate, lnV2, hit); this.tapV2Accumulate(l1, tk.comp, head, od, rate, tapV2, hit); }
      await s1; prog(95);
      ls.push(l0, l1);
    } else {
      for (let mirror = 0; mirror < 2; mirror++) {
        const l = await this.encode(mirror ? xm : xs, A, prog, mirror * 45, 40);
        await this.secondLayer(l, tk, od, v1a, null, rate, hit);
        if (withLn) { this.lnV2Accumulate(l, tk.comp, tk.lnH, tk.lnT, od, rate, lnV2, hit); this.tapV2Accumulate(l, tk.comp, head, od, rate, tapV2, hit); }
        ls.push(l);
        prog(mirror * 45 + 45);
      }
    }
    const acc = new Float64Array(this.P);
    for (let p = 0; p < this.P; p++) {
      let s = 0;
      for (let a = 0; a < A; a++) s += v1a[p * A + a];
      acc[p] = s / tk.nNotes;
    }
    return { acc, v1a, lnV2, tapV2, ls };
  }

  // whole-chart ScoreV1 accuracy curve re-judged at another OD, reusing the encoder outputs ls (OD only enters the windows)
  async accAtOd(ls, tk, od, pool = null, rate = 1, hit = '') {
    const A = tk.nActions;
    const v = new Float64Array(this.P * A);
    for (const l of ls) await this.secondLayer(l, tk, od, v, pool && pool.size ? pool : null, rate, hit);
    const acc = new Float64Array(this.P);
    for (let p = 0; p < this.P; p++) {
      let s = 0;
      for (let a = 0; a < A; a++) s += v[p * A + a];
      acc[p] = s / tk.nNotes;
    }
    return acc;
  }

  // anchor.theta_star_grid + ps_readout.thetas (rule v1 at 96 % by default; the face item passes the v2 line 0.97)
  theta(acc, thr = this.R.threshold_v1) {
    const grid = this.R.theta_grid, P = grid.length;
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
      const [lo, hi] = this.R.theta_flag_range;
      if (t < lo) flag = 'extrap_low'; else if (t > hi) flag = 'extrap_high';
    }
    return { theta: t, flag };
  }

  // ps_readout.segment_table (v1 part): 10 s windows, 5 s step, theta* per window on the frozen public-star scale
  segments(v1a, tk) {
    const A = tk.nActions, P = this.P, t = tk.times;
    let t0 = Infinity, t1 = -Infinity;
    for (let a = 0; a < A; a++) { if (t[a] < t0) t0 = t[a]; if (t[a] > t1) t1 = t[a]; }
    const wins = [];
    if (t1 - t0 <= 10000) wins.push([t0, t1, true]);
    else { let s = t0; while (s < t1 - 10000) { wins.push([s, s + 10000, false]); s += 5000; } wins.push([t1 - 10000, t1, true]); }
    const sc = this.R.public_star_scale;
    const out = [];
    for (const [s, e, closed] of wins) {
      const acc = new Float64Array(P);
      let nh = 0;
      for (let a = 0; a < A; a++) {
        if (tk.comp[a] || t[a] < s || (closed ? t[a] > e : t[a] >= e)) continue;
        nh++;
        for (let p = 0; p < P; p++) acc[p] += v1a[p * A + a];
      }
      let star = null;
      if (nh) { for (let p = 0; p < P; p++) acc[p] /= nh; star = sc.a + sc.b * this.theta(acc).theta; }
      out.push({ startS: s / 1000, endS: e / 1000, star, nObj: nh, sparse: nh < 8 });
    }
    return out;
  }
}
