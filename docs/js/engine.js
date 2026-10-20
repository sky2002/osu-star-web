// Tree star v1 (P1h) for one .osu: 22 hand features + s29 theta* -> HistGBDT -> star = a + b * reading.
// Reference: analysis/tree-topend-r3/score_osu.py (research repository), Scorer('P1h').score.
import { metadata, loadChart, parseOsuFeat, svFrac, sbLines, ChartError } from './osu.js';
import { tokensFromNotes } from './tokens.js';
import { buildTable } from './tdist.js';
import { prepareFeatureNotes, feats } from './features.js';
import { predictTree } from './tree.js';
import { Reader, RATE_MIN, RATE_MAX } from './reader.js';
import { md5Hex } from './md5.js';
import { classifyNotes, calibInputs, itemReadouts } from './pattern-items.js';

export const VERSION = '树星数 v1 (P1h)';
export const FROZEN = '2026-10-14';
export const JACK_HEAVY = 0.42;   // jack180 share (same column, < 180 ms) at the ranked-chart 90th percentile
export const JACK_MAX_LN = 0.3;   // the 'about one dan low' finding is from rice (REFORM) charts; no hint on LN-heavy charts
export const SV_LIMIT = 0.10;
export const MOD_NAME = { 1: 'NoMod', 0.75: 'HT', 1.5: 'DT' };
export const POOL_MIN_ACTIONS = 3000;   // shorter charts are fast enough on one thread     // research rule: > 10 % of notes with scroll speed off the main speed by > 10 %
// rice / face items and the OD8 reading (research repo docs/rice-ln-od-r1-protocol-2026-10-15.md): conventions read off the
// same reference player, not crowd answers; the total star is unchanged.
//   item star = star + b * SUB_C * (theta*_item - theta*_all), b = tree star scale (1.6089), SUB_C = DT rule b_1.5
export const SUB_C = 1.1013;
export const SUB_MIN_ACTIONS = 50, SUB_MIN_SHARE = 0.05;   // subset actions, subset notes / all notes
export const FACE_LINE = 0.97;                               // face item: ScoreV2 at 97 % on LN heads + tails
export const OD9_FROM = 6.3;                                 // total star >= 6.3 (REFORM ALPHA) -> OD9, else OD8

export function subStar(star, thetaAll, thetaItem, b) {
  const k = b * SUB_C;
  return star + k * (thetaItem - thetaAll);
}

const FEATURE_LABEL = {
  od: 'OD', log_dur: '时长', n: '物件数', nps: '平均密度', ln_frac: '长条比例', nps_max_1000: '1 秒最高密度',
  nps_q95_1000: '1 秒密度（95% 分位）', nps_q75_1000: '1 秒密度（75% 分位）', nps_max_4000: '4 秒最高密度',
  nps_q95_4000: '4 秒密度（95% 分位）', nps_q75_4000: '4 秒密度（75% 分位）', nps_max_15000: '15 秒最高密度',
  nps_q95_15000: '15 秒密度（95% 分位）', nps_q75_15000: '15 秒密度（75% 分位）', chord_frac: '和弦比例', chord_size: '平均和弦大小',
  jack180: 'jack 比例（<180 ms）', jack120: 'jack 比例（<120 ms）', gap_same_q10: '同列最短间隔', gap_any_q10: '最短间隔',
  gap_any_med: '间隔中位数', col_imbalance: '列分布不均',
};

export async function createEngine({ ort, loadBytes, loadJson, makePool = null }) {
  const t0 = performance.now();
  const [R, tree, support, supportDt, onnx, patternItems] = await Promise.all([loadJson('model/reader.json'), loadJson('model/tree.json'),
    loadJson('model/support.json'), loadJson('model/support-dt.json'), loadBytes('model/encoder.onnx'), loadJson('model/pattern-items.json')]);
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const table = buildTable(R.t_nus, R.t_grid, R.t_c);
  const reader = new Reader(R, table, session, ort);
  const pool = makePool ? await makePool(R) : null;
  const eng = new Engine(R, tree, support, reader, performance.now() - t0);
  eng.supportDt = supportDt;
  eng.patternItems = patternItems;
  eng.pool = pool;
  return eng;
}

