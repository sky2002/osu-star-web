// 22 hand features, ported from analysis/star-cnn-r1/baseline_feat.feats with the note preparation of
// analysis/tree-topend-r3/score_osu.Scorer.features (sorted (t, col, end), shift by the first start).
import { ssLeft, quantileSorted, median } from './pyutil.js';
import { ChartError, MIN_NOTES } from './osu.js';

export function prepareFeatureNotes(parsed) {
  const { od, cs, mode, notes } = parsed;
  if (mode !== 3) throw new ChartError('not_mania', `not a mania chart (mode ${mode})`);
  if (cs !== null && pyRoundHalfEven(cs) !== 4) {
    throw new ChartError('not_4k', `not a 4K chart (keys ${cs})`);
  }
  if (notes.length < MIN_NOTES) throw new ChartError('too_few_notes', `only ${notes.length} notes (< ${MIN_NOTES})`);
  const a = notes.slice().sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]) || (p[2] - q[2]));
  const o = a[0][0];
  const s = new Float64Array(a.length), c = new Int32Array(a.length), e = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { s[i] = a[i][0] - o; c[i] = a[i][1]; e[i] = a[i][2] >= 0 ? a[i][2] - o : a[i][2]; }
  return { s, c, e, od };
}

function pyRoundHalfEven(x) {   // Python round(): half to even
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function feats(s, c, e, od) {
  // s already sorted (stable argsort is the identity)
  const n = s.length;
  let smax = -Infinity, emax = -Infinity;
  for (let i = 0; i < n; i++) { if (s[i] > smax) smax = s[i]; if (e[i] > emax) emax = e[i]; }
  const dur = Math.max(smax, emax, 1000) / 1000;
  let ln = 0;
  for (let i = 0; i < n; i++) if (e[i] >= 0) ln++;
  const out = { od: od === null ? NaN : od, log_dur: Math.log(dur), n: Math.log(n), nps: n / dur, ln_frac: ln / n };
  for (const w of [1000, 4000, 15000]) {
    const cnt = new Float64Array(n);
    let mx = -Infinity;
    for (let i = 0; i < n; i++) { cnt[i] = (ssLeft(s, s[i] + w) - i) / (w / 1000); if (cnt[i] > mx) mx = cnt[i]; }
    const sorted = Float64Array.from(cnt).sort();
    out[`nps_max_${w}`] = mx;
    out[`nps_q95_${w}`] = quantileSorted(sorted, 0.95);
    out[`nps_q75_${w}`] = quantileSorted(sorted, 0.75);
  }
  // np.unique(s): unique times, counts
  const ut = [], uc = [];
  for (let i = 0; i < n; i++) {
    if (i && s[i] === s[i - 1]) uc[uc.length - 1]++;
    else { ut.push(s[i]); uc.push(1); }
  }
  let inChord = 0;
  for (const k of uc) if (k > 1) inChord += k;
  out.chord_frac = inChord / n;
  out.chord_size = uc.reduce((a, b) => a + b, 0) / uc.length;
  let gs = [];
  for (let k = 0; k < 4; k++) {
    const sk = [];
    for (let i = 0; i < n; i++) if (c[i] === k) sk.push(s[i]);
    if (sk.length > 1) for (let i = 1; i < sk.length; i++) gs.push(sk[i] - sk[i - 1]);
  }
  if (!gs.length) gs = [1e4];
  const gapAny = ut.length > 1 ? ut.slice(1).map((v, i) => v - ut[i]) : [1e4];
  let j180 = 0, j120 = 0;
  for (const g of gs) { if (g < 180) j180++; if (g < 120) j120++; }
  out.jack180 = j180 / gs.length;
  out.jack120 = j120 / gs.length;
  out.gap_same_q10 = quantileSorted(Float64Array.from(gs).sort(), 0.1);
  out.gap_any_q10 = quantileSorted(Float64Array.from(gapAny).sort(), 0.1);
  out.gap_any_med = median(gapAny);
  const cc = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) cc[c[i]]++;
  const fr = cc.map(v => v / n);
  out.col_imbalance = Math.max(...fr) - Math.min(...fr);
  return out;
}
