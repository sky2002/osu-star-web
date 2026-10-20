// Key-pattern items, beta (route A, arm C2): jack / speed / trill (tA) stars, loss shares and the tech tag.
// Research repository docs/pattern-items-route-a-final-2026-10-19.md; Python reference analysis/web-items-r1/wi_ref.py
// (= pattern-items ext1: r1 PIEngine arm C, r5 p5_classify, r5 reduce_chart, r3 readouts with the C2 calibration, r5
// overlay readouts). Every step below mirrors the reference arithmetic, including NumPy / PyTorch summation orders.
// NoMod 1.0x with the file OD only; the total star is never changed.
import { rint, ssLeft, ssRight, quantile, median } from './pyutil.js';

// ------------------------------------------------------------------ chart-only classes (p5_classify.classify, r3main)
const LN_MIN_MS = 94, LN_END_MS = 42, JACK_MS = 200, FAST_MS = 125, TRILL_MIN = 45, TRILL_MAX = 200;
const EVEN_RATIO = 1.5, MIN_STEPS = 3;
const IOI_MIN = 25, IOI_MAX = 400, FRAC_TOL = 0.1, RW = 4, MIN_IRR = 2;
export const N_PIECES = 9;   // 1..7 head classes (2 = kashou tap), 8 = kashou LN

function uniqueSorted(v) {
  const s = Float64Array.from(v).sort();
  const out = [];
  for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) out.push(s[i]);
  return Float64Array.from(out);
}

// per hand: own press rows, column code e (1 / 2 single, 3 both), times, other-hand press times
function handRows(ut, mask, h) {
  const rows = [], oth = [];
  for (let r = 0; r < ut.length; r++) {
    if (((mask[r] >> (2 * h)) & 3) > 0) rows.push(r);
    if (((mask[r] >> (2 * (1 - h))) & 3) > 0) oth.push(ut[r]);
  }
  const n = rows.length, e = new Int32Array(n), te = new Float64Array(n);
  for (let k = 0; k < n; k++) { e[k] = (mask[rows[k]] >> (2 * h)) & 3; te[k] = ut[rows[k]]; }
  return { rows, n, e, te, o: Float64Array.from(oth) };
}

const single = x => x === 1 || x === 2;

// r1 _hand_runs: pos > 0 = trill attribute
function r1TrillPos(H) {
  const { n, e, te } = H;
  const step = new Uint8Array(n), pos = new Int32Array(n);
  for (let k = 1; k < n; k++) {
    const gap = te[k] - te[k - 1];
    step[k] = single(e[k]) && single(e[k - 1]) && e[k] !== e[k - 1] && gap <= TRILL_MAX && gap > TRILL_MIN ? 1 : 0;
  }
  let start = 0;
  for (let k = 0; k < n; k++) { if (!step[k]) start = k; pos[k] = step[k] ? k - start + 1 : 0; }
  for (let k = 0; k < n; k++) if (!step[k] && k + 1 < n && step[k + 1]) pos[k] = 1;
  return pos;
}

// chains of steps -> longest chain (steps) covering each own row (r3 trill_r3 loop / r4 _runs)
function chainSteps(step, gap, even) {
  const n = step.length, out = new Int32Array(n);
  let k = 1;
  while (k < n) {
    if (!step[k]) { k++; continue; }
    const a = k;
    k++;
    while (k < n && step[k]) {
      if (even) {
        const g0 = gap[k - 1], g1 = gap[k];
        if (Math.max(g0, g1) > EVEN_RATIO * Math.min(g0, g1)) break;
      }
      k++;
    }
    const m = k - a;
    for (let r = a - 1; r < k; r++) if (m > out[r]) out[r] = m;
  }
  return out;
}