export class Engine {
  constructor(R, tree, support, reader, loadMs) {
    Object.assign(this, { R, tree, support, reader, loadMs });
  }

  // rate: 1 (NoMod), 0.75 (HT) or 1.5 (DT); see analysis/web-rate-r1/score_rate.py for the reference. Other constant rates
  // (0.5-2), hit 'hr' / 'ez' (windows / or x 1.4) and odOverride (lazer Difficulty Adjust: replaces the file OD in the
  // windows and the od feature) follow the same rules; reference analysis/web-tosu-r1/score_mods.py. The tree has seen
  // NoMod and 1.5x answers only.
  // withV2: the whole-chart 97 % ScoreV2 reading (LN dan estimate; ScoreV2 of every action, no re-judging) -> result.v2.
  // withSub: the experimental items (rice / face / OD8-OD9 re-judge) -> result.sub; implies withV2.
  // withItems: the key-pattern items (beta; NoMod 1.0x, no hit mod, file OD only) -> result.items, else result.items = null.
  async scoreBytes(bytes, { oszHasOsb = false, onProgress = null, withSegments = true, rate = 1, withSub = true, withV2 = true, hit = '',
    odOverride = null, withItems = true } = {}) {
    const t0 = performance.now();
    const text = new TextDecoder('utf-8').decode(bytes);
    const meta = metadata(text);
    const base = { title: meta.title, artist: meta.artist, version: meta.version, creator: meta.creator, beatmapId: meta.beatmapId,
      beatmapSetId: meta.beatmapSetId, md5: md5Hex(bytes), mode: meta.mode, keys: meta.keys };
    try {
      if (!Number.isFinite(rate) || rate < RATE_MIN || rate > RATE_MAX) throw new Error(`rate must be between ${RATE_MIN} and ${RATE_MAX}`);
      const r = await this.score(text, { oszHasOsb, onProgress, withSegments, rate, withSub, withV2: withV2 || withSub, hit, odOverride, withItems });
      return { ok: true, ...base, ...r, seconds: (performance.now() - t0) / 1000 };
    } catch (e) {
      const reason = e instanceof ChartError ? e.reason : 'parse_error';
      const msg = {
        not_mania: '不是 osu!mania 谱面，无法计算。', not_4k: '不是 4K 谱面，无法计算（只支持 4 键）。',
        too_few_notes: '物件少于 20 个，无法计算。',
      }[reason] || ('谱面文件解析失败：' + (e && e.message ? e.message : String(e)));
      return { ok: false, reason, message: msg, detail: String(e && e.message || e), rate, ...base };
    }
  }

