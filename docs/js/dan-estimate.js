// 米段位 / 面段位估计（纯函数，不碰 DOM，Node 里可直接 import 测试）。
// 米段位：这张谱的总星数（96% ScoreV1）对 REFORM 1st…Eta 段位谱（Marathon 整段，不含 INTRO）的同标准读数。
// 面段位：这张谱的整谱 97% ScoreV2 读数对 LN Dan Courses v2 6th…15th（Marathon 整段）的同标准读数；5 段及以下不用。
// 规则（研究仓库 docs/dan-estimate-r1-results-2026-10-15.md）：
//   1. 参照读数按段位顺序做单调化（pool-adjacent-violators，违序的相邻段合并成一档，读数取平均）；
//   2. 相邻两档读数差 < DAN_MERGE_GAP（重训波动量级）时合并成一档，例如 REFORM 2nd 2.88 / 3rd 2.90 → “2nd–3rd”；
//   3. 谱面读数落在两档之间：线性插值位置，离某档 15% 以内写“≈ 该档”，否则前三分之一“偏下一档”、后三分之一“偏上一档”、中间“居中”；
//   4. 高于最高档：“高于 Eta（外推）”；低于最低档：“低于 1st”/“LN 6 段以下”。
// 米段位第二行“按单曲换算”：同一张谱的总星数对 REFORM 官方单曲（data.reformSingles，60 首，1st–Zeta 每段 2–6 首）
// 按段取平均的读数，再走上面同一套规则 1–4。Eta 没有单曲，高于 Zeta 的部分按最后两档外推。主读数仍是整段那一行。
// 依据：研究仓库 analysis/bias-multidim-r1/A（实验 A 的 S4 单曲尺子，同一套 PAV + 线性插值 / 外推）。

export const DAN_MERGE_GAP = 0.05;
// 长条很少：长条数 / 物件数 < 0.15 时面段位变灰（Mixed 估计器把 ≤0.15 判为米图；REFORM 等米图参照的 95% 分位 0.143，
// LN 段位谱最低 0.245；研究仓库 docs/analysis/rice-ln-classification-2026-10-11/README.md §1.2、§4.1）
export const DAN_LN_FEW = 0.15;
export const LN_MIN_DAN = 6;
// 读数离某一档很近（两档间距的 15% 以内）时直接写“≈ 该档”，例如段位谱读它自己显示“≈ LN 9th”
export const DAN_AT = 0.15;

export const REFORM_ORDER = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
const REFORM_SHORT = { alpha: 'Alpha', beta: 'Beta', gamma: 'Gamma', delta: 'Delta', epsilon: 'Epsilon', zeta: 'Zeta', eta: 'Eta' };
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

export const DAN_ESTIMATE_NOTE =
  '米 / 面段位：把这张谱和 REFORM / LN 段位谱用同一模型、同一标准比较，看它排在哪两段之间；不代表能通过对应段位。' +
  '米按总星数（96% ScoreV1）和 REFORM 1st–Eta 比；面按整张谱 97% ScoreV2 的读数和 LN 6th–15th 比（LN 5 段及以下社区没有定论，不用）。';
export const DAN_RATE_NOTE = (mod) => `${mod}：用这个倍速下的读数和 NoMod 段位谱比较，段位谱本身不变速。`;
export const DAN_FEW_LN_NOTE = '长条很少，仅供参考';
export const DAN_UNRELIABLE_NOTE = '星数不可靠，段位也不可靠';
export const DAN_SINGLE_LABEL = '米段位（按单曲）';
// 每段只有 2–6 首单曲，含不含叠单曲两种做法最多差 0.17 段
export const DAN_SINGLE_NOTE = '误差约 ±0.15 段';
export const DAN_SINGLE_TITLE =
  '按 REFORM 官方单曲换算：每段 2–6 首（共 60 首）单曲的平均读数当尺子，同一模型、同一标准，读法和上面的米段位一样。' +
  '整段比单曲长、读数偏高，所以单曲按整段换算会显得低一点，这一行给的是按单曲比的结果。每段单曲少，误差约 ±0.15 段；Eta 没有单曲，高于 Zeta 的部分是外推。';

/** REFORM 官方单曲 → 每段一个点 [{ pos, label, star 该段单曲读数的平均 }]（按段位顺序；没有单曲的段不出点）。 */
export function singlePoints(data) {
  const s = data && data.reformSingles;
  if (!s || !Array.isArray(s.entries)) return [];
  const by = new Map();
  for (const e of s.entries) {
    const i = REFORM_ORDER.indexOf(e && e.dan);
    if (i < 0 || !Number.isFinite(e.star)) continue;
    const a = by.get(i) || { n: 0, sum: 0 };
    a.n++; a.sum += e.star;
    by.set(i, a);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0])
    .map(([i, a]) => ({ pos: i + 1, label: REFORM_SHORT[REFORM_ORDER[i]] || REFORM_ORDER[i], star: a.sum / a.n }));
}