// notes: [[start, end, col, hold], ...] (chart order, relative ms) -> per-note piece (r3main), overlays tA / rA
export function classifyNotes(notes) {
  const N = notes.length;
  const start = new Float64Array(N), end = new Float64Array(N), col = new Int32Array(N);
  const lnLong = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    start[i] = notes[i][0]; end[i] = notes[i][1]; col[i] = notes[i][2];
    const hold = notes[i][3] > 0 && end[i] > start[i];
    lnLong[i] = hold && end[i] - start[i] >= LN_MIN_MS ? 1 : 0;
  }
  // held_same: an LN >= 94 ms of the same hand's other column open at the press (start + 42 < t < end - 42)
  const heldSame = new Uint8Array(N);
  for (let k = 0; k < 4; k++) {
    const iv = [];
    for (let i = 0; i < N; i++) if (lnLong[i] && col[i] === k) iv.push([start[i] + LN_END_MS, end[i] - LN_END_MS, iv.length]);
    if (!iv.length) continue;
    iv.sort((x, y) => (x[0] - y[0]) || (x[2] - y[2]));
    const s = Float64Array.from(iv.map(x => x[0]));
    const emax = new Float64Array(iv.length);
    for (let j = 0; j < iv.length; j++) emax[j] = j ? Math.max(emax[j - 1], iv[j][1]) : iv[j][1];
    for (let i = 0; i < N; i++) {
      if ((col[i] >> 1) !== (k >> 1) || col[i] === k) continue;
      const j = ssLeft(s, start[i]) - 1;
      if (j >= 0 && start[i] < emax[j]) heldSame[i] = 1;
    }
  }
  // press rows
  const ut = uniqueSorted(start);
  const R = ut.length;
  const inv = new Int32Array(N);
  for (let i = 0; i < N; i++) inv[i] = ssLeft(ut, start[i]);
  const mask = new Int32Array(R);
  for (let i = 0; i < N; i++) mask[inv[i]] |= 1 << col[i];
  const jack = new Uint8Array(N), fast = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = inv[i];
    const gap = r ? ut[r] - ut[r - 1] : Infinity;
    jack[i] = r > 0 && (mask[r - 1] >> col[i]) & 1 && gap < JACK_MS ? 1 : 0;
    fast[i] = gap < FAST_MS ? 1 : 0;
  }
  const hands = [handRows(ut, mask, 0), handRows(ut, mask, 1)];
  const ev = hands.map(H => { const v = new Int32Array(R).fill(-1); H.rows.forEach((r, k) => { v[r] = k; }); return v; });
  // r1 trill attribute, r3 trill rule (closed interval: no other-hand press in [t_{i-1}, t_i]), r4 tA steps
  const trill = new Uint8Array(N), trillR3 = new Uint8Array(N), stepsTA = new Int32Array(N);
  for (let h = 0; h < 2; h++) {
    const H = hands[h];
    if (H.n < 2) continue;
    const pos = r1TrillPos(H);
    const { n, e, te, o } = H;
    const stepR3 = new Uint8Array(n), base = new Uint8Array(n), gap = new Float64Array(n).fill(NaN);
    for (let k = 1; k < n; k++) {
      gap[k] = te[k] - te[k - 1];
      const st = single(e[k]) && single(e[k - 1]) && e[k] !== e[k - 1] && gap[k] <= TRILL_MAX && gap[k] > TRILL_MIN;
      base[k] = st ? 1 : 0;
      const otherIn = ssRight(o, te[k]) - ssLeft(o, te[k - 1]) > 0;
      stepR3[k] = st && !otherIn ? 1 : 0;
    }
    const r3 = chainSteps(stepR3, null, false);
    const tA = chainSteps(base, gap, true);
    for (let i = 0; i < N; i++) {
      if ((col[i] >> 1) !== h) continue;
      const k = ev[h][inv[i]];
      trill[i] = pos[k] > 0 ? 1 : 0;
      trillR3[i] = r3[k] >= MIN_STEPS ? 1 : 0;
      stepsTA[i] = tA[k];
    }
  }
  // head class (r1 main: priority 2 kashou > 3 LN > 4 jack > 5 trill > 6 speed > 7 other), r3main, piece
  const piece = new Int8Array(N), headR3 = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    let c = 7;
    if (fast[i]) c = 6;
    if (trill[i]) c = 5;
    if (jack[i]) c = 4;
    if (lnLong[i]) c = 3;
    if (heldSame[i]) c = 2;
    if (c === 5 && !trillR3[i]) c = fast[i] ? 6 : 7;
    headR3[i] = c;
    piece[i] = c === 2 && lnLong[i] ? 8 : c;
  }
  // r5 rA (irregular rhythm) on the press rows
  const d = new Float64Array(R).fill(NaN);
  for (let r = 1; r < R; r++) d[r] = ut[r] - ut[r - 1];
  const ok = r => d[r] >= IOI_MIN && d[r] <= IOI_MAX;
  const irr = new Uint8Array(R);
  for (let r = 1; r + 1 < R; r++) {
    if (!(ok(r) && ok(r + 1))) continue;
    const a = d[r], b = d[r + 1];
    const q = Math.max(a, b) / Math.min(a, b);
    irr[r] = Math.abs(q - rint(q)) > FRAC_TOL ? 1 : 0;
  }
  const cs = new Int32Array(R + 1);
  for (let r = 0; r < R; r++) cs[r + 1] = cs[r] + irr[r];
  const rA = new Uint8Array(R);
  for (let r = 0; r < R; r++) rA[r] = cs[Math.min(R, r + RW + 1)] - cs[Math.max(0, r - RW)] >= MIN_IRR ? 1 : 0;
  const ovTA = new Uint8Array(N), ovRA = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = headR3[i];
    ovTA[i] = c >= 5 && c <= 7 && stepsTA[i] >= MIN_STEPS ? 1 : 0;
    ovRA[i] = c >= 4 && c <= 7 && rA[inv[i]] ? 1 : 0;
  }
  return { piece, headR3, ovTA, ovRA };
}

