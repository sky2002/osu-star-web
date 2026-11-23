import { f32, quantile, ssLeft, ssRight } from './pyutil.js';

const IDS = ['jack', 'stream', 'chordstream', 'tech', 'ln', 'stamina'];
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function ramp(value, lo, hi) {
  const x = clamp((value - lo) / (hi - lo), 0, 1);
  return x * x * (3 - 2 * x);
}

function makeTable() {
  const sizes = [[.97, .025, .004, .001], [.51, .47, .018, .002],
    [.48, .16, .35, .01], [.34, .41, .20, .05]];
  const overlaps = [.025, .055, .07, .76];
  return Array.from({ length: 5 }, (_, prev) => {
    const table = Array.from({ length: 8 }, () => new Float64Array(4));
    for (let j = 0; j < 4; j++) {
      let total = 0;
      for (let size = 1; size <= 4; size++) {
        let weight = sizes[j][size - 1];
        if ((j === 1 || j === 2) && prev >= 2) weight *= size === 1 ? 1.65 : .55;
        if ((j === 1 || j === 2) && prev === 1 && size >= 2) weight *= 1.35;
        const both = prev === 0 ? 0 : prev + size > 4 ? 1 : overlaps[j];
        table[2 * size - 2][j] = weight * (1 - both);
        table[2 * size - 1][j] = weight * both;
        total += table[2 * size - 2][j];
        total += table[2 * size - 1][j];
      }
      for (const row of table) row[j] = -Math.log(row[j] / total);
    }
    return table;
  });
}

const TABLE = makeTable();

function breakRows(gaps) {
  const reset = new Uint8Array(gaps.length);
  reset[0] = 1;
  const recent = new Float64Array(8);
  for (let i = 1; i < gaps.length; i++) {
    for (let j = 0; j < 8; j++) recent[j] = gaps[Math.max(1, i - 8 + j)];
    recent.sort();
    reset[i] = gaps[i] > 2 * (recent[3] + recent[4]);
  }
  return reset;
}

function observations(masks, reset) {
  return masks.map((mask, i) => {
    const previous = reset[i] ? 0 : masks[i - 1];
    const symbol = (POP[mask] - 1) * 2 + Number((mask & previous) !== 0);
    return TABLE[POP[previous]][symbol];
  });
}

function minIndex(values) {
  let result = 0;
  for (let j = 1; j < values.length; j++) if (values[j] < values[result]) result = j;
  return result;
}

function sections(costs, reset) {
  const state = new Uint8Array(reset.length).fill(4);
  const back = new Uint8Array(reset.length * 4);
  const change = Math.log((1 - .025) / (.025 / 3));
  for (let a = 0; a < reset.length;) {
    let b = a + 1;
    while (b < reset.length && !reset[b]) b++;
    if (b - a >= 4) {
      const cost = costs[a].slice();
      for (let i = a + 1; i < b; i++) {
        const best = minIndex(cost);
        const cut = cost[best] + change;
        for (let j = 0; j < 4; j++) {
          back[4 * i + j] = cost[j] <= cut ? j : best;
          cost[j] = Math.min(cost[j], cut) + costs[i][j];
        }
      }
      state[b - 1] = minIndex(cost);
      for (let i = b - 1; i > a; i--) state[i - 1] = back[4 * i + state[i]];
    }
    a = b;
  }
  return state;
}

