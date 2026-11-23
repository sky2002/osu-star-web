import { v1Windows } from './reader.js';

const round = Math.fround;
const P = 402;
const Q = 602;
const weights = [0, 0, 1 / 6, 1 / 3, 2 / 3, 1, 1, 1, 2 / 3, 1 / 3, 1 / 6, 0];

function limits(od, rate, hit) {
  const w = v1Windows(od, rate, hit);
  const e = w.slice().reverse().map(v => -(v + 0.5) / rate);
  e.push(...w.slice(0, 3).map(v => (v + 0.5) / rate), (w[3] - 0.5) / rate, (w[3] - 0.5) / rate);
  const a = [1.2 * w[0], 1.1 * w[1], w[2], w[3]].map(v => Math.floor(v + 1e-6) + 0.5);
  const b = [2.4 * w[0], 2.2 * w[1], 2 * w[2], 2 * w[3]].map(v => Math.floor(v + 1e-6) + 0.5);
  const tap = Float64Array.from({ length: P }, (_, i) => i === P - 1 ? 0 : weights[e.filter(v => v < i - 200).length]);
  return { w, a, b, tap };
}

function masses(a, b, start, t, out) {
  let max = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const v = round(a[start + i] + round(t * b[start + i]));
    out[i] = v;
    if (v > max) max = v;
  }
  let z = 0;
  for (let i = 0; i < out.length; i++) {
    const v = Math.exp(out[i] - max);
    out[i] = v;
    z += v;
  }
  return z;
}

function fixedMasses(a, start, out, lanes, single) {
  let max = -Infinity;
  for (let i = 0; i < out.length; i++) max = Math.max(max, a[start + i]);
  lanes.fill(0);
  for (let i = 0; i < out.length; i++) {
    const x = round(a[start + i] - max);
    out[i] = x;
    lanes[i % lanes.length] += round(Math.exp(x));
  }
  const sum = lanes.reduce((a, b) => round(a + b), 0);
  const scale = round(Math.log(sum));
  for (let i = 0; i < out.length; i++) {
    const x = Math.exp(round(out[i] - scale));
    out[i] = single ? round(x) : x;
  }
}

function lookup(sum, p) {
  const i = p | 0;
  return sum[i] + (p - i) * (sum[i + 1] - sum[i]);
}

function bounds(d, r, rate, { w, a, b }, precise = false) {
  const w3 = w[3], w4 = w[4], w5 = w[5];
  const releaseMin = Math.ceil(-w4);
  const earlyEnd = Math.ceil(w3) - 1;
  const lateEnd = Math.max(Math.ceil(w3), releaseMin) - 1;
  const cast = precise ? Number : round;
  const q = cast(rate);
  const lastHead = d <= 2 * w4 ? w4 : d === 2 * w4 + 1 ? w4 + 1 : Infinity;
  const first = Math.max(0, Math.floor(-w5 / q) + 200);
  const last = Math.min(P - 2, Math.ceil(Math.min(d + w3, lastHead) / q) + 200);
  const Endpoints = precise ? Float64Array : Float32Array;
  const endpoints = new Endpoints(Math.max(0, last - first + 1) * 9);
  for (let i = first; i <= last; i++) {
    const at = (i - first) * 9;
    const h = i - 200, map = cast(h * q);
    if (map < -w5 || map >= cast(d + w3) ||
        (map > w4 && d <= 2 * w4) || (map > w4 + 1 && d === 2 * w4 + 1)) continue;
    const floor = cast(cast(map + 1) - d);
    const err = map < -w4 ? Math.abs(cast(d - 1)) : Math.abs(map);
    const shifted = cast(r * h);
    function pos(x) {
      return x >= floor ? Math.max(0, Math.min(Q - 1, cast(cast(cast(x / q) - shifted) + 301))) : 0;
    }
    endpoints[at] = pos(releaseMin - 1) + 1;
    endpoints[at + 1] = pos(lateEnd);
    let limit = -1e4;
    let extra = 0;
    for (let g = 0; g < 4; g++) {
      if (err < a[g]) limit = Math.max(limit, cast(b[g] - err));
      if (g === 0 || (g === 1 && map > w4 && d > 2 * w4)) continue;
      const lo = Math.max(releaseMin, Math.floor(-limit) + 1);
      const hi = Math.min(earlyEnd, Math.ceil(limit) - 1);
      if (hi >= lo) {
        endpoints[at + 2 * g + 1] = pos(hi);
        endpoints[at + 2 * g + 2] = pos(lo - 1);
      }
      if (w4 < limit) extra += g === 3 ? 1 / 6 : 1 / 3;
    }
    endpoints[at + 2] = extra;
  }
  return { first, last, endpoints };
}