// ------------------------------------------------------------------ action columns from the raw token one-hots
// argmax (first maximum), as jc_catloss used for the jack features
export function argmaxCols(tokens, A) {
  const col = new Int32Array(A);
  for (let a = 0; a < A; a++) {
    const b = a * 17 + 10;
    let best = 0;
    for (let j = 1; j < 4; j++) if (tokens[b + j] > tokens[b + best]) best = j;
    col[a] = best;
  }
  return col;
}

// bc_common.fix_cols: argmax; a symmetric tie pair (adjacent slots averaged to 0.5 / 0.5) gets (c, 3 - c)
export function fixCols(tokens, A) {
  const col = argmaxCols(tokens, A);
  const amb = [];
  for (let a = 0; a < A; a++) {
    const b = a * 17 + 10;
    for (let j = 0; j < 4; j++) { const v = tokens[b + j]; if (v !== 0 && v !== 1) { amb.push(a); break; } }
  }
  if (amb.length % 2) throw new Error('ambiguous token columns are not adjacent pairs');
  for (let k = 0; k < amb.length; k += 2) {
    if (amb[k + 1] !== amb[k] + 1) throw new Error('ambiguous token columns are not adjacent pairs');
    col[amb[k + 1]] = 3 - col[amb[k]];
  }
  return col;
}

// ------------------------------------------------------------------ jack-calib features (jc_common.jack_features, one chart)
export function jackFeatures(times, comp, col) {
  const A = times.length;
  const o = Array.from({ length: A }, (_, i) => i);
  // lexsort((1 - comp, t, col)): by column, time, release before press at equal time, then index
  o.sort((x, y) => (col[x] - col[y]) || (times[x] - times[y]) || ((1 - comp[x]) - (1 - comp[y])) || (x - y));
  const g = new Float64Array(A), r = new Float64Array(A), lnh = new Float64Array(A), chord = new Float64Array(A);
  const gs = new Float64Array(A), same = new Uint8Array(A);
  for (let j = 0; j < A; j++) {
    same[j] = j > 0 && col[o[j]] === col[o[j - 1]] ? 1 : 0;
    gs[j] = same[j] ? times[o[j]] - times[o[j - 1]] : Infinity;
  }
  for (let j = 0; j < A; j++) {
    const a = o[j];
    const prevComp = j > 0 ? comp[o[j - 1]] : -1, prevG = j > 0 ? gs[j - 1] : Infinity;
    const rs = same[j] && prevComp === 0 && prevG < 200;
    const lnhs = comp[a] === 0 && j + 1 < A && same[j + 1] && comp[o[j + 1]] === 1;
    const press = comp[a] === 0;
    g[a] = press ? Math.fround(gs[j]) : Infinity;
    r[a] = press && rs ? 1 : 0;
    lnh[a] = press && lnhs ? 1 : 0;
  }
  // chord: >= 2 presses at the same rounded ms
  const cnt = new Map();
  for (let a = 0; a < A; a++) if (comp[a] === 0) { const k = rint(times[a]); cnt.set(k, (cnt.get(k) || 0) + 1); }
  for (let a = 0; a < A; a++) if (comp[a] === 0 && cnt.get(rint(times[a])) >= 2) chord[a] = 1;
  return { g, r, chord, lnh };
}