function handRows(time, masks) {
  const trill = new Uint8Array(time.length * 4);
  const bullet = new Float64Array(time.length * 4);
  for (const side of [0, 2]) {
    const index = [], hand = [];
    for (let i = 0; i < masks.length; i++) {
      const here = (masks[i] >> side) & 3;
      if (here) { index.push(i); hand.push(here); }
    }
    const gaps = new Float64Array(index.length);
    const same = new Uint8Array(index.length);
    const links = new Uint8Array(index.length);
    gaps[0] = Infinity;
    let previousAlternates = false;
    for (let i = 1; i < index.length; i++) {
      const gap = time[index[i]] - time[index[i - 1]];
      gaps[i] = gap;
      same[i] = hand[i] === hand[i - 1] && hand[i] !== 3;
      const alternates = hand[i] + hand[i - 1] === 3 && gap < 200;
      links[i] = previousAlternates && alternates
        && Math.max(gap, gaps[i - 1]) <= 1.25 * Math.min(gap, gaps[i - 1]);
      previousAlternates = alternates;
    }
    for (let i = 2; i + 1 < index.length; i++) {
      if (same[i] && !same[i - 1] && !same[i + 1]) {
        const lane = side + (hand[i] === 2 ? 1 : 0);
        bullet[4 * index[i] + lane] = ramp(gaps[i], 65, 75) * (1 - ramp(gaps[i], 125, 140));
      }
    }
    const edges = new Int32Array(index.length + 1);
    for (let i = 2; i < index.length;) {
      if (!links[i]) { i++; continue; }
      let end = i + 1;
      while (links[end]) end++;
      if (end - i >= 2) { edges[i - 2]++; edges[end]--; }
      i = end;
    }
    let active = 0;
    for (let i = 0; i < index.length; i++) {
      active += edges[i];
      if (!active) continue;
      for (let j = 0; j < 2; j++) trill[4 * index[i] + side + j] = (hand[i] >> j) & 1;
    }
  }
  return { trill, bullet };
}

function coordination(start, end, columns, held) {
  const lock = new Uint8Array(start.length), shield = new Float64Array(start.length);
  const opened = [[], [], [], []], closed = [[], [], [], []];
  for (let i = 0; i < start.length; i++) if (held[i]) {
    opened[columns[i]].push(start[i]);
    closed[columns[i]].push(end[i]);
  }
  const innerStart = opened.map(lane => lane.map(t => t + 42));
  const innerEnd = closed.map(lane => lane.map(t => t - 42).sort((a, b) => a - b));
  const endpoints = opened.map((lane, i) => lane.concat(closed[i]).sort((a, b) => a - b));
  for (let i = 0; i < start.length; i++) if (!held[i]) {
    const lane = columns[i], partner = lane ^ 1, t = start[i];
    lock[i] = ssRight(innerStart[partner], t) > ssLeft(innerEnd[partner], t);
    const ends = endpoints[lane];
    if (ends.length) {
      const j = ssLeft(ends, t);
      const before = Math.abs(t - ends[Math.max(0, j - 1)]);
      const after = Math.abs(t - ends[Math.min(j, ends.length - 1)]);
      shield[i] = 1 - ramp(Math.min(before, after), 0, 150);
    }
  }
  return { lock, shield };
}

function timing(gaps, reset) {
  const n = gaps.length;
  const a = new Float64Array(n + 1), b = new Float64Array(n + 1), c = new Float64Array(n + 1);
  for (let i = 2; i < n; i++) if (!reset[i] && !reset[i - 1]) {
    const g0 = gaps[i - 1], g1 = gaps[i];
    const ratio = Math.abs(Math.log(Math.max(g1, 1) / Math.max(g0, 1)));
    a[i + 1] = ramp(Math.min(ratio, Math.abs(ratio - Math.log(2))), Math.log(1.10), Math.log(1.25));
    b[i + 1] = ramp(ratio, Math.log(1.12), Math.log(1.30));
    const lo = Math.min(g0, g1), hi = Math.max(g0, g1);
    if (lo <= 65 && hi <= 350 && hi >= 1.75 * lo) { c[i] = 1; c[i + 1] = 1; }
  }
  for (let i = 1; i <= n; i++) { a[i] += a[i - 1]; b[i] += b[i - 1]; c[i] += c[i - 1]; }
  const poly = new Float64Array(n), snap = new Float64Array(n);
  const burst = new Float64Array(n), speed = new Float64Array(n);
  for (let first = 0; first < n;) {
    let last = first + 1;
    while (last < n && !reset[last]) last++;
    for (let i = first; i < last; i++) {
      const lo = Math.max(i - 4, first), hi = Math.min(i + 5, last);
      speed[i] = 1 - ramp(Math.min(gaps[i], gaps[i + 1] ?? Infinity), 180, 250);
      poly[i] = ramp((a[hi] - a[lo]) / (hi - lo), .08, .35) * speed[i];
      snap[i] = ramp((b[hi] - b[lo]) / (hi - lo), .25, .60) * speed[i];
      burst[i] = ramp((c[hi] - c[lo]) / (hi - lo), .12, .45) * speed[i];
    }
    first = last;
  }
  return { poly, snap, burst, speed };
}

