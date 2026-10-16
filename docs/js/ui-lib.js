// 页面用到的纯函数（不碰 DOM，Node 里也能直接 import 测试）。
import { unzipSync } from '../vendor/fflate/fflate.mjs';
import { danReferenceCopyLines } from './dan-reference.js';
import { danEstimateCopyLines } from './dan-estimate.js';

export const STAR_NOTE_JACK =
  'jack/chordjack 较多（jackheavy）';
export const SEG_CAPTION =
  '分段曲线：每 10 秒一段，按旧公共星数刻度，只用来看起伏，不等于总星数';

const MODE_NAMES = ['std', 'taiko', 'catch', 'mania'];

/** 倍速 → 显示名。只支持这三档。 */
export const MOD_LABELS = { 1: 'NoMod', 0.75: 'HT（0.75 倍）', 1.5: 'DT（1.5 倍）' };
export const MOD_SHORT = { 1: '', 0.75: 'HT', 1.5: 'DT' };
export const HT_NOTE =
  'HT 读数未经检验：模型没有用 HT 成绩训练或检验，只是把谱面放慢到 0.75 倍后按同一方法计算';
export function modLabel(rate) { return MOD_LABELS[rate] || `${rate} 倍`; }

export const SUB_NOTE =
  '分项与 OD 口径为约定换算，不参与总星数。LN 口径是整谱按 97% ScoreV2（LN 段位的计分口径，OD 用谱面文件）读出的星数；米分项只看单点（96% ScoreV1）；面分项只看长条头尾，按 97% ScoreV2，' +
  '这条线比 96% ScoreV1 严，所以面分项通常比总星数高；OD 口径把判定窗换成 OD8（6.3 星以上用 OD9）重算';

/** 米 / 面分项与 OD 口径的三行：[{ key, label, star|null, text }]。result.sub 缺失时返回 []。 */
export function subRows(result) {
  const s = result && result.ok && result.sub;
  if (!s) return [];
  const edge = (f) => (String(f || '').startsWith('censored') ? '（超出参照范围）' : '');
  const rows = [];
  if (s.v2) rows.push({ key: 'v2', label: 'LN 口径', star: s.v2.star, text: '整谱 97% ScoreV2' + edge(s.v2.flag) });
  rows.push(s.rice.ok
    ? { key: 'rice', label: '米', star: s.rice.star, text: edge(s.rice.flag) }
    : { key: 'rice', label: '米', star: null, text: '米太少' });
  rows.push(s.face.ok
    ? { key: 'face', label: '面', star: s.face.star, text: '97% ScoreV2' + edge(s.face.flag) }
    : { key: 'face', label: '面', star: null, text: '长条太少' });
  const odName = `OD${s.od.od} 口径`;
  rows.push(s.od.changed
    ? { key: 'od', label: odName, star: s.od.star, text: `谱面文件 OD ${Number(s.od.fileOd).toFixed(1)}` + edge(s.od.flag) }
    : { key: 'od', label: odName, star: s.od.star, text: `谱面文件已是 OD${s.od.od}` });
  return rows;
}

export function decodeText(u8) {
  return new TextDecoder('utf-8').decode(u8); // 默认会去掉 BOM
}

/** 读 .osu 头部字段（Mode、CircleSize、Title、Artist、Version 等）并数物件行数。 */
export function parseOsuHeader(text) {
  const out = {
    mode: 0, circleSize: null, title: '', artist: '', version: '', creator: '',
    beatmapId: null, beatmapSetId: null, nObjects: 0,
  };
  let section = '';
  const lines = text.split('\n');
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('//')) continue;
    if (t[0] === '[' && t[t.length - 1] === ']') { section = t.slice(1, -1); continue; }
    if (section === 'HitObjects') { out.nObjects++; continue; }
    const ix = t.indexOf(':');
    if (ix < 0) continue;
    const k = t.slice(0, ix).trim();
    const v = t.slice(ix + 1).trim();
    if (section === 'General') {
      if (k === 'Mode') out.mode = parseInt(v, 10) || 0;
    } else if (section === 'Difficulty') {
      if (k === 'CircleSize') { const x = parseFloat(v); out.circleSize = Number.isFinite(x) ? x : null; }
    } else if (section === 'Metadata') {
      if (k === 'Title') out.title = v;
      else if (k === 'Artist') out.artist = v;
      else if (k === 'Version') out.version = v;
      else if (k === 'Creator') out.creator = v;
      else if (k === 'BeatmapID') { const n = parseInt(v, 10); out.beatmapId = n > 0 ? n : null; }
      else if (k === 'BeatmapSetID') { const n = parseInt(v, 10); out.beatmapSetId = n > 0 ? n : null; }
    }
  }
  return out;
}

export function isMania4K(h) {
  return h.mode === 3 && h.circleSize !== null && Math.abs(h.circleSize - 4) < 1e-6;
}