/** 段位参照 → 有序点 [{ pos, label, star }]。group 'reform' 用 star（96% ScoreV1），'ln' 用 starV2（97% ScoreV2），6 段起。 */
export function danPoints(data, group) {
  if (!data || !Array.isArray(data.groups)) return [];
  const g = data.groups.find((x) => x.id === group);
  if (!g) return [];
  const pts = [];
  for (const e of g.entries) {
    if (group === 'reform') {
      const k = e.id.slice('reform-'.length);
      const i = REFORM_ORDER.indexOf(k);
      if (i < 0 || !Number.isFinite(e.star)) continue;   // INTRO 不用
      pts.push({ pos: i + 1, label: REFORM_SHORT[k] || k, star: e.star });
    } else if (group === 'ln') {
      const n = Number(e.id.slice('ln-'.length));
      if (!(n >= LN_MIN_DAN) || !Number.isFinite(e.starV2)) continue;
      pts.push({ pos: n, label: ordinal(n), star: e.starV2 });
    }
  }
  return pts.sort((a, b) => a.pos - b.pos);
}

/** 单调化：pool-adjacent-violators（等权）。返回档 [{ members:[点…], star 平均, pos 平均 }]，star 严格不降。 */
export function poolAdjacent(points) {
  const blocks = [];
  for (const p of points) {
    blocks.push({ members: [p], sum: p.star });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.members.length <= b.sum / b.members.length) break;
      blocks.pop();
      a.members.push(...b.members); a.sum += b.sum;
    }
  }
  return blocks.map(finishTier);
}

function finishTier(b) {
  const m = b.members;
  const star = m.reduce((s, x) => s + x.star, 0) / m.length;
  const pos = m.reduce((s, x) => s + x.pos, 0) / m.length;
  const label = m.length === 1 ? m[0].label : `${m[0].label}–${m[m.length - 1].label}`;
  return { members: m, star, pos, label, merged: m.length > 1 };
}

/** 段位档：单调化后，相邻读数差 < gap 的档继续合并（链式，左到右）。 */
export function danTiers(points, gap = DAN_MERGE_GAP) {
  const out = [];
  for (const t of poolAdjacent(points)) {
    const last = out[out.length - 1];
    if (last && t.star - last.star < gap) {
      const members = [...last.members, ...t.members];
      out[out.length - 1] = finishTier({ members });
    } else out.push(t);
  }
  return out;
}

/**
 * 读数在段位档里的位置。返回
 *   { kind: 'below' | 'between' | 'above', lo, hi (档), frac (0–1，between 时), lean: 'lo' | 'mid' | 'hi',
 *     pos: 小数段位位置（between 时线性插值；两端按最近两档的斜率外推，extrapolated=true） }
 */
export function locateDan(star, tiers) {
  if (!Number.isFinite(star) || !tiers || !tiers.length) return null;
  const first = tiers[0], last = tiers[tiers.length - 1];
  const slopeAt = (a, b) => (b.pos - a.pos) / (b.star - a.star);
  if (tiers.length === 1) {
    if (star === first.star) return { kind: 'between', lo: first, hi: first, frac: 0, lean: 'mid', pos: first.pos, extrapolated: false };
    return { kind: star < first.star ? 'below' : 'above', lo: first, hi: first, pos: first.pos, extrapolated: true };
  }
  if (star < first.star) {
    return { kind: 'below', lo: null, hi: first, pos: first.pos - (first.star - star) * slopeAt(first, tiers[1]), extrapolated: true };
  }
  if (star > last.star) {
    return { kind: 'above', lo: last, hi: null, pos: last.pos + (star - last.star) * slopeAt(tiers[tiers.length - 2], last), extrapolated: true };
  }
  let i = 0;
  while (i < tiers.length - 2 && star > tiers[i + 1].star) i++;
  const lo = tiers[i], hi = tiers[i + 1];
  const frac = (star - lo.star) / (hi.star - lo.star);
  const lean = frac < 1 / 3 ? 'lo' : frac > 2 / 3 ? 'hi' : 'mid';
  return { kind: 'between', lo, hi, frac, lean, pos: lo.pos + frac * (hi.pos - lo.pos), extrapolated: false };
}

