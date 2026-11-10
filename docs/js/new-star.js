// 新星数（测试版，CNN36）：页面最上面选“CNN36”时用的读数（纯函数，Node 里可直接 import）。
// 模型：P1h 同一配方的树多一列 CNN36 读数（一个直接看整张谱按键网格的小卷积网络，10 个模型 × 原谱 / 镜像取平均），
// 20 棵树取平均。研究仓库 docs/cnn36-web-r1-results-2026-10-25.md。只核过 NoMod 和 DT（谱面文件 OD）。
export const CNN_VERSION = '树星数 v2 测试版（P1h 配方＋CNN36）';
export const CNN_FROZEN = '2026-10-25';
export const CNN_RATES = [1, 1.5];
export const CNN_REFERENCES = { version: 'CNN36-test', modelVersion: CNN_VERSION, frozen: CNN_FROZEN };

// 星数模型开关的选项列表在 v3-star.js（STAR_MODELS）；只有选“CNN36”时才算 CNN36
export function needsCnn(mode) { return mode === 'cnn36'; }
export const CNN_OFF_HINT = '切到“P1h 旧版”可以看旧版星数。';

/**
 * 把 P1h 结果换成另一个模型的总星数：挂在总星数上的读数（LN 口径、米 / 面 / OD 分项、键型分项★）按同一个差平移，
 * 和它们的定义一致（分项★ = 总星数 + 常数 ×（分项 θ − 整谱 θ），研究仓库 rice-ln-od r1、路线 A）；分段曲线不挂在总星数上，不变。
 * “超出排名谱范围”里 P1h 的星数上限一条（“星数高于…”）换成新模型自己的 reasons；extraOutOfRange 为 true 时即使没有原因文字也算超出。
 */
export function shiftedResult(r, { model, star, reading, reasons = [], extraOutOfRange = false, extra = {}, dropBase = false }) {
  const d = star - r.star;
  const sh = (x) => (x && Number.isFinite(x.star) ? { ...x, star: x.star + d } : x);
  const out = { ...r, ...extra, model, p1hStar: r.star, star, reading, v2: sh(r.v2) };
  if (r.sub) out.sub = { ...r.sub, rice: sh(r.sub.rice), face: sh(r.sub.face), od: sh(r.sub.od), v2: sh(r.sub.v2) };
  if (r.items && r.items.items) {
    out.items = { ...r.items, items: Object.fromEntries(Object.entries(r.items.items).map(([k, v]) => [k, sh(v)])) };
  }
  const f = r.flags || {};
  // dropBase：新模型不用 P1h 的那些输入，P1h 的超范围原因整组不带过来
  const base = dropBase ? [] : (f.outOfRangeReasons || []).filter((x) => !x.startsWith('星数高于'));
  const rs = [...base, ...(Array.isArray(reasons) ? reasons : [])];
  out.flags = { ...f, outOfRange: rs.length > 0 || !!extraOutOfRange, outOfRangeReasons: rs };
  out.reliable = !(f.sv || f.storyboard || out.flags.outOfRange);
  return out;
}

/** 只看 CNN36 时结果卡用的结果；没有新星数（HT、自定义 OD、加载失败）时返回 null。 */
export function cnnViewResult(r) {
  if (!r || !r.ok || !r.cnn || !r.cnn.ok) return null;
  const c = r.cnn;
  return shiftedResult(r, { model: 'cnn36', star: c.star, reading: c.reading, reasons: c.outOfRangeReasons || [] });
}