/** 主线程判断为不支持时的中文说明；支持则返回 null。 */
export function skipReason(h) {
  if (isMania4K(h)) return null;
  const why = h.mode !== 3
    ? `模式：${MODE_NAMES[h.mode] || h.mode}`
    : `键数：${h.circleSize === null ? '未知' : h.circleSize + 'K'}`;
  return `跳过：不是 mania 4K（${why}）`;
}

export function baseName(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 解开 .osz，列出全部 .osu。只解压 .osu / .osb，音频图片一概不碰。
 * 返回 { entries:[{path,name,bytes,header,skip}], hasOsb }；skip 为 null 表示可送去计算。
 */
export function listOsz(u8) {
  const files = unzipSync(u8, { filter: (f) => /\.(osu|osb)$/i.test(f.name) });
  let hasOsb = false;
  const entries = [];
  for (const path of Object.keys(files)) {
    const name = baseName(path);
    if (path.startsWith('__MACOSX/') || name.startsWith('._')) continue;
    if (/\.osb$/i.test(name)) { hasOsb = true; continue; }
    if (!/\.osu$/i.test(name)) continue;
    const bytes = files[path];
    const header = parseOsuHeader(decodeText(bytes));
    entries.push({ path, name, bytes, header, skip: skipReason(header) });
  }
  return { entries, hasOsb };
}

export function fmtStar(x) { return Number(x).toFixed(2); }

export function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 合并主线程读到的头部和 worker 返回的元数据（worker 优先，缺失用头部）。 */
export function mergeMeta(header, result) {
  const r = result || {};
  const h = header || {};
  const pick = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);
  return {
    title: pick(r.title, h.title) || '',
    artist: pick(r.artist, h.artist) || '',
    version: pick(r.version, h.version) || '',
    creator: pick(r.creator, h.creator) || '',
    beatmapId: pick(r.beatmapId, h.beatmapId) || null,
    md5: r.md5 || null,
  };
}

export function displayName(meta, fileName) {
  const base = meta.artist || meta.title
    ? `${meta.artist || '?'} - ${meta.title || '?'}`
    : (fileName || '未知谱面');
  return meta.version ? `${base} [${meta.version}]` : base;
}

/** 不可靠原因（中文列表）。reliable 为 true 时返回空数组。 */
export function unreliableReasons(result) {
  if (!result || !result.ok || result.reliable) return [];
  const f = result.flags || {};
  const out = [];
  if (f.sv) {
    const pct = typeof f.svFrac === 'number' ? `（约 ${Math.round(f.svFrac * 100)}% 的物件处变速）` : '';
    out.push('有变速（SV），训练时排除了这类谱，读数未经检验' + pct);
  }
  if (f.storyboard) out.push('带 storyboard（可能是观赏/特效谱），读数未经检验');
  if (f.outOfRange) {
    const rs = Array.isArray(f.outOfRangeReasons) ? f.outOfRangeReasons.filter(Boolean) : [];
    out.push('超出排名谱训练范围：' + (rs.length ? rs.join('；') : '具体项目未给出'));
  }
  if (!out.length) out.push('读数未经检验');
  return out;
}

export function jackHint(result) {
  if (!result || !result.ok || !result.flags || !result.flags.jackHeavy) return null;
  return STAR_NOTE_JACK;
}

/** 「复制读数信息」的多行文本。ver 为 ready 消息的 {version, frozen}。 */
export function buildCopyText(result, header, fileName, ver, references, ladderLine = null, withSub = true, dan = null) {
  const meta = mergeMeta(header, result);
  const verText = ver && ver.version
    ? `${ver.version}（冻结日期 ${ver.frozen || '未知'}）` : '未知';
  const lines = [];
  lines.push(`谱名：${meta.artist || '?'} - ${meta.title || '?'}`);
  lines.push(`难度名：${meta.version || '?'}`);
  if (meta.creator) lines.push(`mapper：${meta.creator}`);
  lines.push(`beatmap id：${meta.beatmapId || '无'}`);
  lines.push(`md5：${meta.md5 || '无'}`);
  if (result && result.ok) {
    lines.push(`星数：${fmtStar(result.star)}`);
    lines.push(`Mod：${modLabel(result.rate || 1)}`);
  } else {
    lines.push(`星数：无（${(result && result.message) || '未计算'}）`);
  }
  lines.push(`版本：${verText}`);
  const rs = unreliableReasons(result);
  if (rs.length) {
    lines.push('读数不可靠：是');
    rs.forEach((r) => lines.push(`  - ${r}`));
  }
  if (result && result.ok) lines.push(...danEstimateCopyLines(dan));
  const jh = jackHint(result);
  if (jh) lines.push(`提示：${jh}`);
  if (withSub) for (const r of subRows(result)) lines.push(`${r.label}：${r.star === null ? r.text : fmtStar(r.star) + (r.text ? `（${r.text}）` : '')}`);
  if (result && result.ok && result.rate === 0.75) lines.push(`提示：${HT_NOTE}`);
  if (result && result.ok && ladderLine) lines.push(ladderLine);
  if (result && result.ok) lines.push(...danReferenceCopyLines(references));
  return lines.join('\n');
}

