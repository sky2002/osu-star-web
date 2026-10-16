// 米段位 / 面段位估计（纯函数，不碰 DOM，Node 里可直接 import 测试）。
// 米段位：这张谱的总星数（96% ScoreV1）对 REFORM 1st…Eta 段位谱（Marathon 整段，不含 INTRO）的同标准读数。
// 面段位：这张谱的整谱 97% ScoreV2 读数对 LN Dan Courses v2 5th…15th（Marathon 整段）的同标准读数；4 段及以下不用。
// 规则（研究仓库 docs/dan-estimate-r1-results-2026-10-15.md；段内方位词按 benchmark runner.md §3.1）：
//   1. 参照读数按段位顺序做单调化（pool-adjacent-violators，违序的相邻段合并成一档，读数取平均）；
//   2. 相邻两档读数差 < DAN_MERGE_GAP（重训波动量级）时合并成一档；REFORM 3rd 用替代锚读数（见下）后 2nd/3rd
//      自然分开，LN 14th–15th（读数差 0.038）仍合并为“14th–15th”；
//   3. 谱面读数落在两档之间：线性插值位置，取最近的档位锚点，按偏差给段内方位词（左开右闭）：(−0.5,−0.3]=low、
//      (−0.3,−0.1]=mid/low、(−0.1,+0.1]=mid、(+0.1,+0.3]=mid/high、(+0.3,+0.5]=high；括号数值保留两位小数；
//   4. 高于最高档：“!17+”（!+刻度上限，米 17=Eta、LN 15）；低于最低档：“1st 以下”/“LN5 以下”。

export const DAN_MERGE_GAP = 0.05;
// REFORM 3rd 的替代锚读数：原始 3rd 与 2nd 的读数只差 0.016 星（重训波动内，会触发合并成“2nd–3rd”且无法插值），
// benchmark（runner/map.mjs）改用同模型的 3dan 谱（REFORM 1st Pack v2 (DDMythical) ~ 3rd ~，reliable）作 3rd 档锚点。
export const DAN_REFORM_3RD_SUBSTITUTE_STAR = 3.0585190895872016;
// 长条很少：长条数 / 物件数 < 0.15 时面段位变灰（Mixed 估计器把 ≤0.15 判为米图；REFORM 等米图参照的 95% 分位 0.143，
// LN 段位谱最低 0.245；研究仓库 docs/analysis/rice-ln-classification-2026-10-11/README.md §1.2、§4.1）
export const DAN_LN_FEW = 0.15;
export const LN_MIN_DAN = 5;

const REFORM_ORDER = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
const REFORM_SHORT = { alpha: 'Alpha', beta: 'Beta', gamma: 'Gamma', delta: 'Delta', epsilon: 'Epsilon', zeta: 'Zeta', eta: 'Eta' };
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

export const DAN_ESTIMATE_NOTE =
  '米 / 面段位：把这张谱和 REFORM / LN 段位谱用同一模型、同一标准比较，看它排在哪两段之间；不代表能通过对应段位。' +
  '米按总星数（96% ScoreV1）和 REFORM 1st–Eta 比；面按整张谱 97% ScoreV2 的读数和 LN 5th–15th 比（LN 4 段及以下社区没有定论，不用）。';
export const DAN_RATE_NOTE = (mod) => `${mod}：用这个倍速下的读数和 NoMod 段位谱比较，段位谱本身不变速。`;
export const DAN_FEW_LN_NOTE = '长条很少，仅供参考';
export const DAN_UNRELIABLE_NOTE = '星数不可靠，段位也不可靠';

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
      // 3rd 用替代锚读数（原始 3rd 与 2nd 只差 0.016 星，无法插值）
      pts.push({ pos: i + 1, label: REFORM_SHORT[k] || k, star: k === '3rd' ? DAN_REFORM_3RD_SUBSTITUTE_STAR : e.star });
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

