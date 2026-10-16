// 米 / 面段位纯函数：node --test tests/dan-estimate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  danPoints, poolAdjacent, danTiers, locateDan, danText, danEstimate, danEstimateCopyLines, fmtDanPos,
  DAN_MERGE_GAP, DAN_REFORM_3RD_SUBSTITUTE_STAR, DAN_LN_FEW, DAN_FEW_LN_NOTE, DAN_UNRELIABLE_NOTE,
} from '../docs/js/dan-estimate.js';
import { validateDanReferences } from '../docs/js/dan-reference.js';
import { buildCopyText } from '../docs/js/ui-lib.js';

const data = validateDanReferences(JSON.parse(fs.readFileSync(new URL('../docs/data/dan-references.json', import.meta.url), 'utf8')));
const pt = (pos, star, label = String(pos)) => ({ pos, star, label });
const ok = (star, extra = {}) => ({ ok: true, star, reliable: true, rate: 1, v2: { star: star + 0.6 }, lnFrac: 0.7, ...extra });

test('reference points: REFORM 1st..Eta without INTRO (17), LN 5th..15th on starV2 (11)', () => {
  const r = danPoints(data, 'reform');
  assert.deepEqual(r.map((x) => x.label), ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta']);
  assert.deepEqual(r.map((x) => x.pos), Array.from({ length: 17 }, (_, i) => i + 1));
  const l = danPoints(data, 'ln');
  assert.deepEqual(l.map((x) => x.pos), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.ok(Math.abs(r.find((x) => x.pos === 3).star - DAN_REFORM_3RD_SUBSTITUTE_STAR) < 1e-9);
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

test('tiers closer than 0.05 stars merge; the substituted 3rd keeps 2nd/3rd apart, LN 14th/15th still merge', () => {
  const t = danTiers([pt(1, 1.0, 'a'), pt(2, 1.04, 'b'), pt(3, 1.2, 'c')]);
  assert.deepEqual(t.map((x) => x.label), ['a–b', 'c']);
  assert.equal(danTiers([pt(1, 1.0, 'a'), pt(2, 1.0 + DAN_MERGE_GAP, 'b')]).length, 2);
  const r = danTiers(danPoints(data, 'reform'));
  assert.ok(r.some((x) => x.label === '2nd'));
  assert.ok(r.some((x) => x.label === '3rd'));
  assert.ok(!r.some((x) => x.label === '2nd–3rd'));
  for (let i = 1; i < r.length; i++) assert.ok(r[i].star - r[i - 1].star >= DAN_MERGE_GAP);
  const l = danTiers(danPoints(data, 'ln'));
  assert.deepEqual(l.filter((x) => x.merged).map((x) => x.label), ['14th–15th']);
});

test('locate: between with runner.md qualifier bands, below, above with extrapolated position', () => {
  const tiers = danTiers([pt(7, 5.0, '7th'), pt(8, 5.3, '8th'), pt(9, 6.0, '9th')]);
  const at = (s) => locateDan(s, tiers);
  // pos 7.83 → 最近锚 8th，d=−0.17 → mid/low；pos 7.17 → 7th，d=+0.17 → mid/high；pos 7.5 → 平局取低档，d=+0.5 → high
  assert.equal(danText(at(5.25)), '8th mid/low（7.83）');
  assert.equal(danText(at(5.05)), '7th mid/high（7.17）');
  assert.equal(danText(at(5.15)), '7th high（7.50）');
  assert.ok(Math.abs(at(5.15).pos - 7.5) < 1e-12);
  assert.equal(at(5.0).kind, 'between');
  assert.equal(at(6.0).kind, 'between');
  assert.equal(danText(at(4.0)), '7th 以下');
  assert.equal(danText(at(4.0), { prefix: 'LN' }), 'LN7 以下');
  assert.equal(danText(at(6.5)), '!9+');
  assert.equal(danText(at(6.5), { prefix: 'LN' }), '!9+');
  assert.ok(at(6.5).extrapolated && Math.abs(at(6.5).pos - (9 + 0.5 / 0.7)) < 1e-12);
  assert.ok(at(4.7).extrapolated && Math.abs(at(4.7).pos - (7 - 0.3 / 0.3)) < 1e-12);
  assert.equal(locateDan(NaN, tiers), null);
});

test('an anchor-exact reading reads "tier mid"; a reference chart reads itself as its own dan', () => {
  const tiers = danTiers([pt(7, 5.0, '7th'), pt(8, 5.3, '8th'), pt(9, 6.0, '9th')]);
  assert.equal(danText(locateDan(5.0, tiers)), '7th mid（7.00）');
  assert.equal(danText(locateDan(5.3, tiers)), '8th mid（8.00）');
  assert.equal(danText(locateDan(6.0, tiers), { prefix: 'LN' }), 'LN9 mid（9.00）');
  assert.equal(danText(locateDan(5.04, tiers)), '7th mid/high（7.13）');
  const ln = danTiers(danPoints(data, 'ln'));
  for (const t of ln) {
    const short = t.label.replace(/(\d+)(st|nd|rd|th)/g, '$1');
    assert.equal(danText(locateDan(t.star, ln), { prefix: 'LN' }), `LN${short} mid（${t.pos.toFixed(2)}）`);
  }
});

test('merged tiers read with the merged label and the qualifier bands', () => {
  const tiers = danTiers([pt(1, 2.62, '1st'), pt(2, 2.88, '2nd'), pt(3, 2.90, '3rd'), pt(4, 3.60, '4th')]);
  assert.equal(danText(locateDan(2.83, tiers)), '2nd–3rd low（2.17）');
  assert.equal(danText(locateDan(3.4, tiers)), '4th low（3.58）');
  assert.equal(danText(locateDan(3.5, tiers)), '4th mid/low（3.79）');
});

test('danEstimate on the live references: rice and face, LN below 6th, few long notes, unreliable, rates', () => {
  const band = '(mid\\/low|low|mid\\/high|mid|high)';
  const e = danEstimate(ok(5.35, { v2: { star: 6.1 } }), data);
  assert.equal(e.rice.text, '8th mid/low（7.74）');
  assert.match(e.face.text, new RegExp(`^LN\\d+(-\\d+)? ${band}（\\d+\\.\\d{2}）$`));
  assert.equal(e.face.muted, false);
  assert.equal(e.unreliable, false);
  assert.equal(e.rateNote, '');
  assert.equal(danEstimate(ok(3, { v2: { star: 4.0 } }), data).face.text, 'LN5 以下');
  assert.equal(danEstimate(ok(11, { v2: { star: 12 } }), data).rice.text, '!17+');
  assert.equal(danEstimate(ok(11, { v2: { star: 12 } }), data).face.text, '!15+');
  assert.equal(danEstimate(ok(1.0), data).rice.text, '1st 以下');
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
  assert.match(lines[0], /^米段位：\S+ (mid\/low|low|mid\/high|mid|high)（\d+\.\d{2}）（不可靠）；位置 [0-9.]+（1st=1/);
  assert.match(lines[1], new RegExp(`^面段位：.*（${DAN_FEW_LN_NOTE}）（不可靠）；位置`));
  assert.match(lines[2], /^DT：/);
  assert.equal(fmtDanPos(locateDan(20, danTiers(danPoints(data, 'reform'))), 'reform').startsWith('约 '), true);
  const text = buildCopyText(ok(5.35), {}, 'x.osu', { version: 'v', frozen: 'f' }, null, null, false, danEstimate(ok(5.35), data));
  assert.match(text, /\n米段位：\S+ (mid\/low|low|mid\/high|mid|high)（\d+\.\d{2}）；位置/);
  assert.match(text, /\n面段位：LN/);
  assert.equal(DAN_UNRELIABLE_NOTE.length > 0, true);
});
