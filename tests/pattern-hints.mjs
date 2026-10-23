// "X 苦手要小心" hints of the key-pattern panel: node --test tests/pattern-hints.mjs
// Rule unit tests (thresholds, the 3–7 star range, rounding), the page conditions (NoMod, file OD, not variable speed), the copy
// lines, and the JS rule vs the independent Python rule (tools/hint-reference.py) on the 442 charts of tests/fixtures/reference-hints.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  patternHints, patternItemView, patternItemCopyLines, buildCopyText, PATTERN_HINTS, HINT_GROUP_NOTE,
} from '../docs/js/ui-lib.js';

const ref = JSON.parse(fs.readFileSync(new URL('./fixtures/reference-hints.json', import.meta.url), 'utf8'));
const shares = (jack = 0, speed = 0, ln = 0) => ({ jack: { s: jack }, speed: { s: speed }, ln: { s: ln } });
const keys = (hs) => hs.map((x) => x.key);
const one = (items, star, key) => patternHints(items, star).find((x) => x.key === key);

// a successful result as the worker returns it (items of pattern-items.js itemReadouts)
function result({ star = 5.5, jack = 0.7, speed = 0.28, ln = 0, rate = 1, odOverride = null, sv = false } = {}) {
  const item = (s, display = true, st = star + 0.5) => ({ s, display, star: st, flag: '' });
  return {
    ok: true, star, rate, odOverride, reliable: true, flags: { sv },
    items: { techTag: false, items: {
      jack: item(jack), speed: item(speed), trill_tA: item(0.01, false), ln: item(ln), kashou: item(0), trill: item(0, false),
      other: { s: 0.02 }, tech_rA: item(0.01, false),
    } },
  };
}

test('constants: jack 45 % with 0.722 and 3–7 stars, speed 90 %, long notes 30 %', () => {
  assert.deepEqual(PATTERN_HINTS, {
    jack: { name: '叠', min: 45, k: 0.722, star: [3, 7] },
    speed: { name: '速度', min: 90 },
    ln: { name: '长条', min: 30 },
  });
});

test('thresholds compare the integer percent shown on the card', () => {
  assert.deepEqual(keys(patternHints(shares(0.4449, 0.8949, 0.2949), 5)), []);
  assert.deepEqual(keys(patternHints(shares(0.4451, 0.8951, 0.2951), 5)), ['jack', 'speed', 'ln']);
  assert.deepEqual(keys(patternHints(shares(0.45, 0.9, 0.3), 5)), ['jack', 'speed', 'ln']);
  assert.equal(one(shares(0.4451), 5, 'jack').pct, 45);
  assert.deepEqual(keys(patternHints(shares(1, 1, 1), 5)), ['jack', 'speed', 'ln']);
  // missing / non-finite shares and missing items give no hint
  assert.deepEqual(patternHints({ jack: { s: null }, speed: {}, ln: { s: NaN } }, 5), []);
  assert.deepEqual(patternHints({}, 5), []);
  assert.deepEqual(patternHints(null, 5), []);
});

test('jack number: 0.722 x percent, rounded to 0.1 star (45 % -> 0.3, 70 % -> 0.5)', () => {
  const table = { 45: 0.3, 48: 0.3, 49: 0.4, 55: 0.4, 62: 0.4, 63: 0.5, 70: 0.5, 76: 0.5, 77: 0.6, 90: 0.6, 91: 0.7, 100: 0.7 };
  for (const [p, d] of Object.entries(table)) {
    const h = one(shares(Number(p) / 100), 5, 'jack');
    assert.equal(h.delta, d, `${p} %`);
    assert.equal(h.range, 'in');
    assert.ok(h.text.endsWith(`大约觉得难 ${d.toFixed(1)} 星。`), `${p} %`);
  }
  const h = one(shares(0.70), 5.91, 'jack');
  assert.equal(h.tag, '叠苦手要小心');
  assert.equal(h.text, '丢分 70% 在叠上。同水平的人里，叠最弱的三成比叠最强的三成，大约觉得难 0.5 星。');
  assert.equal(h.note, HINT_GROUP_NOTE);
  assert.equal(HINT_GROUP_NOTE, '（群体平均，不是你个人的读数）');
  assert.match(h.title, /0\.72 × 叠的失分占比/);
});

