// 新星数（测试版）：页面最上面选“CNN36”或“两个都看”时，多给一个读数，方便和现在的星数对比、收集意见（纯函数，Node 里可直接 import）。
// 模型：P1h 同一配方的树多一列 CNN36 读数（一个直接看整张谱按键网格的小卷积网络，10 个模型 × 原谱 / 镜像取平均），
// 20 棵树取平均。研究仓库 docs/cnn36-web-r1-results-2026-10-25.md。只核过 NoMod 和 DT（谱面文件 OD）。
import { danEstimate, fmtDanPos } from './dan-estimate.js';

export const CNN_VERSION = '树星数 v2 测试版（P1h 配方＋CNN36）';
export const CNN_FROZEN = '2026-10-25';
export const CNN_RATES = [1, 1.5];
export const CNN_REFERENCES = { version: 'CNN36-test', modelVersion: CNN_VERSION, frozen: CNN_FROZEN };

// 页面最上面的“星数模型”开关：只看现行 P1h、只看 CNN36、两个都看（P1h 为主，CNN36 在结果卡里并排）
export const STAR_MODELS = ['p1h', 'cnn36', 'both'];
export function needsCnn(mode) { return mode === 'cnn36' || mode === 'both'; }
export const CNN_OFF_HINT = '切到“P1h”可以看现行星数。';

/**
 * 只看 CNN36 时结果卡用的结果：总星数换成新星数；挂在总星数上的读数（LN 口径、米 / 面 / OD 分项、键型分项★）按同一个差平移，
 * 和它们的定义一致（分项★ = 总星数 + 常数 ×（分项 θ − 整谱 θ），研究仓库 rice-ln-od r1、路线 A）；分段曲线不挂在总星数上，不变。
 * “超出排名谱范围”里星数上限一条换成新星数自己的。没有新星数（HT、自定义 OD、加载失败）时返回 null。
 */
export function cnnViewResult(r) {
  if (!r || !r.ok || !r.cnn || !r.cnn.ok) return null;
  const c = r.cnn, d = c.star - r.star;
  const sh = (x) => (x && Number.isFinite(x.star) ? { ...x, star: x.star + d } : x);
  const out = { ...r, model: 'cnn36', p1hStar: r.star, star: c.star, reading: c.reading, v2: sh(r.v2) };
  if (r.sub) out.sub = { ...r.sub, rice: sh(r.sub.rice), face: sh(r.sub.face), od: sh(r.sub.od), v2: sh(r.sub.v2) };
  if (r.items && r.items.items) {
    out.items = { ...r.items, items: Object.fromEntries(Object.entries(r.items.items).map(([k, v]) => [k, sh(v)])) };
  }
  const f = r.flags || {};
  const reasons = [...(f.outOfRangeReasons || []).filter((x) => !x.startsWith('星数高于')), ...(c.outOfRangeReasons || [])];
  out.flags = { ...f, outOfRange: reasons.length > 0, outOfRangeReasons: reasons };
  out.reliable = !(f.sv || f.storyboard || out.flags.outOfRange);
  return out;
}

export const NEW_STAR_NOTE =
  '测试版：在现在的星数之外，多看一个直接读整张谱按键排布的小卷积网络（CNN36）。' +
  '在留出的排名谱上，人群认为差 0.2–0.5 星的谱对判对 82.9%（现在的星数 80.5%）；在群友 replay 上两者打平。' +
  '只核过 NoMod 和 DT。上面的星数和段位仍是现行的 P1h；觉得哪个更准，欢迎反馈。';

/**
 * 结果卡上的新星数。result 需有 ok、star、reliable、rate、cnn（engine 的 cnnStar 输出）。refs = dan-references-cnn36.json（可为 null）。
 * 返回 null（没算新星数）、{ state: 'off', text }，或 { state: 'ok', star, delta, reliable, reasons, dan }；
 * dan 只有米段位（整段、按单曲），面段位仍看上面那一行。
 */
export function newStarView(result, refs) {
  const c = result && result.ok ? result.cnn : null;
  if (!c) return null;
  if (!c.ok) return { state: 'off', text: c.text || '这张谱没有新星数' };
  const reasons = Array.isArray(c.outOfRangeReasons) ? c.outOfRangeReasons : [];
  const reliable = result.reliable !== false && !c.outOfRange;
  const dan = refs ? danEstimate({ ok: true, star: c.star, reliable, rate: result.rate || 1, v2: null }, refs) : null;
  return { state: 'ok', star: c.star, delta: c.star - result.star, reliable, reasons, dan };
}

/** 「复制读数信息」末尾的新星数几行。 */
export function newStarCopyLines(view, fmtStar) {
  if (!view) return [];
  if (view.state !== 'ok') return [`新星数（测试版）：暂无（${view.text}）`];
  const sign = view.delta >= 0 ? '+' : '−';
  const lines = [`新星数（测试版，${CNN_VERSION}）：${fmtStar(view.star)}（比上面 ${sign}${Math.abs(view.delta).toFixed(2)}）${view.reliable ? '' : '（不可靠）'}`];
  const d = view.dan;
  if (d && d.rice) lines.push(`  新星数的米段位：${d.rice.text}；位置 ${fmtDanPos(d.rice.loc, 'reform')}`);
  if (d && d.single) lines.push(`  新星数的米段位（按单曲换算）：${d.single.text}；${d.single.note}`);
  for (const r of view.reasons) lines.push(`  - ${r}`);
  return lines;
}