/** 位置 → 一句白话，例如“7th–8th 之间（偏 8th）”。prefix：'' 或 'LN '。 */
export function danText(loc, { prefix = '', belowText = null } = {}) {
  if (!loc) return '暂无';
  const L = (t) => prefix + t.label;
  if (loc.kind === 'below') return belowText || `低于 ${L(loc.hi)}`;
  if (loc.kind === 'above') return `高于 ${L(loc.lo)}（外推）`;
  if (loc.frac <= DAN_AT) return `≈ ${L(loc.lo)}`;
  if (loc.frac >= 1 - DAN_AT) return `≈ ${L(loc.hi)}`;
  const single = !loc.lo.merged && !loc.hi.merged;
  const span = single ? `${prefix}${loc.lo.label}–${loc.hi.label} 之间` : `${L(loc.lo)} 与 ${L(loc.hi)} 之间`;
  const lean = loc.lean === 'mid' ? '居中' : `偏 ${(loc.lean === 'lo' ? loc.lo : loc.hi).label}`;
  return `${span}（${lean}）`;
}

/** 小数位置的显示：REFORM 11–17 = Alpha–Eta；LN 直接用段数。 */
export function fmtDanPos(loc, group) {
  if (!loc || !Number.isFinite(loc.pos)) return '';
  const p = loc.pos.toFixed(2);
  const tail = group === 'reform' ? '（1st=1 … 10th=10，Alpha=11 … Eta=17）' : '（LN 段数）';
  return `${loc.extrapolated ? '约 ' : ''}${p}${loc.extrapolated ? '，外推' : ''}${tail}`;
}

/**
 * 一张结果卡的米 / 面段位。result 需有 ok、star、reliable、rate、v2.star、lnFrac（或 features.ln_frac）。
 * 返回 null（没有读数或没有参照）或 { rice, single, face, unreliable, rateNote }，rice / single / face 为
 *   { group, label, text, loc, muted, note }；single 是米段位的第二行“按单曲换算”，参照里没有单曲时为 null。
 */
export function danEstimate(result, data) {
  if (!result || result.ok !== true || !Number.isFinite(result.star) || !data) return null;
  const unreliable = result.reliable === false;
  const riceTiers = danTiers(danPoints(data, 'reform'));
  const lnTiers = danTiers(danPoints(data, 'ln'));
  const riceLoc = locateDan(result.star, riceTiers);
  const rice = riceLoc && { group: 'reform', label: '米', text: danText(riceLoc), loc: riceLoc, muted: false, note: '' };
  const singleTiers = danTiers(singlePoints(data));
  const singleLoc = rice && singleTiers.length >= 2 ? locateDan(result.star, singleTiers) : null;
  const single = singleLoc && { group: 'reform', label: DAN_SINGLE_LABEL, text: danText(singleLoc), loc: singleLoc, muted: false, note: DAN_SINGLE_NOTE };
  let face = null;
  const v2 = result.v2 && Number.isFinite(result.v2.star) ? result.v2.star : null;
  const lnFrac = Number.isFinite(result.lnFrac) ? result.lnFrac : (result.features && Number.isFinite(result.features.ln_frac) ? result.features.ln_frac : null);
  if (v2 !== null && lnTiers.length) {
    const loc = locateDan(v2, lnTiers);
    const few = lnFrac !== null && lnFrac < DAN_LN_FEW;
    face = { group: 'ln', label: '面', text: danText(loc, { prefix: 'LN ', belowText: `LN ${LN_MIN_DAN} 段以下` }), loc, muted: few, note: few ? DAN_FEW_LN_NOTE : '' };
  }
  const rate = result.rate || 1;
  const rateNote = rate === 1 ? '' : DAN_RATE_NOTE(rate === 1.5 ? 'DT' : rate === 0.75 ? 'HT' : `${rate} 倍`);
  return { rice, single, face, unreliable, rateNote };
}

/** 「复制读数信息」里的段位行。 */
export function danEstimateCopyLines(est) {
  if (!est) return [];
  const lines = [];
  const tag = est.unreliable ? '（不可靠）' : '';
  if (est.rice) lines.push(`米段位：${est.rice.text}${tag}；位置 ${fmtDanPos(est.rice.loc, 'reform')}`);
  // 复制文本里这一行的写法固定为“米段位（按单曲换算）”，不跟结果卡上的标签 DAN_SINGLE_LABEL 走
  if (est.single) lines.push(`米段位（按单曲换算）：${est.single.text}${tag}；${est.single.note}；位置 ${fmtDanPos(est.single.loc, 'reform')}`);
  if (est.face) lines.push(`面段位：${est.face.text}${est.face.note ? `（${est.face.note}）` : ''}${tag}；位置 ${fmtDanPos(est.face.loc, 'ln')}`);
  else lines.push('面段位：暂无（没有整谱 97% ScoreV2 读数）');
  if (est.rateNote) lines.push(est.rateNote);
  return lines;
}