/**
 * 分段曲线（手写 SVG 字符串，只含数字和固定文字）。segments 为空返回 ''。
 * 物件很少的段（sparse）画成空心点并断开折线。
 */
export function buildSegmentsSvg(segments, hardest) {
  if (!Array.isArray(segments) || segments.length < 1) return '';
  const W = 320, H = 96, L = 30, R = 8, T = 8, B = 18;
  const end = Math.max(...segments.map((s) => s.endS), 1);
  const stars = segments.map((s) => s.star).filter((v) => Number.isFinite(v));
  if (!stars.length) return '';
  let lo = Math.min(...stars), hi = Math.max(...stars);
  if (hi - lo < 0.5) { const m = (hi + lo) / 2; lo = m - 0.25; hi = m + 0.25; }
  const shownHi = hi, shownLo = lo;
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = (t) => L + (t / end) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const f = (v) => v.toFixed(1);
  let svg = `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="分段星数曲线" preserveAspectRatio="xMidYMid meet">`;
  if (hardest && Number.isFinite(hardest.startS) && Number.isFinite(hardest.endS)) {
    const x0 = X(hardest.startS), x1 = Math.max(X(hardest.endS), x0 + 2);
    svg += `<rect class="hl" x="${f(x0)}" y="${T}" width="${f(x1 - x0)}" height="${H - T - B}"/>`;
  }
  svg += `<line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>`;
  svg += `<text class="lbl" x="${L - 4}" y="${f(Y(shownHi) + 3)}" text-anchor="end">${shownHi.toFixed(1)}</text>`;
  svg += `<text class="lbl" x="${L - 4}" y="${f(Y(shownLo) + 3)}" text-anchor="end">${shownLo.toFixed(1)}</text>`;
  svg += `<text class="lbl" x="${L}" y="${H - 4}" text-anchor="start">0:00</text>`;
  svg += `<text class="lbl" x="${W - R}" y="${H - 4}" text-anchor="end">${fmtTime(end)}</text>`;
  let d = '', pen = false;
  for (const s of segments) {
    const x = X((s.startS + s.endS) / 2), y = Y(s.star);
    if (s.sparse || !Number.isFinite(s.star)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${f(x)} ${f(y)} `;
    pen = true;
  }
  if (d) svg += `<path class="line" d="${d.trim()}"/>`;
  const pts = [];
  for (const s of segments) {
    if (!Number.isFinite(s.star)) continue;
    const x = X((s.startS + s.endS) / 2), y = Y(s.star);
    pts.push({ s, x, y });
    svg += `<circle class="${s.sparse ? 'pt sparse' : 'pt'}" cx="${f(x)}" cy="${f(y)}" r="${s.sparse ? 2.2 : 1.6}"/>`;
  }
  // 悬停列：每个点占据它与左右相邻点中点之间的整列高度，鼠标在点的上方或下方都会显示该点数值（纯 CSS :hover）。
  const top = T, bot = H - B;
  pts.forEach((p, i) => {
    const x0 = i ? (pts[i - 1].x + p.x) / 2 : L;
    const x1 = i < pts.length - 1 ? (p.x + pts[i + 1].x) / 2 : W - R;
    const tip = `${fmtTime(p.s.startS)}–${fmtTime(p.s.endS)}  ★ ${fmtStar(p.s.star)}${p.s.sparse ? '（物件很少）' : ''}`;
    // 9px 字体的粗略宽度：中文约 9px，其余约 4.4px
    let tw = 0;
    for (const ch of tip) tw += ch.codePointAt(0) >= 0x3000 ? 9 : 4.4;
    const bw = tw + 8, bh = 13;
    const bx = Math.min(Math.max(p.x - bw / 2, L), W - R - bw);
    const by = p.y - bh - 5 >= 0 ? p.y - bh - 5 : p.y + 5;
    svg += `<g class="col"><rect class="hit" x="${f(x0)}" y="${top}" width="${f(Math.max(x1 - x0, 1))}" height="${bot - top}"/>`
      + `<g class="tip"><line class="guide" x1="${f(p.x)}" y1="${top}" x2="${f(p.x)}" y2="${bot}"/>`
      + `<circle class="pt-on" cx="${f(p.x)}" cy="${f(p.y)}" r="3"/>`
      + `<rect class="tip-bg" x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${bh}" rx="3"/>`
      + `<text class="tip-t" x="${f(bx + 4)}" y="${f(by + 9.5)}">${tip}</text></g></g>`;
  });
  svg += '</svg>';
  return svg;
}