export function classifyObjects(start, end, columns) {
  const row = new Int32Array(start.length), time = [], masks = [];
  const held = new Uint8Array(start.length);
  for (let i = 0; i < start.length; i++) {
    if (!i || start[i] !== start[i - 1]) { time.push(start[i]); masks.push(0); }
    row[i] = time.length - 1;
    masks[row[i]] |= 1 << columns[i];
    held[i] = end[i] - start[i] >= 94 - 1e-9;
  }
  const gaps = Float64Array.from(time, (t, i) => i ? t - time[i - 1] : Infinity);
  const reset = breakRows(gaps);
  const state = sections(observations(masks, reset), reset);
  const { trill, bullet } = handRows(time, masks);
  const { lock, shield } = coordination(start, end, columns, held);
  const { poly, snap, burst, speed } = timing(gaps, reset);
  const weights = Array.from({ length: 5 }, () => new Float64Array(start.length));
  const trills = new Uint8Array(start.length);
  for (let i = 0; i < start.length; i++) {
    const r = row[i], lane = columns[i], gap = gaps[r], rice = 1 - held[i];
    const same = Number(((masks[r - 1] ?? 0) & (1 << lane)) !== 0);
    const isolated = 1 - lock[i];
    const fast = (1 - ramp(gap, 125, 175)) * rice;
    const repeat = same * (1 - ramp(gap, 160, 200)) * isolated;
    const flow = fast * (1 - repeat);
    const mini = bullet[4 * r + lane] * rice * Number(state[r] !== 3) * isolated;
    const coord = Math.max(lock[i], shield[i]) * speed[r];
    weights[0][i] = rice * isolated * (1 - ramp(gap, 180, 230)) * (same || .4 * Number(state[r] === 3));
    weights[1][i] = state[r] === 0 ? flow : 0;
    weights[2][i] = state[r] === 1 || state[r] === 2 ? flow : 0;
    weights[3][i] = 1 - (1 - poly[r]) * (1 - .8 * snap[r]) * (1 - .8 * burst[r]) * (1 - mini) * (1 - .4 * coord);
    weights[4][i] = held[i];
    trills[i] = trill[4 * r + lane] * rice;
  }
  return { weights, trills };
}

function staminaWeights(start, heads, pre) {
  const w = new Float64Array(start.length);
  const eligible = ssLeft(start, start[0] + 15000);
  if (eligible >= start.length) return w;
  const values = new Float32Array(start.length - eligible);
  for (let i = eligible; i < start.length; i++) {
    const at = heads[i] * 24;
    let x = 0, y = 0;
    for (let j = 1; j < 24; j += 3) {
      x += f32(Math.log1p(pre[at + j]));
      y += f32(Math.log1p(pre[at + j + 1]));
    }
    values[i - eligible] = f32((f32(x / 8) + f32(y / 8)) / 2);
  }
  const cutoff = quantile(values, .7);
  for (let i = eligible; i < start.length; i++) w[i] = Number(values[i - eligible] >= cutoff);
  return w;
}