test('jack number only for a shown total star within 3–7 (both ends included)', () => {
  const at = (star) => one(shares(0.6), star, 'jack');
  for (const s of [3, 2.9951, 5, 6.999, 7, 7.0049]) {
    assert.equal(at(s).range, 'in', String(s));
    assert.equal(at(s).delta, 0.4, String(s));
  }
  for (const s of [7.0051, 7.10, 9.5]) {
    assert.equal(at(s).range, 'above', String(s));
    assert.equal(at(s).delta, null);
    assert.equal(at(s).note, '（7 星以上没检验过差几星，不给数字）');
    assert.equal(at(s).text, '丢分 60% 在叠上。');
  }
  for (const s of [2.9949, 2.99, 1.5]) {
    assert.equal(at(s).range, 'below', String(s));
    assert.equal(at(s).delta, null);
    assert.equal(at(s).note, '（3 星以下没检验过差几星，不给数字）');
  }
  // the Aquaris example of the proposal: 7.10 stars, jack 51 % -> words only
  assert.equal(one(shares(0.51, 0.48), 7.10, 'jack').text + one(shares(0.51, 0.48), 7.10, 'jack').note,
    '丢分 51% 在叠上。（7 星以上没检验过差几星，不给数字）');
});

test('speed and long notes: words only, at any star', () => {
  for (const star of [2, 5, 8]) {
    const s = one(shares(0, 0.95), star, 'speed');
    assert.equal(s.tag, '速度苦手要小心');
    assert.equal(s.text, '丢分 95% 在速度上。');
    assert.equal(s.delta, null);
    assert.equal(s.range, null);
    assert.equal(s.note, '');
    const l = one(shares(0, 0, 0.44), star, 'ln');
    assert.equal(l.tag, '长条苦手要小心');
    assert.equal(l.text, '丢分 44% 在长条上。');
    assert.equal(l.delta, null);
    assert.equal(l.note, '');
  }
  assert.deepEqual(keys(patternHints(shares(0.5, 0, 0.4), 5)), ['jack', 'ln']);
});

test('hints show only where the key-pattern items show: NoMod, file OD, not variable speed', () => {
  assert.deepEqual(keys(patternItemView(result()).hints), ['jack']);
  assert.deepEqual(keys(patternItemView(result({ jack: 0.1, speed: 0.95 })).hints), ['speed']);
  assert.deepEqual(patternItemView(result({ jack: 0.1, speed: 0.5 })).hints, []);
  for (const off of [{ rate: 1.5 }, { rate: 0.75 }, { odOverride: 9 }, { sv: true }]) {
    const v = patternItemView(result(off));
    assert.equal(v.state, 'off', JSON.stringify(off));
    assert.equal(v.hints, undefined);
  }
});

test('copy lines add one line per hint', () => {
  const lines = patternItemCopyLines(result({ jack: 0.7, ln: 0.35 }));
  assert.equal(lines.length, 4);
  assert.equal(lines[2], '苦手提示：叠苦手要小心——丢分 70% 在叠上。同水平的人里，叠最弱的三成比叠最强的三成，大约觉得难 0.5 星。（群体平均，不是你个人的读数）');
  assert.equal(lines[3], '苦手提示：长条苦手要小心——丢分 35% 在长条上。');
  assert.equal(patternItemCopyLines(result({ jack: 0.1 })).length, 2);
  assert.equal(patternItemCopyLines(result({ star: 7.1, jack: 0.51 }))[2], '苦手提示：叠苦手要小心——丢分 51% 在叠上。（7 星以上没检验过差几星，不给数字）');
  assert.equal(patternItemCopyLines(result({ rate: 1.5 })).length, 1);
  const text = buildCopyText(result(), {}, 'x.osu', { version: 'v', frozen: 'f' }, null, null, false, null);
  assert.match(text, /\n苦手提示：叠苦手要小心——丢分 70% 在叠上。/);
});

test('JS rule equals the Python rule on the 442 reference charts', () => {
  assert.equal(ref.charts.length, 442);
  let n = 0;
  for (const c of ref.charts) {
    const items = { jack: { s: c.s.jack }, speed: { s: c.s.speed }, ln: { s: c.s.ln } };
    const js = patternHints(items, c.star).map((x) => ({ key: x.key, pct: x.pct, delta: x.delta, range: x.range }));
    assert.deepEqual(js, c.hints, `chart ${c.i}`);
    n += js.length;
  }
  assert.ok(n > 0);
  assert.deepEqual(ref.info.rule, { thresholds_pct: { jack: 45, speed: 90, ln: 30 }, jack_k: 0.722, jack_star: [3, 7] });
});