// ------------------------------------------------------------------ burst-trill-calib features (bc_common.features, arm L)
const BC_TRILL_MAX = 200, BC_TRILL_MIN = 45, BC_FAST_MS = 90;

function burstSegments(th) {
  const t0 = th[0], t1 = th[th.length - 1];
  const n = Math.max(0, Math.ceil((t1 + 1 - t0) / 100));
  const g = new Float64Array(n), dens = new Float64Array(n);
  const dl = (t0 + 100) - t0;                                   // numpy.arange fill: start + i * (x1 - x0)
  for (let i = 0; i < n; i++) {
    g[i] = i === 0 ? t0 : i === 1 ? t0 + 100 : t0 + i * dl;
    dens[i] = (ssLeft(th, g[i] + 1000) - ssLeft(th, g[i] - 1000)) / 2;
  }
  const p90 = quantile(dens, 0.9), med = median(dens);
  if (!(p90 > 0)) return [];
  const segs = [];
  let s = -1, e = -1;
  for (let k = 0; k < n; k++) {
    if (!(dens[k] >= p90 && dens[k] >= 1.5 * med)) continue;
    if (s < 0) { s = e = k; continue; }
    if ((k - e) * 100 < 500) e = k;
    else { segs.push([g[s], g[e] + 100]); s = e = k; }
  }
  if (s >= 0) segs.push([g[s], g[e] + 100]);
  return segs.filter(([a, b]) => b - a >= 1000);
}

// -> per-action dlogscale / dlogit of the burst term (0 on releases); torch (X * p).sum(-1) order: ((((x0 + x4) + x1) + x2) + x3)
export function burstDeltas(times, comp, col, raw) {
  const A = times.length;
  const hi = [];
  for (let a = 0; a < A; a++) if (comp[a] === 0) hi.push(a);
  const H = hi.length;
  const tp = new Float64Array(H);
  for (let k = 0; k < H; k++) tp[k] = times[hi[k]];
  const th = Float64Array.from(tp).sort();
  const segs = burstSegments(th);
  const inb = new Float64Array(A), ph = new Float64Array(A), rec = new Float64Array(A), u = new Float64Array(A), fast = new Float64Array(A);
  for (let k = 0; k < H; k++) {
    const t = tp[k];
    let ib = false, p = 0, rc = false;
    for (const [a, b] of segs) if (t >= a && t < b) { ib = true; p = Math.min(t - a, 3000) / 3000; }
    for (const [, b] of segs) if (t >= b && t < b + 1000) rc = true;
    inb[hi[k]] = ib ? 1 : 0; ph[hi[k]] = p; rec[hi[k]] = rc && !ib ? 1 : 0;
  }
  const ut = uniqueSorted(tp);
  const inv = new Int32Array(H);
  for (let k = 0; k < H; k++) inv[k] = ssLeft(ut, tp[k]);
  const mask = new Int32Array(ut.length);
  for (let k = 0; k < H; k++) mask[inv[k]] |= 1 << col[hi[k]];
  for (let h = 0; h < 2; h++) {
    const Hr = handRows(ut, mask, h);
    const { n, e, te } = Hr;
    const step = new Uint8Array(n), gap = new Float64Array(n).fill(NaN), pos = new Int32Array(n);
    for (let k = 1; k < n; k++) {
      gap[k] = te[k] - te[k - 1];
      step[k] = single(e[k]) && single(e[k - 1]) && e[k] !== e[k - 1] && gap[k] <= BC_TRILL_MAX && gap[k] > BC_TRILL_MIN ? 1 : 0;
    }
    let start = 0;
    for (let k = 0; k < n; k++) { if (!step[k]) start = k; pos[k] = step[k] ? k - start + 1 : 0; }
    for (let k = 0; k < n; k++) if (!step[k] && k + 1 < n && step[k + 1]) pos[k] = 1;
    const ev = new Int32Array(ut.length).fill(-1);
    Hr.rows.forEach((r, i) => { ev[r] = i; });
    for (let k = 0; k < H; k++) {
      if ((col[hi[k]] >> 1) !== h) continue;
      const j = ev[inv[k]];
      u[hi[k]] = Math.min(Math.max((pos[j] - 3) / 5, 0), 1);
      fast[hi[k]] = step[j] && gap[j] < BC_FAST_MS ? 1 : 0;
    }
  }
  const ds = new Float64Array(A), dp = new Float64Array(A);
  for (let a = 0; a < A; a++) {
    if (comp[a]) continue;
    const x = [inb[a], inb[a] * ph[a], rec[a], u[a], u[a] * fast[a]];
    const ys = x.map((v, j) => v * raw[j]), yp = x.map((v, j) => v * raw[5 + j]);
    ds[a] = (((ys[0] + ys[4]) + ys[1]) + ys[2]) + ys[3];
    dp[a] = (((yp[0] + yp[4]) + yp[1]) + yp[2]) + yp[3];
  }
  return { ds, dp, nBurstSegs: segs.length };
}

