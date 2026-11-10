// 星数 v3（测试版，默认）：星数模型开关、结果卡视图、“两个都看”里的旧版星数块、复制读数信息（纯函数，Node 里可直接 import）。
import { danEstimate, fmtDanPos } from './dan-estimate.js';
import { selectDanReferences } from './dan-reference.js';
import { buildCopyText, fmtStar } from './ui-lib.js';
import { shiftedResult, cnnViewResult, CNN_OFF_HINT, CNN_VERSION, CNN_FROZEN } from './new-star.js';

export const V3_VERSION = '星数 v3 测试版';
export const V3_FROZEN = '2026-11-10';
// data/dan-references-v3.json 的表头必须是这三项
export const V3_REFERENCES = { version: 'v3-test', modelVersion: V3_VERSION, frozen: V3_FROZEN };
export const P1H_LABEL = '树星数 v1 (P1h)';

// 首次下载体积：页面顶部状态条和“模型”开关下面那行小字都从这里取。
// first：默认模式（v3）首次打开实际下载的总量；v3：v3 的模型文件合计。
export const DOWNLOAD_SIZE = { first: '约 20 MB', v3: '约 3.3 MB' };
export const loadingText = () => `正在加载模型（首次${DOWNLOAD_SIZE.first}）…`;
export const MODEL_NOTE = () =>
  `星数 v3 是测试版的新模型，现在是默认；只核过 NoMod 和 DT（第一次用要下载${DOWNLOAD_SIZE.v3}）。` +
  '想对比可以选“两个都看”，想看以前的星数选“P1h 旧版”。说明见下方“星数 v3（测试版）”。';

// 页面最上面的“模型”开关：v3（默认）、P1h 旧版、CNN36（测试版）、两个都看（v3 为主，旁边并排旧版星数）
export const STAR_MODELS = ['v3', 'p1h', 'cnn36', 'both'];
export const DEFAULT_STAR_MODEL = 'v3';
// 换了新键：以前点过 P1h 的访客也落到新默认上
export const MODEL_KEY = 'osu-star-web.model.v3';
export function needsV3(mode) { return mode === 'v3' || mode === 'both'; }

export function loadStarModel(storage) {
  try {
    const v = storage && storage.getItem(MODEL_KEY);
    return STAR_MODELS.includes(v) ? v : DEFAULT_STAR_MODEL;
  } catch { return DEFAULT_STAR_MODEL; }
}
export function saveStarModel(storage, v) {
  try { if (storage && STAR_MODELS.includes(v)) storage.setItem(MODEL_KEY, v); } catch { /* 不记住也没关系 */ }
}

export const V3_UNTESTED_NOTE = '星数 v3 只核过 NoMod 和 DT（谱面文件 OD），这个设置下的读数未经检验';
export const V3_OFF_HINT = '切到“P1h 旧版”可以看旧版星数。';

/** v3 没算出来时给人看的原因。 */
export function v3FailText(v3) {
  if (!v3) return '这张谱没有星数 v3 的读数';
  if (v3.reason === 'load_error') return v3.text || '星数 v3 的模型没有加载成功';
  return v3.text || '星数 v3 计算出错';
}

/** 只看 v3 时结果卡用的结果：总星数换成 v3，挂在总星数上的读数按差平移。没有 v3 或 v3 失败时返回 null。 */
export function v3ViewResult(r) {
  if (!r || !r.ok || !r.v3 || !r.v3.ok || !Number.isFinite(r.v3.star)) return null;
  const v = r.v3;
  return shiftedResult(r, {
    model: 'v3', star: v.star, reading: v.reading,
    reasons: v.outOfRangeReasons || [], extraOutOfRange: !!v.outOfRange, dropBase: true,
    extra: { untested: !!v.untested, theta: v.theta, thetaFlag: v.thetaFlag },
  });
}

/**
 * 结果卡按开关怎么显示。raw = worker 回来的 P1h 结果（可能带 v3、cnn）。返回（另带原样的 raw）：
 *   r       卡片上用的结果（v3 / CNN36 视图，或原样的 P1h）
 *   fail    整卡只显示这句（选了 v3 或 CNN36 但它没算出来）
 *   notice  卡片上加的一句（两个都看但 v3 没算出来，退回旧版星数）
 *   old     true 时卡片里加一块“旧版星数（P1h）”
 */