  async score(text, { oszHasOsb, onProgress, withSegments, rate, withSub = true, withV2 = true, hit = '', odOverride = null, withItems = true }) {
    // 1. hand features (same order as the reference: parse_osu checks mode / keys / note count first); times / rate, file OD
    const pf = parseOsuFeat(text);
    if (odOverride !== null) pf.od = odOverride;
    const fn = prepareFeatureNotes(pf);
    if (rate !== 1) for (let i = 0; i < fn.s.length; i++) { fn.s[i] /= rate; fn.e[i] = fn.e[i] >= 0 ? fn.e[i] / rate : -1; }
    const F = feats(fn.s, fn.c, fn.e, fn.od);
    // 2. theta* from the encoder + reference-path second layer
    const chart = loadChart(text);
    const notes = chart.notes, od = odOverride !== null ? odOverride : chart.od;
    const tk = tokensFromNotes(notes, rate);
    const usePool = this.pool && tk.nActions >= POOL_MIN_ACTIONS;
    const { acc, v1a, lnV2, tapV2, ls } = await this.reader.perAction(tk, od, onProgress ? p => onProgress('encode', p) : null,
      usePool ? this.pool : null, rate, withSub || withV2, hit);
    const { theta, flag } = this.reader.theta(acc);
    // 3. tree
    const row = this.tree.columns.map(c => (c === 's29' ? theta : F[c]));
    const reading = predictTree(this.tree, row);
    const star = this.tree.star_scale.a + this.tree.star_scale.b * reading;
    // 4. whole-chart 97 % ScoreV2 reading (LN dan estimate), then the experimental rice / face items and the OD8 (OD9) reading
    const v2 = withSub || withV2 ? this.v2Reading({ tk, lnV2, tapV2, theta, star }) : null;
    const sub = withSub ? await this.subReadings({ tk, od, v1a, lnV2, tapV2, ls, theta, flag, star, rate, hit, pool: usePool ? this.pool : null, v2 }) : null;
    // 5. key-pattern items (beta): only where they were checked (NoMod 1.0x, file OD)
    const items = withItems && rate === 1 && hit === '' && odOverride === null
      ? await this.patternItemReadings({ tk, notes, od, v1a, ls, star, pool: usePool ? this.pool : null }) : null;
    // flags
    const sv = svFracSafe(text);
    const sb = sbLines(text);
    const reasons = [];
    // DT: ranges of the ranked charts played at 1.5x (support-dt.json); HT has no rate-specific answers -> the 1.0x ranges.
    // Other rates take the nearer of the two answered rates (above 1.25x -> the DT ranges).
    const dtRanges = rate > 1.25;
    const S = dtRanges ? this.supportDt : this.support;
    const onWhat = dtRanges ? '排名谱 DT 读数' : '排名谱';
    if (star > S.star.max) reasons.push(`星数高于所有${onWhat}的最高读数（${S.star.max.toFixed(2)}）`);
    if (flag.startsWith('censored')) reasons.push('难度超出参照水平路径的两端（读数被截断）');
    else if (theta < S.s29.min || theta > S.s29.max) reasons.push(`参照水平读数（θ*）超出${onWhat}范围`);
    for (const c of this.tree.columns) {
      if (c === 's29') continue;
      const r = S.features[c];
      const v = F[c];
      if (r && Number.isFinite(v) && (v < r.min || v > r.max)) reasons.push(`${FEATURE_LABEL[c] || c} 超出${onWhat}范围`);
    }
    const flags = { sv: sv !== null && sv > SV_LIMIT, svFrac: sv === null ? 0 : sv, storyboard: sb >= 1 || !!oszHasOsb, sbLines: sb,
      oszHasOsb: !!oszHasOsb, outOfRange: reasons.length > 0, outOfRangeReasons: reasons, jackHeavy: F.jack180 >= JACK_HEAVY && F.ln_frac < JACK_MAX_LN,
      jackShare: F.jack180, thetaFlag: flag };
    let segments = [], hardest = null;
    if (withSegments) {
      segments = this.reader.segments(v1a, tk);
      const use = segments.filter(s => !s.sparse && s.star !== null);
      const pool = use.length ? use : segments.filter(s => s.star !== null);
      for (const s of pool) if (!hardest || s.star > hardest.star) hardest = { startS: s.startS, endS: s.endS, star: s.star };
    }
    let tmax = 0;
    for (const n of notes) tmax = Math.max(tmax, n[1], n[0]);
    return { rate, hit, odOverride, star, reading, theta, thetaFlag: flag, nNotes: tk.nNotes, nActions: tk.nActions, od, durationS: tmax / 1000 / rate,
      features: F, acc: Array.from(acc), reliable: !(flags.sv || flags.storyboard || flags.outOfRange), flags, segments, hardest, v2, sub, items };
  }

  // key-pattern items (route A, arm C2; research repo analysis/web-items-r1/wi_ref.py): a second pass of the second layer with
  // the jack and burst-trill calibration terms on the same encoder outputs, then per-class readouts (pattern-items.js)
  async patternItemReadings({ tk, notes, od, v1a, ls, star, pool }) {
    const t0 = performance.now();
    const PI = this.patternItems;
    const cls = classifyNotes(notes);
    const cal = calibInputs(tk, PI);
    const v1c = new Float64Array(this.reader.P * tk.nActions);
    for (const l of ls) await this.reader.secondLayer(l, tk, od, v1c, pool, 1, '', cal);
    const r = itemReadouts({ PI, reader: this.reader, tk, cls, v1a, v1c, star });
    return { ...r, version: PI.version, ms: performance.now() - t0 };
  }