export class V4Score {
  constructor(outputs, layout, od, rate, hit) {
    this.outputs = outputs;
    this.n = layout.nNotes;
    this.D = layout.D;
    this.rate = rate;
    this.spec = limits(od, rate, hit);
    this.which = new Int32Array(this.n).fill(-1);
    this.spans = [];
    const objectAt = new Int32Array(layout.nActions);
    for (let i = 0; i < layout.heads.length; i++) objectAt[layout.heads[i]] = i;
    for (let j = 0; j < layout.lnH.length; j++) {
      this.which[objectAt[layout.lnH[j]]] = j;
      this.spans.push(bounds(round(layout.D[j]), outputs.rho[j], rate, this.spec));
    }
    this.p = new Float64Array(P);
    this.q = new Float64Array(Q);
    this.sum = new Float64Array(Q + 1);
    this.lanes = new Float32Array(8);
  }

  at(i, t, precise = false) {
    const { Ap, Bp, Ar, Br, rho } = this.outputs;
    const p = this.p;
    const j = this.which[i];
    let zp = 1;
    if (precise) fixedMasses(Ap, i * P, p, this.lanes, j < 0);
    else zp = masses(Ap, Bp, i * P, t, p);
    if (j < 0) {
      const w = this.spec.tap;
      let score = 0;
      if (precise) {
        for (let k = 0; k < P - 1; k++) score += round(p[k] * round(w[k]));
      } else {
        for (let k = 0; k < P - 1; k++) score += p[k] * w[k];
      }
      return round(score / zp);
    }
    const q = this.q, sum = this.sum;
    let zq = 1;
    if (precise) fixedMasses(Ar, j * Q, q, this.lanes, false);
    else zq = masses(Ar, Br, j * Q, t, q);
    for (let k = 0; k < Q - 1; k++) sum[k + 1] = sum[k] + q[k];
    const hit = sum[Q - 1];
    sum[Q] = hit;
    const { first, last, endpoints: d } = precise ? bounds(this.D[j], rho[j], this.rate, this.spec, true) : this.spans[j];
    let score = 0;
    for (let k = first, a = 0; k <= last; k++, a += 9) {
      if (d[a] === 0) continue;
      let v = (hit - lookup(sum, d[a] - 1)) / 6;
      if (d[a + 2] !== 0) v += d[a + 2] * (hit - lookup(sum, d[a + 1]));
      if (d[a + 3] !== d[a + 4]) v += (lookup(sum, d[a + 3]) - lookup(sum, d[a + 4])) / 3;
      if (d[a + 5] !== d[a + 6]) v += (lookup(sum, d[a + 5]) - lookup(sum, d[a + 6])) / 3;
      if (d[a + 7] !== d[a + 8]) v += (lookup(sum, d[a + 7]) - lookup(sum, d[a + 8])) / 6;
      score += p[k] * v;
    }
    const value = score / (zp * zq);
    return precise ? value : round(value);
  }

  fixed() {
    return Float64Array.from({ length: this.n }, (_, i) => this.at(i, 0, true));
  }

  run(levels) {
    const scores = new Float32Array(this.n * levels.length);
    for (let j = 0; j < levels.length; j++) {
      const t = round(levels[j]);
      const offset = j * this.n;
      for (let i = 0; i < this.n; i++) scores[offset + i] = this.at(i, t);
    }
    return scores;
  }
}