export function cardView(raw, mode) { return { raw, ...cardViewOf(raw, mode) }; }
function cardViewOf(raw, mode) {
  if (!raw || !raw.ok) return { r: raw };
  if (mode === 'cnn36') {
    const c = cnnViewResult(raw);
    return c ? { r: c } : { r: raw, fail: `CNN36：${(raw.cnn && raw.cnn.text) || '这张谱没有新星数'}。${CNN_OFF_HINT}` };
  }
  if (mode === 'v3') {
    const v = v3ViewResult(raw);
    const t = v3FailText(raw.v3);   // 原因文字本身没带“星数 v3”时补上
    return v ? { r: v } : { r: raw, fail: `${t.startsWith('星数 v3') ? t : '星数 v3：' + t}。${V3_OFF_HINT}` };
  }
  if (mode === 'both') {
    const v = v3ViewResult(raw);
    return v ? { r: v, old: true } : { r: raw, notice: `星数 v3 没有算出来（${v3FailText(raw.v3)}），这张卡显示的是旧版（P1h）星数。` };
  }
  return { r: raw };
}

/**
 * “两个都看”里的旧版星数块：raw = P1h 结果，main = 上面显示的 v3 视图，refs = P1h 的段位参照（可为 null）。
 * 返回 { star, delta（旧版 − 上面）, reliable, dan }；dan 只用米段位（整段、按单曲）。
 */
export function oldStarView(raw, main, refs) {
  if (!raw || !raw.ok || !main || !Number.isFinite(raw.star)) return null;
  const dan = refs ? danEstimate(raw, refs) : null;
  return { star: raw.star, delta: raw.star - main.star, reliable: raw.reliable !== false, dan };
}

const signed = (d) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}`;
export function fmtDelta(d) { return `比上面 ${signed(d)}`; }

/** 「复制读数信息」末尾的旧版星数几行。 */
export function oldStarCopyLines(view, p1hVer) {
  if (!view) return [];
  const ver = p1hVer && p1hVer.version ? `${p1hVer.version}，冻结 ${p1hVer.frozen || '未知'}` : P1H_LABEL;
  const lines = [`旧版星数（${ver}）：${fmtStar(view.star)}（${fmtDelta(view.delta)}）${view.reliable ? '' : '（不可靠）'}`];
  const d = view.dan;
  if (d && d.rice) lines.push(`  旧版米段位：${d.rice.text}；位置 ${fmtDanPos(d.rice.loc, 'reform')}`);
  if (d && d.single) lines.push(`  旧版米段位（按单曲换算）：${d.single.text}；${d.single.note}`);
  return lines;
}

/** 复制文本里的“版本”一行跟着卡片上的星数走。 */
export function copyVersion(r, p1hVer) {
  if (r && r.model === 'v3') return { version: V3_VERSION, frozen: V3_FROZEN };
  if (r && r.model === 'cnn36') return { version: CNN_VERSION, frozen: CNN_FROZEN };
  return p1hVer;
}

/**
 * 整段复制文本。cv = cardView 的返回；refs = 卡片上那个星数用的段位参照；oldRefs = P1h 段位参照（“两个都看”用）。
 * opts: { header, name, p1hVer, ladderLine, withSub }
 */
export function cardCopyText(cv, refs, oldRefs, opts) {
  const { header, name, p1hVer, ladderLine = null, withSub = false } = opts || {};
  const r = cv.r;
  let text = buildCopyText(r, header, name, copyVersion(r, p1hVer), selectDanReferences(r, refs), ladderLine, withSub, danEstimate(r, refs));
  const extra = [];
  if (cv.fail) extra.push(`提示：${cv.fail}`);
  if (cv.notice) extra.push(`提示：${cv.notice}`);
  if (r && r.ok && r.model === 'v3' && r.untested) extra.push(`提示：${V3_UNTESTED_NOTE}`);
  if (cv.old) extra.push(...oldStarCopyLines(oldStarView(cv.raw, r, oldRefs), p1hVer));
  if (extra.length) text += '\n' + extra.join('\n');
  return text;
}
