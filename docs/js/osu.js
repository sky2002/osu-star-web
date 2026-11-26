// .osu parsing, ported from the research code (same rules, same rejections).
//   loadChart     <- tools/chart_star_public.py load_chart + _notes   (notes for the encoder / theta*)
//   parseOsuFeat  <- analysis/star-cnn-r1/sc_common.py parse_osu      (notes for the 22 hand features)
//   svFrac        <- docs/analysis/model-redesign-2026-09-26/s3_chartmeta.py parse -> frac_scroll_dev10
//   sbLines       <- analysis/r2-retrain-20261010/gimmick-flags-r1/features.py events_scan -> sb_lines
import { splitlines, fileLines, pyFloat, pyInt, round6, ssRight, median } from './pyutil.js';

export class ChartError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

export const MIN_NOTES = 20;

export function decodeOsu(bytes) {
  const data = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  const [first, second] = data;
  let encoding = 'utf-8';
  if (first === 0xff && second === 0xfe) encoding = 'utf-16le';
  else if (first === 0xfe && second === 0xff) encoding = 'utf-16be';
  return new TextDecoder(encoding).decode(data);
}

export function metadata(text) {
  const out = {};
  let sec = '';
  for (const raw of fileLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[')) { sec = line; if (sec === '[HitObjects]') break; continue; }
    if ((sec === '[Metadata]' || sec === '[General]' || sec === '[Difficulty]') && line.includes(':')) {
      const k = line.slice(0, line.indexOf(':')).trim();
      const v = line.slice(line.indexOf(':') + 1).trim();
      out[k] = v;
    }
  }
  return {
    title: out.TitleUnicode || out.Title || '', titleAscii: out.Title || '', artist: out.ArtistUnicode || out.Artist || '',
    version: out.Version || '', creator: out.Creator || '', beatmapId: out.BeatmapID && out.BeatmapID !== '0' ? out.BeatmapID : null,
    beatmapSetId: out.BeatmapSetID && out.BeatmapSetID !== '-1' ? out.BeatmapSetID : null,
    mode: out.Mode !== undefined ? out.Mode : null, keys: out.CircleSize !== undefined ? out.CircleSize : null,
  };
}

function newRepairs() {
  return { od: false, coordinates: 0, unsupported: 0, lengths: 0, overlaps: 0 };
}

function repairMessages(r) {
  const messages = [];
  if (r.od) messages.push('缺少 OD 定义，已按默认 OD 5.0 计算');
  if (r.coordinates) messages.push(`已自动修正 ${r.coordinates} 个横坐标越界的物件`);
  if (r.unsupported) messages.push(`已跳过 ${r.unsupported} 个非单点、非长条物件`);
  if (r.lengths) messages.push(`已将 ${r.lengths} 个尾部时间缺失或无效的长条改为单点`);
  if (r.overlaps) messages.push(`已自动清理 ${r.overlaps} 个同列重叠音符`);
  return messages;
}

function parseOd(value, repairs) {
  const od = value?.trim() ? pyFloat(value) : NaN;
  if (!Number.isNaN(od)) return od;
  repairs.od = true;
  return 5;
}

function readHitObject(p, repairs) {
  const kind = pyInt(p[3]);
  if (!(kind & (1 | 128))) {
    repairs.unsupported++;
    return null;
  }
  let x = pyFloat(p[0]);
  if (!Number.isFinite(x)) throw new ChartError('parse_error', 'Unsupported hit object');
  if (x < 0 || x > 512) {
    x = Math.max(0, Math.min(512, x));
    repairs.coordinates++;
  }
  const start = pyFloat(p[2]);
  if (!Number.isFinite(start)) throw new ChartError('parse_error', 'non-finite note time');
  const col = Math.min(3, Math.trunc(x * 4 / 512));
  if (!(kind & 128)) return [start, start, col, 0];
  const tail = p[5]?.split(':')[0].trim();
  const end = tail ? pyFloat(tail) : start;
  if (!Number.isFinite(end)) throw new ChartError('parse_error', 'non-finite note time');
  if (end > start) return [start, end, col, 1];
  repairs.lengths++;
  return [start, start, col, 0];
}

function repairOverlaps(notes, repairs) {
  // Check source times before any rounding, while keeping the output in file order.
  const sorted = notes.some((n, i) => i > 0 && n[0] < notes[i - 1][0])
    ? notes.slice().sort((a, b) => a[0] - b[0]) : notes;
  const previous = [];
  const discarded = new Set();
  for (const note of sorted) {
    const [start, , col, hold] = note;
    const last = previous[col];
    if (last && last[0] === start) {
      if (hold && !last[3]) {
        discarded.add(last);
        previous[col] = note;
      } else discarded.add(note);
      repairs.overlaps++;
      continue;
    }
    if (last && last[1] > start) {
      last[1] = Math.max(last[0], start - 1);
      last[3] = last[1] > last[0] ? 1 : 0;
      repairs.overlaps++;
    }
    previous[col] = note;
  }
  return discarded.size ? notes.filter(note => !discarded.has(note)) : notes;
}

// chart_star_public.load_chart: notes [start, end, col, hold] (relative, rounded, sorted by (start, col)), declared OD
export function loadChart(text) {
  const fields = {};
  const notes = [];
  const repairs = newRepairs();
  let section = '';
  for (const raw of splitlines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[')) { section = line; continue; }
    if ((section === '[General]' || section === '[Difficulty]') && line.includes(':')) {
      const i = line.indexOf(':');
      fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    } else if (section === '[HitObjects]') {
      const p = line.split(',');
      if (p.length < 4) throw new ChartError('parse_error', 'hit object line too short');
      const note = readHitObject(p, repairs);
      if (note) notes.push(note);
    }
  }
  const cs = fields.CircleSize !== undefined ? pyFloat(fields.CircleSize) : NaN;
  if (fields.Mode !== '3' || cs !== 4) throw new ChartError('not_4k', 'Only explicitly declared osu!mania 4K charts are supported');
  const od = parseOd(fields.OverallDifficulty, repairs);
  const kept = repairOverlaps(notes, repairs);
  if (!kept.length) throw new ChartError('too_few_notes', 'no notes');
  if (kept.length < MIN_NOTES && (kept.length < notes.length || repairs.unsupported)) {
    throw new ChartError('too_few_notes', `only ${kept.length} notes (< ${MIN_NOTES})`);
  }
  let mn = Infinity;
  for (const n of kept) if (n[0] < mn) mn = n[0];
  for (const n of kept) { n[0] = round6(n[0] - mn); n[1] = round6(n[1] - mn); }
  kept.sort((a, b) => (a[0] - b[0]) || (a[2] - b[2]));
  return { notes: kept, od, repairs: repairMessages(repairs) };
}

// sc_common.parse_osu (text-mode lines, utf-8 with replacement)
export function parseOsuFeat(text) {
  let odValue, alternateOd = false, cs = null, mode = null, sec = null;
  const notes = [];
  const repairs = newRepairs();
  for (const raw of fileLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[')) { sec = line; continue; }
    if (sec === '[General]' && line.startsWith('Mode:')) mode = pyInt(line.split(':')[1]);
    else if (sec === '[Difficulty]') {
      if (line.startsWith('OverallDifficulty:')) odValue = line.split(':')[1];
      else if (/^OverallDifficulty\s+:/.test(line)) alternateOd = true;
      else if (line.startsWith('CircleSize:')) cs = pyFloat(line.split(':')[1]);
    } else if (sec === '[HitObjects]') {
      const p = line.split(',');
      if (p.length < 4 || (p.length === 4 && !(pyInt(p[3]) & 128))) continue;
      const note = readHitObject(p, repairs);
      if (note) notes.push(note);
    }
  }
  // Keep the feature parser's existing interpretation of field spelling and integer times.
  const od = odValue === undefined && alternateOd ? null : parseOd(odValue, repairs);
  const kept = repairOverlaps(notes, repairs).map(([start, end, col, hold]) => {
    const t = Math.trunc(start), tail = Math.trunc(end);
    return [t, Math.max(0, col), hold && tail > t ? tail : -1];
  });
  return { od, cs, mode, notes: kept, repairs: repairMessages(repairs) };
}

// Pick the BPM covering the most playable time, adding up repeated red-line tempos.
export function primaryBpm(text) {
  const reds = [];
  let first = Infinity, last = -Infinity, section = '';
  try {
    for (const raw of fileLines(text)) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('[')) { section = line; continue; }
      if (section === '[TimingPoints]') {
        const p = line.split(',');
        if (p.length < 2 || (p.length > 6 && pyInt(p[6]) !== 1)) continue;
        const at = pyFloat(p[0]), length = pyFloat(p[1]);
        if (!Number.isFinite(at) || !Number.isFinite(length) || length <= 0) return null;
        reds.push([at, length]);
      } else if (section === '[HitObjects]') {
        const p = line.split(',');
        if (p.length < 4) continue;
        const kind = pyInt(p[3]);
        if (!(kind & (1 | 128))) continue;
        const start = pyFloat(p[2]);
        const tail = kind & 128 ? p[5]?.split(':')[0].trim() : '';
        const end = tail ? pyFloat(tail) : start;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        first = Math.min(first, start);
        last = Math.max(last, start, end);
      }
    }
  } catch {
    return null;
  }
  if (!reds.length || first > last) return null;
  reds.sort((a, b) => a[0] - b[0]);
  const durations = new Map();
  let active = 0;
  while (active + 1 < reds.length && reds[active + 1][0] <= first) active++;
  for (let i = active; i < reds.length; i++) {
    const [at, length] = reds[i];
    const start = i === active ? first : at;
    if (i !== active && start >= last) break;
    const end = Math.min(last, reds[i + 1]?.[0] ?? last);
    if (end === start && first !== last) continue;
    durations.set(length, (durations.get(length) || 0) + (end - start));
  }
  let mainLength = NaN, best = -1;
  for (const [length, duration] of durations) if (duration > best) { mainLength = length; best = duration; }
  const bpm = 60000 / mainLength;
  return Number.isFinite(bpm) ? bpm : null;
}

// s3_chartmeta.parse -> frac_scroll_dev10 (null when no red line or no notes)
export function svFrac(text) {
  const tps = [], heads = [];
  let section = '';
  for (const raw of splitlines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[')) { section = line; continue; }
    if (section === '[TimingPoints]') {
      const p = line.split(',');
      if (p.length < 2) continue;
      tps.push([pyFloat(p[0]), pyFloat(p[1]), p.length > 6 ? pyInt(p[6]) : 1]);
    } else if (section === '[HitObjects]') {
      heads.push(pyFloat(line.split(',')[2]));
    }
  }
  heads.sort((a, b) => a - b);
  const reds = tps.filter(t => t[2] === 1 && t[1] > 0).map(t => [t[0], t[1]]);
  const greens = tps.filter(t => t[2] === 0 && t[1] < 0).map(t => [t[0], -100 / t[1]]);
  greens.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (!reds.length || !heads.length) return null;
  reds.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const rt = reds.map(r => r[0]), rb = reds.map(r => r[1]);
  const gt = greens.length ? greens.map(g => g[0]) : [-1e18];
  const gv = greens.length ? greens.map(g => g[1]) : [1];
  const n = heads.length;
  const bl = new Float64Array(n), ri = new Int32Array(n);
  const cnt = new Map();
  for (let k = 0; k < n; k++) {
    ri[k] = Math.max(ssRight(rt, heads[k]) - 1, 0);
    bl[k] = rb[ri[k]];
    const key = Math.round(60000 / bl[k] * 100) / 100;   // np.round(., 2) (half-even ties are irrelevant for the mode)
    cnt.set(key, (cnt.get(key) || 0) + 1);
  }
  let mainBpm = null, best = -1;
  for (const [k, c] of cnt) if (c > best) { best = c; mainBpm = k; }   // first maximum in insertion order (Counter)
  const ls = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const bpm = 60000 / bl[k];
    const gi = ssRight(gt, heads[k]) - 1;
    let sv = gi >= 0 ? gv[Math.max(gi, 0)] : 1;
    const gtime = gi >= 0 ? gt[Math.max(gi, 0)] : -1e18;
    if (rt[ri[k]] > gtime) sv = 1;
    const scroll = Math.min(Math.max(sv, 0.01), 100) * bpm / mainBpm;
    ls[k] = Math.log(scroll);
  }
  const med = median(ls);
  let c = 0;
  for (let k = 0; k < n; k++) if (Math.abs(ls[k] - med) > Math.log(1.1)) c++;
  return c / n;
}

// gimmick-flags events_scan -> embedded storyboard object lines (Sprite / Animation)
export function sbLines(text) {
  let sec = '', obj = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const s = line.trim();
    if (s.startsWith('[')) { sec = s; continue; }
    if (sec !== '[Events]' || !s || s.startsWith('//')) continue;
    if (line[0] === ' ' || line[0] === '_') continue;
    const head = s.split(',', 1)[0].trim();
    if (head === 'Sprite' || head === '4' || head === 'Animation' || head === '6') obj++;
  }
  return obj;
}