  // research repo analysis/rice-ln-od-r1/rlo_core.readings: rice = taps (not LN head, not release) on the ScoreV1 curve at 96 %;
  // face = LN heads + tails on the ScoreV2 curve at 97 %; OD = whole chart re-judged at OD8 (OD9 from 6.3 stars) at 96 % ScoreV1
  // LN line: the whole chart (taps + LN heads + tails) on the ScoreV2 curve at 97 %, file OD (ps_engine acc_v2 / rlo_core theta_v2_all)
  v2Reading({ tk, lnV2, tapV2, theta, star }) {
    const P = this.reader.P, A = tk.nActions, L = tk.lnH.length, b = this.tree.star_scale.b;
    const accV2 = new Float64Array(P);
    for (let p = 0; p < P; p++) {
      let s = tapV2[p];
      for (let j = 0; j < 2 * L; j++) s += lnV2[p * 2 * L + j];
      accV2[p] = s / A;
    }
    const { theta: v2Theta, flag: v2Flag } = this.reader.theta(accV2, FACE_LINE);
    return { theta: v2Theta, flag: v2Flag, star: subStar(star, theta, v2Theta, b) };
  }

  async subReadings({ tk, od, v1a, lnV2, tapV2, ls, theta, flag, star, rate, hit = '', pool, v2 = null }) {
    const t0 = performance.now();
    const P = this.reader.P, A = tk.nActions, L = tk.lnH.length, b = this.tree.star_scale.b;
    const head = new Uint8Array(A);
    for (const x of tk.lnH) head[x] = 1;
    let nRice = 0;
    for (let a = 0; a < A; a++) if (!tk.comp[a] && !head[a]) nRice++;
    const item = (ok, n, accFn, thr) => {
      if (!n) return { ok: false, n, theta: null, flag: 'empty', star: null };
      const { theta: t, flag: f } = this.reader.theta(accFn(), thr);
      return { ok, n, theta: t, flag: f, star: ok ? subStar(star, theta, t, b) : null };
    };
    const rice = item(nRice >= SUB_MIN_ACTIONS && nRice / tk.nNotes >= SUB_MIN_SHARE, nRice, () => {
      const acc = new Float64Array(P);
      for (let p = 0; p < P; p++) {
        let s = 0;
        for (let a = 0; a < A; a++) if (!tk.comp[a] && !head[a]) s += v1a[p * A + a];
        acc[p] = s / nRice;
      }
      return acc;
    });
    const face = item(2 * L >= SUB_MIN_ACTIONS && L / tk.nNotes >= SUB_MIN_SHARE, L, () => {
      const acc = new Float64Array(P);
      for (let p = 0; p < P; p++) {
        let s = 0;
        for (let j = 0; j < 2 * L; j++) s += lnV2[p * 2 * L + j];
        acc[p] = s / (2 * L);
      }
      return acc;
    }, FACE_LINE);
    if (!v2) v2 = this.v2Reading({ tk, lnV2, tapV2, theta, star });
    const odUsed = star >= OD9_FROM ? 9 : 8;
    let odTheta = theta, odFlag = flag;
    if (odUsed !== od) ({ theta: odTheta, flag: odFlag } = this.reader.theta(await this.reader.accAtOd(ls, tk, odUsed, pool, rate, hit)));
    const odItem = { od: odUsed, fileOd: od, theta: odTheta, flag: odFlag, star: subStar(star, theta, odTheta, b), changed: odUsed !== od };
    return { rice, face, od: odItem, v2, ms: performance.now() - t0 };
  }
}

function svFracSafe(text) {
  try { return svFrac(text); } catch (e) { return null; }
}