/** 位置 → 段内方位词。相对最近档位锚点 d，左开右闭：(−0.5,−0.3]=low、(−0.3,−0.1]=mid/low、(−0.1,+0.1]=mid、
 *  (+0.1,+0.3]=mid/high、(+0.3,+0.5]=high。prefix：'' 或 'LN'（档名去序数后缀，如 “8th–9th” → “LN8-9”）；
 *  量程外不判方位：上方 “!刻度上限+”，下方 “X 以下”。 */
export function danText(loc, { prefix = '' } = {}) {
  if (!loc) return '暂无';
  const L = (t) => prefix + (prefix ? t.label.replace(/(\d+)(st|nd|rd|th)/g, '$1') : t.label);
  const p = loc.pos.toFixed(2);
  if (loc.kind === 'below') return `${L(loc.hi)} 以下`;
  if (loc.kind === 'above') return `!${loc.lo.members[loc.lo.members.length - 1].pos}+`;   // 量程上方：!刻度上限+，不渲染外推数字
  const E = 5e-7;
  const dLo = loc.pos - loc.lo.pos, dHi = loc.hi.pos - loc.pos;
  const near = dLo <= dHi + E ? loc.lo : loc.hi;   // ±0.5 接缝归下档（下档 high 含 +0.5，上档 low 不含 −0.5）
  const d = loc.pos - near.pos;
  const q = d <= -0.3 + E ? 'low' : d <= -0.1 + E ? 'mid/low' : d <= 0.1 + E ? 'mid' : d <= 0.3 + E ? 'mid/high' : 'high';
  return `${L(near)} ${q}（${p}）`;
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
 * 返回 null（没有读数或没有参照）或 { rice, face, unreliable, rateNote }，rice / face 为
 *   { group, label, text, loc, muted, note }。
 */
export function danEstimate(result, data) {
  if (!result || result.ok !== true || !Number.isFinite(result.star) || !data) return null;
  const unreliable = result.reliable === false;
  const riceTiers = danTiers(danPoints(data, 'reform'));
  const lnTiers = danTiers(danPoints(data, 'ln'));
  const riceLoc = locateDan(result.star, riceTiers);
  const rice = riceLoc && { group: 'reform', label: '米', text: danText(riceLoc), loc: riceLoc, muted: false, note: '' };
  let face = null;
  const v2 = result.v2 && Number.isFinite(result.v2.star) ? result.v2.star : null;
  const lnFrac = Number.isFinite(result.lnFrac) ? result.lnFrac : (result.features && Number.isFinite(result.features.ln_frac) ? result.features.ln_frac : null);
  if (v2 !== null && lnTiers.length) {
    const loc = locateDan(v2, lnTiers);
    const few = lnFrac !== null && lnFrac < DAN_LN_FEW;
    face = { group: 'ln', label: '面', text: danText(loc, { prefix: 'LN' }), loc, muted: few, note: few ? DAN_FEW_LN_NOTE : '' };
  }
  const rate = result.rate || 1;
  const rateNote = rate === 1 ? '' : DAN_RATE_NOTE(rate === 1.5 ? 'DT' : rate === 0.75 ? 'HT' : `${rate} 倍`);
  return { rice, face, unreliable, rateNote };
}

/** 「复制读数信息」里的段位行。 */
export function danEstimateCopyLines(est) {
  if (!est) return [];
  const lines = [];
  const tag = est.unreliable ? '（不可靠）' : '';
  if (est.rice) lines.push(`米段位：${est.rice.text}${tag}；位置 ${fmtDanPos(est.rice.loc, 'reform')}`);
  if (est.face) lines.push(`面段位：${est.face.text}${est.face.note ? `（${est.face.note}）` : ''}${tag}；位置 ${fmtDanPos(est.face.loc, 'ln')}`);
  else lines.push('面段位：暂无（没有整谱 97% ScoreV2 读数）');
  if (est.rateNote) lines.push(est.rateNote);
  return lines;
}
