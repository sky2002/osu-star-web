// Action tokens, ported from tools/pilot_v3_w3_data.chart_inputs, tools/chart_star_sequence.sequence_from_notes,
// tools/chart_star_chord_order.sequence_from_notes_sym (tie='average') and dan-readout dr_prep.pairing (rate 1.0).
// Output: tokens [n,17] float32 (raw, before standardisation) in the sym chord order, times (ms), comp (0 head, 1 tail),
// LN head / tail action indices (same held order), number of notes. rate: 0.75 / 1.5 divide every time by the rate (real ms).
import { rint, round6, ssLeft, ssRight, f32 } from './pyutil.js';

const D = 18;

export function tokensFromNotes(notesIn, rate = 1) {
  const N = notesIn.length;
  // chart_inputs: notes[:, :2] = rint(round(notes[:, :2] - min start, 6) / rate * 1e6) / 1e6
  let mn = Infinity;
  for (const n of notesIn) if (n[0] < mn) mn = n[0];
  const s = new Float64Array(N), e = new Float64Array(N), col = new Int32Array(N), hold = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    s[i] = rint(round6(notesIn[i][0] - mn) / rate * 1e6) / 1e6;
    e[i] = rint(round6(notesIn[i][1] - mn) / rate * 1e6) / 1e6;
    col[i] = notesIn[i][2]; hold[i] = notesIn[i][3];
  }
  const held = [];
  for (let i = 0; i < N; i++) if (hold[i]) held.push(i);
  const A = N + held.length;
  // actions rows: [note, comp, time, col]; heads then tails; lexsort((col, comp, time)) stable
  const aNote = new Int32Array(A), aComp = new Int32Array(A), aTime = new Float64Array(A), aCol = new Int32Array(A);
  for (let i = 0; i < N; i++) { aNote[i] = i; aComp[i] = 0; aTime[i] = s[i]; aCol[i] = col[i]; }
  for (let j = 0; j < held.length; j++) { const i = held[j]; aNote[N + j] = i; aComp[N + j] = 1; aTime[N + j] = e[i]; aCol[N + j] = col[i]; }
  const order = Array.from({ length: A }, (_, k) => k);
  order.sort((a, b) => (aTime[a] - aTime[b]) || (aComp[a] - aComp[b]) || (aCol[a] - aCol[b]) || (a - b));
  const note = new Int32Array(A), comp = new Int32Array(A), c = new Int32Array(A);
  const t = new Float64Array(A);          // int64 nanoseconds-of-ms units, exact in double
  const times = new Float64Array(A);
  for (let k = 0; k < A; k++) {
    const r = order[k];
    note[k] = aNote[r]; comp[k] = aComp[r]; c[k] = aCol[r];
    times[k] = aTime[r]; t[k] = rint(aTime[r] * 1e6);
  }
  const x = new Float64Array(A * 12);     // chart_inputs features 0..9 (+10 comp, 11 col); values held as float32
  const X = (k, j) => k * 12 + j;
  for (let k = 0; k < A; k++) {
    for (let jj = 0; jj < 3; jj++) {
      const span = [1000, 4000, 16000][jj];
      const v = (ssRight(t, t[k] + span * 500000) - ssLeft(t, t[k] - span * 500000)) / (span / 1000);
      x[X(k, jj)] = f32(v);
    }
  }
  const BIG = 4000000000;
  for (let cc = 0; cc < 4; cc++) {
    const ix = [];
    for (let k = 0; k < A; k++) if (c[k] === cc) ix.push(k);
    if (!ix.length) continue;
    const hand = [];
    for (let k = 0; k < A; k++) if ((c[k] >> 1) === (cc >> 1)) hand.push(t[k]);
    const nextHeads = [];
    for (let i = 0; i < N; i++) if (col[i] === cc) nextHeads.push(rint(s[i] * 1e6));   // notes sorted by (start, col)
    let tmax = -Infinity;
    for (let k = 0; k < A; k++) if (t[k] > tmax) tmax = t[k];
    for (let q = 0; q < ix.length; q++) {
      const k = ix[q];
      const prev = q === 0 ? t[ix[0]] - BIG : t[ix[q - 1]];
      const next = q === ix.length - 1 ? t[ix[ix.length - 1]] + BIG : t[ix[q + 1]];
      x[X(k, 3)] = f32(Math.min(t[k] - prev, BIG) / 1e9);
      x[X(k, 4)] = f32(Math.min(next - t[k], BIG) / 1e9);
      x[X(k, 5)] = f32(ssRight(hand, t[k] + 500000000) - ssLeft(hand, t[k] - 500000000));
      const p = ssRight(nextHeads, t[k]);
      const nh = p < nextHeads.length ? nextHeads[p] : tmax + BIG;
      x[X(k, 9)] = f32(Math.min(Math.max(nh - t[k], 0), BIG) / 1e9);
    }
  }
  const hs = [], he = [];
  for (const i of held) { hs.push(rint(s[i] * 1e6)); he.push(rint(e[i] * 1e6)); }
  hs.sort((a, b) => a - b); he.sort((a, b) => a - b);
  for (let k = 0; k < A; k++) {
    x[X(k, 6)] = f32(ssRight(t, t[k]) - ssLeft(t, t[k]));
    x[X(k, 7)] = f32((e[note[k]] - s[note[k]]) / 1000);
    x[X(k, 8)] = f32(ssRight(hs, t[k]) - ssLeft(he, t[k]));
    for (let j = 0; j < 10; j++) x[X(k, j)] = f32(Math.log1p(f32(Math.max(x[X(k, j)], 0))));
  }
  for (let k = 1; k < A; k++) if (times[k] < times[k - 1]) throw new Error('Actions not in playback order');
  // sequence_from_notes tokens (old order), 18 dims, float32
  const tok = new Float32Array(A * D);
  const T = (k, j) => k * D + j;
  for (let k = 0; k < A; k++) {
    for (let j = 0; j < 10; j++) tok[T(k, j)] = x[X(k, j)];
    tok[T(k, 10 + c[k])] = 1;
    tok[T(k, 14)] = comp[k];
    tok[T(k, 15)] = hold[note[k]];
  }
  // chord_permutation (orient 1): groups by (time, comp); key (g, |col-1.5|, x0..x9, x7, x15, col)
  const g = new Int32Array(A);
  for (let k = 1; k < A; k++) g[k] = g[k - 1] + ((times[k] !== times[k - 1] || tok[T(k, 14)] !== tok[T(k - 1, 14)]) ? 1 : 0);
  const perm = Array.from({ length: A }, (_, k) => k);
  perm.sort((a, b) => {
    if (g[a] !== g[b]) return g[a] - g[b];
    let d = Math.abs(c[a] - 1.5) - Math.abs(c[b] - 1.5); if (d) return d;
    for (let j = 0; j < 10; j++) { d = tok[T(a, j)] - tok[T(b, j)]; if (d) return d; }
    d = tok[T(a, 7)] - tok[T(b, 7)]; if (d) return d;
    d = tok[T(a, 15)] - tok[T(b, 15)]; if (d) return d;
    d = c[a] - c[b]; if (d) return d;
    return a - b;
  });
  const out = new Float32Array(A * 17);
  const tN = new Float64Array(A), compN = new Int32Array(A), colN = new Int32Array(A), gN = new Int32Array(A);
  for (let k = 0; k < A; k++) {
    const o = perm[k];
    for (let j = 0; j < 16; j++) out[k * 17 + j] = tok[T(o, j)];
    tN[k] = times[o]; compN[k] = comp[o]; colN[k] = c[o]; gN[k] = g[o];
  }
  for (let k = 0; k < A; k++) out[k * 17 + 16] = f32(Math.log1p((k ? tN[k] - tN[k - 1] : 0) / 1000));
  // tie pairs (new order): same group, identical (|col-1.5|, dims 0..9, dim 15) -> mirror columns, averaged one-hots
  const same = new Uint8Array(A);
  for (let k = 1; k < A; k++) {
    if (gN[k] !== gN[k - 1] || Math.abs(colN[k] - 1.5) !== Math.abs(colN[k - 1] - 1.5)) continue;
    let eq = true;
    for (let j = 0; j < 10 && eq; j++) if (out[k * 17 + j] !== out[(k - 1) * 17 + j]) eq = false;
    if (eq && out[k * 17 + 15] !== out[(k - 1) * 17 + 15]) eq = false;
    if (!eq) continue;
    if (colN[k] + colN[k - 1] !== 3) throw new Error('Tie pair is not a mirror column pair');
    same[k] = 1;
  }
  for (let k = 2; k < A; k++) if (same[k] && same[k - 1]) throw new Error('Tie of more than two tokens');
  const mask = new Uint8Array(A);
  for (let k = 1; k < A; k++) if (same[k]) { mask[k] = 1; mask[k - 1] = 1; }
  for (let k = 0; k < A; k++) if (mask[k]) {
    const b = k * 17 + 10;
    const v = [out[b], out[b + 1], out[b + 2], out[b + 3]];
    for (let j = 0; j < 4; j++) out[b + j] = f32(0.5 * (v[j] + v[3 - j]));
  }
  // pairing: new index of each LN head / tail, in held (note index) order
  const inv = new Int32Array(A);
  for (let k = 0; k < A; k++) inv[perm[k]] = k;
  const headNew = new Int32Array(N), tailNew = new Int32Array(N).fill(-1);
  for (let k = 0; k < A; k++) { if (comp[k] === 0) headNew[note[k]] = inv[k]; else tailNew[note[k]] = inv[k]; }
  const lnH = new Int32Array(held.length), lnT = new Int32Array(held.length);
  held.forEach((i, j) => { lnH[j] = headNew[i]; lnT[j] = tailNew[i]; });
  const noteOf = new Int32Array(A);          // note index (chart order) of every action, new order
  for (let k = 0; k < A; k++) noteOf[k] = note[perm[k]];
  return { tokens: out, times: tN, comp: compN, lnH, lnT, noteOf, nNotes: N, nActions: A };
}
