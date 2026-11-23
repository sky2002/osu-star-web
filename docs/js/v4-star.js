import { danEstimate, fmtDanPos } from './dan-estimate.js';
import { selectDanReferences } from './dan-reference.js';
import { buildCopyText, fmtStar } from './ui-lib.js';
import { needsCnn, shiftedResult } from './new-star.js';
import { cardView as legacyView, cardCopyText as legacyCopy, v3ViewResult, oldStarView, v3FailText, fmtDelta } from './v3-star.js';

export const V4_VERSION = '星数 v4 测试版';
export const V4_FROZEN = '2026-11-23';
export const V4_REFERENCES = { version: 'v4-test', modelVersion: V4_VERSION, frozen: V4_FROZEN };
export const DOWNLOAD_SIZE = { first: '约 22.3 MB', v4: '约 6.13 MB' };
export const loadingText = () => `正在准备计算（首次${DOWNLOAD_SIZE.first}）…`;
export const MODEL_NOTE = () =>
  `默认使用星数 v4 测试版，首次计算会多下载${DOWNLOAD_SIZE.v4}。总星数已检验 NoMod 和 DT。选“对比 v3”可以同时看两版星数。`;
export const V4_UNTESTED_NOTE = '星数 v4 只核过 NoMod 和 DT（使用谱面文件 OD，且无 HR / EZ），当前设置的读数未经检验。';

export const STAR_MODELS = ['v4', 'v3', 'p1h', 'cnn36', 'both'];
export const DEFAULT_STAR_MODEL = 'v4';
export const MODEL_KEY = 'osu-star-web.model.v4';

export function needsV4(mode) { return mode === 'v4' || mode === 'both'; }
export function needsV3(mode) { return mode === 'v3' || mode === 'both'; }

export function loadStarModel(storage) {
  try {
    const mode = storage?.getItem(MODEL_KEY);
    return STAR_MODELS.includes(mode) ? mode : DEFAULT_STAR_MODEL;
  } catch { return DEFAULT_STAR_MODEL; }
}

export function saveStarModel(storage, mode) {
  try { if (STAR_MODELS.includes(mode)) storage?.setItem(MODEL_KEY, mode); } catch { /* 浏览器禁用存储时仍可切换。 */ }
}

function usableV4(v) { return v?.ok === true && Number.isFinite(v.star); }

export function scoreRequest(have, mode, withSub) {
  if (have && !have.ok) return null;
  const wantsV4 = needsV4(mode);
  const fallback = wantsV4 && have?.v4Computed && !usableV4(have.v4);
  const needsLegacy = !wantsV4 || !!fallback;
  const withV4 = wantsV4 && !have?.v4Computed;
  const withV3 = (needsV3(mode) || !!fallback) && !have?.v3Computed;
  const withCnn = needsCnn(mode) && !have?.cnnComputed;
  if (!have || (withSub && !have.subComputed) || (needsLegacy && !have.legacyComputed)) {
    return { type: 'score', withSub, withItems: needsLegacy, withSegments: needsLegacy, withV4, withV3, withCnn };
  }
  if (withV4) return { type: 'v4' };
  if (withV3) return { type: 'v3' };
  if (withCnn) return { type: 'cnn' };
  return null;
}

export function v4ViewResult(raw) {
  if (!raw?.ok || !usableV4(raw.v4)) return null;
  const v = raw.v4;
  const view = shiftedResult(raw, {
    model: 'v4', star: v.star, reading: v.reading, reasons: v.outOfRangeReasons,
    extraOutOfRange: !!v.outOfRange, dropBase: true,
    extra: { untested: !!v.untested, theta: v.theta, thetaFlag: v.thetaFlag, segments: v.segments, hardest: v.hardest },
  });
  view.items = null;
  return view;
}

export function cardView(raw, mode) {
  if (!raw?.ok || !needsV4(mode)) return legacyView(raw, mode);
  const v4 = v4ViewResult(raw);
  if (v4 && mode !== 'both') return { raw, r: v4 };
  const v3 = v3ViewResult(raw);
  if (v4) return { raw, r: v4, comparison: v3, comparisonMessage: v3 ? '' : v3FailText(raw.v3) };
  const reason = raw.v4?.text || '星数 v4 暂无读数。';
  return { raw, r: v3 || raw, notice: `${reason} 当前显示 ${v3 ? '星数 v3' : 'P1h 旧版'}。` };
}

export function comparisonView(cv, refs) {
  return oldStarView(cv.comparison, cv.r, refs);
}

export function cardCopyText(cv, refs, v3Refs, opts) {
  const r = cv.r;
  if (r?.model !== 'v4') return legacyCopy(cv, refs, v3Refs, opts);
  const { header, name, ladderLine = null, withSub = false } = opts || {};
  const version = { version: V4_VERSION, frozen: V4_FROZEN };
  const lines = [buildCopyText(r, header, name, version, selectDanReferences(r, refs), ladderLine, withSub, danEstimate(r, refs))];
  if (r.untested) lines.push(`提示：${V4_UNTESTED_NOTE}`);
  const comparison = comparisonView(cv, v3Refs);
  if (comparison) {
    const { star, delta, reliable, dan } = comparison;
    lines.push(`星数 v3 对比：${fmtStar(star)}（${fmtDelta(delta)}）${reliable ? '' : '（不可靠）'}`);
    if (dan?.rice) lines.push(`  v3 米段位（按整段）：${dan.rice.text}，位置 ${fmtDanPos(dan.rice.loc, 'reform')}`);
    if (dan?.single) lines.push(`  v3 米段位（按单曲）：${dan.single.text}，${dan.single.note}`);
  } else if (cv.comparisonMessage) lines.push(`星数 v3 对比：${cv.comparisonMessage}`);
  return lines.join('\n');
}
