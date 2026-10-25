// CNN36 reading: small 1-D CNN, 10 models (seeds 17 / 29 x folds 0-4) x (original, mirrored) grid, reading = mean of the 20.
// Reference: research repository analysis/cnn36-web-r1/cnn_ref.py (grid = analysis/route1-r1/cnn/cnn_model.py at_rate +
// make_grid for one chart); model/cnn36.onnx is written by analysis/cnn36-web-r1/export_cnn_onnx.py (mirroring inside).
// Input = prepareFeatureNotes (features.js) arrays with times relative to the first note and NOT divided by the rate:
// cnnGrid applies the rate itself (rounded to the ms, half to even, as numpy). Missing OD -> 7.5, the training-table fill.
import { rint, f32 } from './pyutil.js';

export const BIN_MS = 10;
export const DOWN = 32;            // 5 stride-2 stages -> 320 ms per segment
export const EVAL_MAX = 120000;    // bins (20 min); longer charts are read in the first 20 min
export const OD_FILL = 7.5;        // rows.csv od NaN -> 7.5 (route1-r1 cnn/train_folds.py, cnn-pernote-r1/score_pn.py)

// cnn_model.at_rate + make_grid: 13 channels x L bins of 10 ms, channel-major (= the float32 [13, L] grid, C order)
//   0-3 presses per column, 4-7 LN releases (tail bin capped at L - 1), 8-11 LN held (head bin .. tail bin, 0 / 1),
//   12 (OD - 7.5) / 1.5 in float32. Counts add up (two notes in one bin give 2).
export function cnnGrid(s, c, e, od, rate = 1) {
  const n = s.length;
  const s2 = new Float64Array(n), e2 = new Float64Array(n);
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    s2[i] = rate === 1 ? s[i] : rint(s[i] / rate);
    e2[i] = e[i] >= 0 ? (rate === 1 ? e[i] : rint(e[i] / rate)) : -1;
    if (s2[i] > mx) mx = s2[i];
    if (e2[i] > mx) mx = e2[i];
  }
  const last = Math.min(Math.floor(mx / BIN_MS) + 2, EVAL_MAX);
  const L = Math.ceil(last / DOWN) * DOWN;
  const data = new Float32Array(13 * L);
  const hold = new Float64Array(4 * (L + 1));
  for (let i = 0; i < n; i++) {
    if (!(s2[i] < last * BIN_MS)) continue;
    const col = c[i], hb = Math.floor(s2[i] / BIN_MS);
    data[col * L + hb] += 1;
    if (e2[i] >= 0) {
      const tb = Math.min(Math.floor(e2[i] / BIN_MS), L - 1);
      data[(4 + col) * L + tb] += 1;
      hold[col * (L + 1) + hb] += 1;
      hold[col * (L + 1) + tb] -= 1;
    }
  }
  for (let k = 0; k < 4; k++) {
    let acc = 0;
    const h = k * (L + 1), g = (8 + k) * L;
    for (let t = 0; t < L; t++) {
      acc += hold[h + t];
      data[g + t] = acc < 0 ? 0 : acc > 1 ? 1 : acc;
    }
  }
  const o = od === null || od === undefined || Number.isNaN(od) ? OD_FILL : od;
  data.fill(f32(f32(f32(o) - 7.5) / 1.5), 12 * L, 13 * L);
  return { data, L, last };
}

export class Cnn36 {
  constructor(session, ort) {
    this.sess = session; this.ort = ort;
  }

  // -> Float64Array(20): model-major, (original, mirrored) per model, models seed 17 folds 0-4 then seed 29 folds 0-4
  async readings(grid) {
    const res = await this.sess.run({ grid: new this.ort.Tensor('float32', grid.data, [1, 13, grid.L]) });
    return Float64Array.from(res.readings.data);
  }

  async reading(grid) {
    const r = await this.readings(grid);
    let s = 0;
    for (let i = 0; i < r.length; i++) s += r[i];
    return s / r.length;
  }
}