function chartWindows(start, t0, t1) {
  const windows = [];
  if (!start.length) return windows;
  const add = (startMs, endMs, closed) => {
    const from = ssLeft(start, startMs);
    const to = closed ? ssRight(start, endMs, from) : ssLeft(start, endMs, from);
    windows.push({ startMs, endMs, from, to, sparse: to - from < 8 });
  };
  if (t1 - t0 <= 10000) add(t0, t1, true);
  else {
    for (let s = t0; s < t1 - 10000; s += 5000) add(s, s + 10000, false);
    add(t1 - 10000, t1, true);
  }
  return windows;
}

export function itemInputs(actions, pre, withItems = true) {
  const { times, heads, lnH, lnT, columns } = actions;
  const start = Float64Array.from(heads, h => times[h]);
  const windows = chartWindows(start, times[0], times[times.length - 1]);
  if (!withItems) return { weights: null, windows };
  const tailTimes = times.slice();
  for (let j = 0; j < lnH.length; j++) tailTimes[lnH[j]] = times[lnT[j]];
  const end = Float64Array.from(heads, h => tailTimes[h]);
  const lanes = Uint8Array.from(heads, h => columns[h]);
  const { weights } = classifyObjects(start, end, lanes);
  weights.push(staminaWeights(start, heads, pre));
  return { weights, windows };
}

function interpolate(x, nodes) {
  if (x <= nodes[0][0]) return nodes[0][1];
  for (let i = 1; i < nodes.length; i++) if (x <= nodes[i][0]) {
    const [a, u] = nodes[i - 1], [b, v] = nodes[i];
    return u + (v - u) * ((x - a) / (b - a));
  }
  return nodes[nodes.length - 1][1];
}

export function sortItems(items) {
  return [...items].sort((a, b) => Number(b.display) - Number(a.display) || b.share - a.share
    || (b.star ?? -Infinity) - (a.star ?? -Infinity) || IDS.indexOf(a.id) - IDS.indexOf(b.id));
}

export function itemReadout({ weights, roots, losses, star, theta, config }) {
  const totalLoss = losses.reduce((total, value) => total + value, 0);
  if (!(totalLoss > 0) || !Number.isFinite(totalLoss)) throw new Error('Invalid expected score');
  const k = interpolate(theta, config.kn);
  const values = IDS.map((id, d) => {
    const w = weights[d];
    let effN = 0, lost = 0;
    for (let i = 0; i < w.length; i++) { effN += w[i]; lost += losses[i] * w[i]; }
    const frac = effN / w.length;
    let value = null;
    if (effN > 0) {
      if (!Number.isFinite(roots[d])) throw new Error('Invalid item score');
      const raw = star + k * (roots[d] - theta);
      const [a, b, lo, hi] = config.af[d];
      value = raw - a - b * clamp(raw, lo, hi);
      if (!Number.isFinite(value)) throw new Error('Invalid item score');
    }
    return { id, star: value, share: lost / totalLoss, display: effN >= 50 && frac >= .05, effN, frac };
  });
  const stamina = values.pop();
  return { items: sortItems(values), stamina };
}

export function segmentReadout({ windows, roots, star, theta, config }) {
  const k = config.sc[1] * config.sc[2];
  let dense = null, sparseBest = null;
  const segments = windows.map(({ startMs, endMs, from, to, sparse }, i) => {
    const nObj = to - from;
    if (nObj && !Number.isFinite(roots[i])) throw new Error('Invalid segment score');
    const value = nObj ? star + k * (roots[i] - theta) : null;
    if (nObj && !Number.isFinite(value)) throw new Error('Invalid segment score');
    const startS = startMs / 1000, endS = endMs / 1000;
    if (value !== null) {
      if (!sparse && (!dense || value > dense.star)) dense = { startS, endS, star: value };
      if (sparse && (!sparseBest || value > sparseBest.star)) sparseBest = { startS, endS, star: value };
    }
    return { startS, endS, star: value, nObj, sparse };
  });
  return { segments, hardest: dense ?? sparseBest };
}
