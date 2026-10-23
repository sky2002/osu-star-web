// 米 / 面段位纯函数：node --test tests/dan-estimate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  danPoints, poolAdjacent, danTiers, locateDan, danText, danEstimate, danEstimateCopyLines, fmtDanPos, singlePoints,
  DAN_MERGE_GAP, DAN_LN_FEW, DAN_FEW_LN_NOTE, DAN_UNRELIABLE_NOTE, DAN_SINGLE_LABEL, DAN_SINGLE_NOTE,
} from '../docs/js/dan-estimate.js';
import { validateDanReferences } from '../docs/js/dan-reference.js';
import { buildCopyText } from '../docs/js/ui-lib.js';

const data = validateDanReferences(JSON.parse(fs.readFileSync(new URL('../docs/data/dan-references.json', import.meta.url), 'utf8')));
const pt = (pos, star, label = String(pos)) => ({ pos, star, label });
const ok = (star, extra = {}) => ({ ok: true, star, reliable: true, rate: 1, v2: { star: star + 0.6 }, lnFrac: 0.7, ...extra });

test('reference points: REFORM 1st..Eta without INTRO (17), LN 6th..15th on starV2 (10)', () => {
  const r = danPoints(data, 'reform');
  assert.deepEqual(r.map((x) => x.label), ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta']);
  assert.deepEqual(r.map((x) => x.pos), Array.from({ length: 17 }, (_, i) => i + 1));
  const l = danPoints(data, 'ln');
  assert.deepEqual(l.map((x) => x.pos), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const ln = data.groups[1].entries;
  for (const p of l) assert.equal(p.star, ln.find((e) => e.id === `ln-${p.pos}`).starV2);
});

test('pool-adjacent-violators merges an out-of-order pair into one averaged tier', () => {
  const t = poolAdjacent([pt(1, 1.0, 'a'), pt(2, 2.0, 'b'), pt(3, 1.8, 'c'), pt(4, 3.0, 'd')]);
  assert.deepEqual(t.map((x) => x.label), ['a', 'b–c', 'd']);
  assert.ok(Math.abs(t[1].star - 1.9) < 1e-12);
  assert.equal(t[1].pos, 2.5);
  // a longer violation chain pools back into the earlier block
  const u = poolAdjacent([pt(1, 3), pt(2, 2), pt(3, 1), pt(4, 5)]);
  assert.equal(u.length, 2);
  assert.ok(Math.abs(u[0].star - 2) < 1e-12);
  for (let i = 1; i < u.length; i++) assert.ok(u[i].star >= u[i - 1].star);
});

test('tiers closer than 0.05 stars merge; the live REFORM 2nd / 3rd become one tier', () => {
  const t = danTiers([pt(1, 1.0, 'a'), pt(2, 1.04, 'b'), pt(3, 1.2, 'c')]);
  assert.deepEqual(t.map((x) => x.label), ['a–b', 'c']);
  assert.equal(danTiers([pt(1, 1.0, 'a'), pt(2, 1.0 + DAN_MERGE_GAP, 'b')]).length, 2);
  const r = danTiers(danPoints(data, 'reform'));
  assert.ok(r.some((x) => x.label === '2nd–3rd'));
  assert.ok(!r.some((x) => x.label === '2nd'));
  for (let i = 1; i < r.length; i++) assert.ok(r[i].star - r[i - 1].star >= DAN_MERGE_GAP);
});

test('locate: between with lean thirds, below, above with extrapolated position', () => {
  const tiers = danTiers([pt(7, 5.0, '7th'), pt(8, 5.3, '8th'), pt(9, 6.0, '9th')]);
  const at = (s) => locateDan(s, tiers);
  assert.equal(danText(at(5.25)), '7th–8th 之间（偏 8th）');
  assert.equal(danText(at(5.05)), '7th–8th 之间（偏 7th）');
  assert.equal(danText(at(5.15)), '7th–8th 之间（居中）');
  assert.ok(Math.abs(at(5.15).pos - 7.5) < 1e-12);
  assert.equal(at(5.0).kind, 'between');
  assert.equal(at(6.0).kind, 'between');
  assert.equal(danText(at(4.0)), '低于 7th');
  assert.equal(danText(at(4.0), { prefix: 'LN ', belowText: 'LN 6 段以下' }), 'LN 6 段以下');
  assert.equal(danText(at(6.5)), '高于 9th（外推）');
  assert.equal(danText(at(6.5), { prefix: 'LN ' }), '高于 LN 9th（外推）');
  assert.ok(at(6.5).extrapolated && Math.abs(at(6.5).pos - (9 + 0.5 / 0.7)) < 1e-12);
  assert.ok(at(4.7).extrapolated && Math.abs(at(4.7).pos - (7 - 0.3 / 0.3)) < 1e-12);
  assert.equal(locateDan(NaN, tiers), null);
});

test('a reading within 15 % of a tier reads "≈ tier"; a reference chart reads itself as ≈ its own dan', () => {
  const tiers = danTiers([pt(7, 5.0, '7th'), pt(8, 5.3, '8th'), pt(9, 6.0, '9th')]);
  assert.equal(danText(locateDan(5.0, tiers)), '≈ 7th');
  assert.equal(danText(locateDan(5.3, tiers)), '≈ 8th');
  assert.equal(danText(locateDan(6.0, tiers), { prefix: 'LN ' }), '≈ LN 9th');
  assert.equal(danText(locateDan(5.04, tiers)), '≈ 7th');
  const ln = danTiers(danPoints(data, 'ln'));
  for (const t of ln) assert.equal(danText(locateDan(t.star, ln), { prefix: 'LN ' }), `≈ LN ${t.label}`);
});

test('merged tiers read "A 与 B 之间"', () => {
  const tiers = danTiers([pt(1, 2.62, '1st'), pt(2, 2.88, '2nd'), pt(3, 2.90, '3rd'), pt(4, 3.60, '4th')]);
  assert.equal(danText(locateDan(2.83, tiers)), '1st 与 2nd–3rd 之间（偏 2nd–3rd）');
  assert.equal(danText(locateDan(3.4, tiers)), '2nd–3rd 与 4th 之间（偏 4th）');
  assert.equal(danText(locateDan(3.5, tiers)), '≈ 4th');
});

test('danEstimate on the live references: rice and face, LN below 6th, few long notes, unreliable, rates', () => {
  const e = danEstimate(ok(5.35, { v2: { star: 6.1 } }), data);
  assert.equal(e.rice.text, '7th–8th 之间（偏 8th）');
  assert.match(e.face.text, /^LN 8th–9th 之间/);
  assert.equal(e.face.muted, false);
  assert.equal(e.unreliable, false);
  assert.equal(e.rateNote, '');
  assert.equal(danEstimate(ok(3, { v2: { star: 4.0 } }), data).face.text, 'LN 6 段以下');
  assert.equal(danEstimate(ok(11, { v2: { star: 12 } }), data).rice.text, '高于 Eta（外推）');
  assert.match(danEstimate(ok(11, { v2: { star: 12 } }), data).face.text, /^高于 LN 14th–15th（外推）$|^高于 LN 15th（外推）$/);
  assert.equal(danEstimate(ok(1.0), data).rice.text, '低于 1st');
  const few = danEstimate(ok(5.35, { lnFrac: DAN_LN_FEW - 0.01 }), data);
  assert.equal(few.face.muted, true);
  assert.equal(few.face.note, DAN_FEW_LN_NOTE);
  assert.equal(danEstimate(ok(5.35, { lnFrac: DAN_LN_FEW }), data).face.muted, false);
  assert.equal(danEstimate(ok(5.35, { reliable: false }), data).unreliable, true);
  assert.match(danEstimate(ok(5.35, { rate: 1.5 }), data).rateNote, /^DT：/);
  assert.match(danEstimate(ok(5.35, { rate: 0.75 }), data).rateNote, /^HT：/);
  assert.equal(danEstimate(ok(5.35, { v2: null }), data).face, null);
  assert.equal(danEstimate({ ok: false }, data), null);
  assert.equal(danEstimate(ok(5.35), null), null);
});

test('copy lines carry the decimal position and the caveats', () => {
  const lines = danEstimateCopyLines(danEstimate(ok(5.35, { reliable: false, lnFrac: 0.01, rate: 1.5 }), data));
  assert.match(lines[0], /^米段位：7th–8th 之间（偏 8th）（不可靠）；位置 [0-9.]+（1st=1/);
  assert.match(lines[1], /^米段位（按单曲换算）：≈ 8th（不可靠）；误差约 ±0\.15 段；位置 [0-9.]+（1st=1/);
  assert.match(lines[2], new RegExp(`^面段位：.*（${DAN_FEW_LN_NOTE}）（不可靠）；位置`));
  assert.match(lines[3], /^DT：/);
  assert.equal(fmtDanPos(locateDan(20, danTiers(danPoints(data, 'reform'))), 'reform').startsWith('约 '), true);
  const text = buildCopyText(ok(5.35), {}, 'x.osu', { version: 'v', frozen: 'f' }, null, null, false, danEstimate(ok(5.35), data));
  assert.match(text, /\n米段位：7th–8th 之间（偏 8th）；位置/);
  assert.match(text, /\n米段位（按单曲换算）：≈ 8th；误差约 ±0\.15 段；位置 8\.\d\d（1st=1/);
  assert.match(text, /\n面段位：LN /);
  assert.equal(DAN_UNRELIABLE_NOTE.length > 0, true);
});

// ---------------------------------------------------------------- single-chart ruler ("按单曲换算")
// Python (research repo analysis/bias-multidim-r1/A/dan_common.single_ruler on the 60 singles of a_tables.Data, P1hweb, file OD):
// ruler points (star, dan position) and positions of a few stars (apply_single_ruler, linear extrapolation at both ends)
const PY_SINGLE_POINTS = [[2.5071017942395084, 1.0], [2.8134410984039944, 2.5], [3.7335548517077726, 4.0], [4.127744111014477, 5.0],
  [4.496105651393191, 6.0], [4.7658222964015335, 7.0], [5.307481007826056, 8.0], [5.608163884399707, 9.0], [5.819020432506001, 10.0],
  [6.234944640932316, 11.0], [6.31976383886466, 12.0], [6.8094839191763405, 13.0], [7.272009818437607, 14.0], [8.088269921334097, 15.0],
  [8.751658658993481, 16.0]];
const PY_SINGLE_POS = [[2.0, -1.483039822245067], [2.7, 1.9445321077225382], [3.0, 2.804134517486795], [5.45, 8.473984397774759],
  [5.48, 8.573757289207277], [5.91, 10.218740736054361], [7.1, 13.628107704428364], [8.0, 14.891860546631065],
  [9.0, 16.374352663692687], [10.0, 17.88176444690787]];
// the points the main session quoted (3 decimals)
const QUOTED = [[2.507, 1], [2.813, 2.5], [3.734, 4], [4.128, 5], [4.496, 6], [4.766, 7], [5.307, 8], [5.608, 9], [5.819, 10], [6.235, 11],
  [6.32, 12], [6.809, 13], [7.272, 14], [8.088, 15], [8.752, 16]];

test('60 REFORM singles: 1st..Zeta, 2–6 per dan, no Eta; per-dan means', () => {
  const e = data.reformSingles.entries;
  assert.equal(e.length, 60);
  const per = {};
  for (const x of e) per[x.dan] = (per[x.dan] || 0) + 1;
  assert.deepEqual(per, { '1st': 4, '2nd': 4, '3rd': 4, '4th': 3, '5th': 5, '6th': 4, '7th': 3, '8th': 4, '9th': 4, '10th': 4,
    alpha: 3, beta: 4, gamma: 3, delta: 3, epsilon: 6, zeta: 2 });
  const p = singlePoints(data);
  assert.deepEqual(p.map((x) => x.pos), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.ok(p[1].star > p[2].star, '2nd single mean is above 3rd (pooled by the monotone step)');
  assert.deepEqual(singlePoints({ groups: [] }), []);
});

test('single ruler tiers equal the Python points to 1e-6 (and the quoted 3-decimal values)', () => {
  const t = danTiers(singlePoints(data));
  assert.equal(t.length, PY_SINGLE_POINTS.length);
  t.forEach((x, i) => {
    assert.ok(Math.abs(x.star - PY_SINGLE_POINTS[i][0]) < 1e-6, `star ${i}`);
    assert.ok(Math.abs(x.pos - PY_SINGLE_POINTS[i][1]) < 1e-6, `pos ${i}`);
    assert.equal(Number(x.star.toFixed(3)), QUOTED[i][0]);
    assert.equal(x.pos, QUOTED[i][1]);
  });
  assert.deepEqual(t.map((x) => x.label), ['1st', '2nd–3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);
  for (const [star, pos] of PY_SINGLE_POS) assert.ok(Math.abs(locateDan(star, t).pos - pos) < 1e-6, `position at ${star}`);
});

test('single ruler readings of the proposal examples; Eta has no single and reads as extrapolated above Zeta', () => {
  const single = (star) => danEstimate(ok(star), data).single;
  assert.equal(single(7.10).text, 'Gamma–Delta 之间（居中）');
  assert.equal(danEstimate(ok(7.10), data).rice.text, 'Gamma–Delta 之间（偏 Gamma）');
  assert.equal(single(5.91).text, '10th–Alpha 之间（偏 10th）');
  assert.equal(danEstimate(ok(5.91), data).rice.text, '9th–10th 之间（偏 10th）');
  assert.equal(single(5.48).text, '8th–9th 之间（居中）');
  assert.equal(single(5.45).text, '8th–9th 之间（居中）');
  assert.equal(single(9.0).text, '高于 Zeta（外推）');
  assert.ok(single(9.0).loc.extrapolated);
  assert.equal(single(2.0).text, '低于 1st');
  assert.equal(single(2.7).text, '1st 与 2nd–3rd 之间（居中）');
  assert.equal(single(7.10).label, DAN_SINGLE_LABEL);
  assert.equal(single(7.10).note, DAN_SINGLE_NOTE);
  assert.equal(DAN_SINGLE_NOTE, '误差约 ±0.15 段');
  assert.match(fmtDanPos(single(7.10).loc, 'reform'), /^13\.63（/);
});

test('no single row without singles data; the single row follows the rice row (rates, unreliable)', () => {
  const noSingles = { ...data };
  delete noSingles.reformSingles;
  const e = danEstimate(ok(5.35), noSingles);
  assert.equal(e.single, null);
  assert.ok(e.rice);
  assert.ok(!danEstimateCopyLines(e).some((l) => l.includes('按单曲换算')));
  assert.ok(danEstimate(ok(5.35, { rate: 1.5 }), data).single);
  assert.equal(danEstimate(ok(5.35, { reliable: false }), data).unreliable, true);
});

test('singles validation: count, Eta, ids, links', () => {
  assert.doesNotThrow(() => validateDanReferences(structuredClone(data)));
  const noSingles = structuredClone(data);
  delete noSingles.reformSingles;
  assert.doesNotThrow(() => validateDanReferences(noSingles));
  const bad = (f) => { const d = structuredClone(data); f(d.reformSingles); assert.throws(() => validateDanReferences(d)); };
  bad((s) => s.entries.pop());
  bad((s) => { s.entries[0].dan = 'eta'; });
  bad((s) => { s.entries[0].dan = 'theta'; });
  bad((s) => { s.entries[1].id = s.entries[0].id; });
  bad((s) => { s.entries[0].id = 'reform-1st'; });
  bad((s) => { s.entries[0].url = 'javascript:alert(1)'; });
  bad((s) => { s.entries[0].star = null; });
  bad((s) => { s.entries[0].pattern = 'ln'; });
});
