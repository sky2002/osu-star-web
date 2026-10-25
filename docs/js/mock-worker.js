// 假 worker：协议与真 worker 相同，只返回编造的数据，用于页面自测（?mock=1）。
import { md5Hex } from './md5.js';
import { decodeText, parseOsuHeader, isMania4K } from './ui-lib.js';

const DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastObjectTimeS(text) {
  const i = text.indexOf('[HitObjects]');
  if (i < 0) return 0;
  let last = 0;
  for (const line of text.slice(i).split('\n').slice(1)) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const t = parseInt(p[2], 10);
    if (t > last) last = t;
  }
  return last / 1000;
}

async function score(msg) {
  const { id, bytes, name, oszHasOsb } = msg;
  const rate = msg.rate || 1;
  const text = decodeText(bytes);
  const h = parseOsuHeader(text);
  const md5 = md5Hex(bytes);
  const meta = {
    title: h.title, artist: h.artist, version: h.version, creator: h.creator,
    beatmapId: h.beatmapId, md5,
  };
  const steps = [['读取谱面', 10], ['整理物件', 40], ['估算难度', 80], ['汇总', 100]];
  for (const [stage, pct] of steps) {
    self.postMessage({ type: 'progress', id, stage, pct });
    await sleep(DELAY_MS / steps.length);
  }
  let result;
  if (h.mode !== 3) {
    result = { ok: false, reason: 'not_mania', message: '这不是 mania 谱面。', mode: h.mode, ...meta };
  } else if (!isMania4K(h)) {
    result = { ok: false, reason: 'not_4k', message: `只支持 4K，这张是 ${h.circleSize}K。`, mode: 3, keys: h.circleSize, ...meta };
  } else if (h.nObjects < 20) {
    result = { ok: false, reason: 'too_few_notes', message: '物件少于 20 个，不计算。', nNotes: h.nObjects, ...meta };
  } else {
    const b = parseInt(md5.slice(0, 8), 16);
    const star = 1.5 + (b % 7500) / 1000 + (rate === 1.5 ? 1.6 : rate === 0.75 ? -1.1 : 0); // 1.5 ~ 9.0 at 1.0x
    const durationS = Math.max(lastObjectTimeS(text) / rate, 10);
    const nSeg = Math.max(1, Math.ceil(durationS / 10));
    const segments = [];
    let hard = null;
    for (let i = 0; i < nSeg; i++) {
      const s = Math.max(0.5, star * 0.55 + 0.45 * star * (0.5 + 0.5 * Math.sin(i * 0.9 + (b % 13))));
      const seg = { startS: i * 10, endS: Math.min((i + 1) * 10, durationS), star: s, sparse: i % 11 === 10 };
      segments.push(seg);
      if (!seg.sparse && (!hard || s > hard.star)) hard = { startS: seg.startS, endS: seg.endS, star: s };
    }
    const flags = {
      sv: b % 5 === 0, svFrac: b % 5 === 0 ? 0.23 : 0,
      storyboard: !!oszHasOsb, sbLines: oszHasOsb ? 12 : 0,
      outOfRange: star > 8.9 || b % 11 === 0,
      outOfRangeReasons: [],
      jackHeavy: b % 7 === 0, jackShare: b % 7 === 0 ? 0.41 : 0.1,
    };
    if (star > 8.9) flags.outOfRangeReasons.push(`星数 ${star.toFixed(2)} 高于排名谱最高读数约 8.9`);
    if (b % 11 === 0) flags.outOfRangeReasons.push('长条占比超出排名谱的范围');
    result = {
      ok: true, rate, ...meta, beatmapSetId: h.beatmapSetId,
      star, reading: star - 4.6, theta: (star - 4.6146) / 1.3714,
      nNotes: h.nObjects, nActions: Math.round(h.nObjects * 1.3), od: 8, durationS,
      seconds: DELAY_MS / 1000, reliable: !(flags.sv || flags.storyboard || flags.outOfRange),
      flags, segments, hardest: hard, lnFrac: (b % 5) / 5,
      v2: { theta: 0, flag: '', star: star + 0.6 },
      sub: {
        rice: b % 3 === 0 ? { ok: false, n: 20, theta: null, flag: 'empty', star: null } : { ok: true, n: 900, theta: 0, flag: '', star: star - 0.4 },
        face: b % 2 === 0 ? { ok: false, n: 3, theta: null, flag: '', star: null } : { ok: true, n: 400, theta: 0, flag: '', star: star + 1.2 },
        od: { od: star >= 6.3 ? 9 : 8, fileOd: 8, theta: 0, flag: '', star: star >= 6.3 ? star + 0.25 : star, changed: star >= 6.3 },
        ms: 1,
      },
      items: rate !== 1 ? null : (() => {
        const it = (s, st, n, f = '') => ({ n, share: n / h.nObjects, display: n >= 50 && n / h.nObjects >= 0.05, theta: 0, flag: f, s, star: st });
        return {
          thetaU: 0, flagU: '', kMain: 1.8, thetaAll: 0, flagAll: '', techTag: b % 4 === 0, ms: 1,
          items: {
            jack: it(0.32, star + 0.8, b % 6 === 0 ? 10 : 400), speed: it(0.41, star - 0.3, 900), trill_tA: it(0.2, star + 0.1, 300),
            ln: it(0.15, star + 0.7, 200), kashou: it(0.05, star + 0.5, 60), trill: it(0.01, star, 5), other: it(0.07, NaN, 100),
            tech_rA: it(0.12, star - 0.2, 150),
          },
        };
      })(),
      cnn: !msg.withCnn ? null : rate === 0.75
        ? { ok: false, reason: 'untested', text: '新星数只核过 NoMod 和 DT（谱面文件 OD），这个设置下不给' }
        : { ok: true, star: star + ((b % 9) - 4) / 10, reading: 0, cnnReading: 0, outOfRange: b % 13 === 0,
          outOfRangeReasons: b % 13 === 0 ? ['CNN36 读数超出排名谱范围'] : [], ms: 1 },
    };
  }
  self.postMessage({ type: 'result', id, result });
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    await sleep(500);
    self.postMessage({ type: 'ready', version: '树星数 v1 (P1h)', frozen: '2026-10-14', loadMs: 500 });
  } else if (msg.type === 'cnn') {
    await sleep(DELAY_MS);
    const b = parseInt(md5Hex(msg.bytes).slice(0, 8), 16);
    const rate = msg.rate || 1;
    const star = 1.5 + (b % 7500) / 1000 + (rate === 1.5 ? 1.6 : 0);
    const cnn = rate === 0.75 || Number.isFinite(msg.odOverride)
      ? { ok: false, reason: 'untested', text: '新星数只核过 NoMod 和 DT（谱面文件 OD），这个设置下不给' }
      : { ok: true, star: star + ((b % 9) - 4) / 10, reading: 0, cnnReading: 0, outOfRange: false, outOfRangeReasons: [], ms: 1 };
    self.postMessage({ type: 'result', id: msg.id, result: { cnnOnly: true, cnn } });
  } else if (msg.type === 'score') {
    try {
      await score(msg);
    } catch (e) {
      self.postMessage({
        type: 'result', id: msg.id,
        result: { ok: false, reason: 'parse_error', message: '读取谱面时出错：' + (e && e.message ? e.message : e) },
      });
    }
  }
};