// calibration inputs of the second layer (Reader.secondLayerRange `cal`)
export function calibInputs(tk, PI) {
  const A = tk.nActions;
  const jf = jackFeatures(tk.times, tk.comp, argmaxCols(tk.tokens, A));
  const bd = burstDeltas(tk.times, tk.comp, fixCols(tk.tokens, A), PI.burst.raw);
  const J = PI.jack;
  return { jg: jf.g, jr: jf.r, jc: jf.chord, jl: jf.lnh, dsb: bd.ds, dpb: bd.dp,
    J: [J.tau0, J.tau1, J.w, J.a_s, J.b_s, J.c_s, J.d_s, J.a_p, J.b_p, J.c_p, J.d_p, J.cut_ms] };
}

// ------------------------------------------------------------------ NumPy reductions
// numpy pairwise summation (float64, contiguous), as np.sum along a C-contiguous row
export function pairwiseSum(a, o, n) {
  if (n < 8) {
    let res = -0.0;
    for (let i = 0; i < n; i++) res += a[o + i];
    return res;
  }
  if (n <= 128) {
    const r = [a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o + 6], a[o + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[o + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[o + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, o, n2) + pairwiseSum(a, o + n2, n - n2);
}

// numpy.interp (scalar x, increasing xp)
export function npInterp(x, xp, fp) {
  const n = xp.length;
  if (Number.isNaN(x)) return x;
  if (x < xp[0]) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  let j = ssRight(xp, x) - 1;            // xp[j] <= x < xp[j + 1]
  if (j >= n - 1) return fp[n - 1];
  if (xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  return slope * (x - xp[j]) + fp[j];
}

// pi_common.interp_grid
function interpGrid(arr, theta, G) {
  const th = Math.min(Math.max(theta, G[0]), G[G.length - 1]);
  const k = ssRight(G, th);
  if (k >= G.length) return arr[G.length - 1];
  if (k === 0) return arr[0];
  const w = (th - G[k - 1]) / (G[k] - G[k - 1]);
  return (1 - w) * arr[k - 1] + w * arr[k];
}

// ------------------------------------------------------------------ readouts (r3 readouts, r5 overlay_readouts, ext1 star)
const ITEM_PIECES = { jack: [4], speed: [6], ln: [3], kashou: [2, 8], trill: [5], other: [7] };

// v1a: arm U per-action v1 [P * A]; v1c: arm C [P * A]; reader: theta(acc, thr) and the grid; notes in chart order
export function itemReadouts({ PI, reader, tk, cls, v1a, v1c, star }) {
  const P = reader.P, A = tk.nActions, N = tk.nNotes, G = PI.grid;
  const headAct = new Int32Array(N);
  for (let a = 0; a < A; a++) if (tk.comp[a] === 0) headAct[tk.noteOf[a]] = a;
  // arm U theta*_all on the pairwise row sums (reference acc_U), slope k(theta*_all,U)
  const accU = new Float64Array(P), v1sC = new Float64Array(P);
  for (let p = 0; p < P; p++) { accU[p] = pairwiseSum(v1a, p * A, A) / N; v1sC[p] = pairwiseSum(v1c, p * A, A); }
  const tU = reader.theta(accU);
  const kMain = npInterp(tU.theta, PI.kslope.centres_theta, PI.kslope.slopes);
  // piece and overlay score sums over the objects (head actions), sequential in note order
  const Ps = Array.from({ length: N_PIECES }, () => new Float64Array(P).fill(-0.0));
  const npc = new Float64Array(N_PIECES);
  const Po = { tA: new Float64Array(P).fill(-0.0), rA: new Float64Array(P).fill(-0.0) };
  const nov = { tA: 0, rA: 0 };
  for (let i = 0; i < N; i++) {
    const pc = cls.piece[i], a = headAct[i];
    npc[pc]++;
    for (let p = 0; p < P; p++) Ps[pc][p] += v1c[p * A + a];
    if (cls.ovTA[i]) { nov.tA++; for (let p = 0; p < P; p++) Po.tA[p] += v1c[p * A + a]; }
    if (cls.ovRA[i]) { nov.rA++; for (let p = 0; p < P; p++) Po.rA[p] += v1c[p * A + a]; }
  }
  for (let pc = 0; pc < N_PIECES; pc++) if (!npc[pc]) Ps[pc].fill(0);
  if (!nov.tA) Po.tA.fill(0);
  if (!nov.rA) Po.rA.fill(0);
  // C2: S' = max(0, S - (c - 1) * (n - S)) for the LN (3, 8) and kashou-tap (2) pieces; delta off the whole-chart sum
  const delta = new Float64Array(P);
  for (const [pieces, c] of [[[3, 8], PI.calib.c_LN], [[2], PI.calib.c_KT]]) {
    if (c === 1) continue;
    for (const pc of pieces) {
      for (let p = 0; p < P; p++) {
        const S = Ps[pc][p], L = npc[pc] - S;
        const nw = Math.max(0, S - (c - 1) * L);
        delta[p] = delta[p] + (S - nw);
        Ps[pc][p] = nw;
      }
    }
  }
  const acc = new Float64Array(P), totLoss = new Float64Array(P);
  for (let p = 0; p < P; p++) { acc[p] = (v1sC[p] - delta[p]) / N; totLoss[p] = N * (1 - acc[p]); }
  const all = reader.theta(acc);
  const tl = interpGrid(totLoss, all.theta, G);
  const readout = (S, nk) => {
    const loss = new Float64Array(P);
    for (let p = 0; p < P; p++) loss[p] = nk - S[p];
    const s = tl > 0 ? interpGrid(loss, all.theta, G) / tl : NaN;
    let theta = NaN, flag = 'empty';
    if (nk > 0) {
      const ak = new Float64Array(P);
      for (let p = 0; p < P; p++) ak[p] = S[p] / nk;
      ({ theta, flag } = reader.theta(ak, 0.96));
    }
    return { n: nk, share: nk / N, display: nk >= PI.min_n && nk / N >= PI.min_share, theta, flag, s,
      star: Number.isFinite(theta) ? star + kMain * (theta - all.theta) : NaN };
  };
  const items = {};
  for (const [name, pcs] of Object.entries(ITEM_PIECES)) {
    let S = new Float64Array(P), nk = 0;
    for (const pc of pcs) { for (let p = 0; p < P; p++) S[p] = S[p] + Ps[pc][p]; nk += npc[pc]; }
    items[name] = readout(S, nk);
  }
  items.trill_tA = readout(Po.tA, nov.tA);
  items.tech_rA = readout(Po.rA, nov.rA);
  const techTag = items.tech_rA.n >= PI.min_n && items.tech_rA.share >= PI.tech_tau;
  return { thetaU: tU.theta, flagU: tU.flag, kMain, thetaAll: all.theta, flagAll: all.flag, items, techTag };
}
