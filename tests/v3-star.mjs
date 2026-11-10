// Star v3 page logic (pure functions): node --test tests/v3-star.mjs
// The shift of the readings hung on the total star, the untested note, a failed v3, the "both" panel, the copy text,
// and the model switch (default and the new localStorage key).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateDanReferences } from '../docs/js/dan-reference.js';
import {
  STAR_MODELS, DEFAULT_STAR_MODEL, MODEL_KEY, needsV3, loadStarModel, saveStarModel, v3ViewResult, cardView, oldStarView,
  cardCopyText, copyVersion, V3_VERSION, V3_FROZEN, V3_UNTESTED_NOTE, V3_OFF_HINT, V3_REFERENCES,
} from '../docs/js/v3-star.js';
import { needsCnn, cnnViewResult } from '../docs/js/new-star.js';

const p1hRefs = validateDanReferences(JSON.parse(fs.readFileSync(new URL('../docs/data/dan-references.json', import.meta.url), 'utf8')));
// the placeholder file carries P1h readings under the v3 header; enough to exercise the conversion
const v3Refs = validateDanReferences(JSON.parse(fs.readFileSync(new URL('../docs/data/dan-references-v3.json', import.meta.url), 'utf8')), V3_REFERENCES);
const P1H_VER = { version: '树星数 v1 (P1h)', frozen: '2026-10-14' };

function raw(v3, over = {}) {
  return {
    ok: true, rate: 1, star: 5, reading: 0.4, theta: 0.3, title: 'T', artist: 'A', version: 'V', md5: 'abc',
    reliable: false, nNotes: 1000, od: 8,
    flags: { sv: false, storyboard: false, outOfRange: true, outOfRangeReasons: ['星数高于所有排名谱的最高读数（8.90）', '长条占比超出排名谱的范围'] },
    v2: { star: 5.6 },
    sub: { rice: { star: 4.6 }, face: { star: null }, od: { star: 5.25 }, v2: { star: 5.6 } },
    items: null,
    segments: [{ startS: 0, endS: 10, star: 4 }],
    v3,
    ...over,
  };
}
const ok3 = (star, more = {}) => ({ ok: true, star, reading: 1, theta: 0.9, thetaFlag: '', untested: false, outOfRange: false, outOfRangeReasons: [], ms: 1, ...more });

test('switch: four options, v3 is the default, new storage key', () => {
  assert.deepEqual(STAR_MODELS, ['v3', 'p1h', 'cnn36', 'both']);
  assert.equal(DEFAULT_STAR_MODEL, 'v3');
  assert.equal(MODEL_KEY, 'osu-star-web.model.v3');
  assert.ok(needsV3('v3') && needsV3('both') && !needsV3('p1h') && !needsV3('cnn36'));
  assert.ok(needsCnn('cnn36') && !needsCnn('both') && !needsCnn('v3'));
});

test('switch: a visitor who picked P1h under the old key lands on v3', () => {
  const store = new Map([['osu-star-web.model', 'p1h']]);
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(loadStarModel(ls), 'v3');
  saveStarModel(ls, 'p1h');
  assert.equal(store.get(MODEL_KEY), 'p1h');
  assert.equal(loadStarModel(ls), 'p1h');
  saveStarModel(ls, 'nonsense');
  assert.equal(loadStarModel(ls), 'p1h');
  store.set(MODEL_KEY, 'garbage');
  assert.equal(loadStarModel(ls), 'v3');
  assert.equal(loadStarModel(null), 'v3');
  assert.equal(loadStarModel({ getItem() { throw new Error('blocked'); } }), 'v3');
});

test('v3 view: total star replaced, readings on the total star shifted by v3 - P1h, curve unchanged', () => {
  const r = raw(ok3(5.7), { items: { items: { jack: { star: 5.8, s: 0.3 }, other: { star: NaN, s: 0.1 } } } });
  const v = v3ViewResult(r);
  const d = 0.7;
  assert.equal(v.model, 'v3');
  assert.equal(v.star, 5.7);
  assert.equal(v.p1hStar, 5);
  assert.equal(v.reading, 1);
  assert.ok(Math.abs(v.v2.star - (5.6 + d)) < 1e-12);
  assert.ok(Math.abs(v.sub.rice.star - (4.6 + d)) < 1e-12);
  assert.ok(Math.abs(v.sub.od.star - (5.25 + d)) < 1e-12);
  assert.ok(Math.abs(v.sub.v2.star - (5.6 + d)) < 1e-12);
  assert.equal(v.sub.face.star, null);
  assert.ok(Math.abs(v.items.items.jack.star - (5.8 + d)) < 1e-12);
  assert.ok(Number.isNaN(v.items.items.other.star));
  assert.equal(v.segments, r.segments);
  assert.equal(r.star, 5);   // the P1h result is not modified
  assert.equal(r.sub.rice.star, 4.6);
});

test('v3 view: same shift as the CNN36 view for the same star', () => {
  const r = raw(ok3(6.1), { cnn: { ok: true, star: 6.1, reading: 1, outOfRangeReasons: [] } });
  const a = v3ViewResult(r), b = cnnViewResult(r);
  // the out-of-range reasons differ on purpose: the v3 view drops every P1h reason, the CNN36 view keeps the feature ones
  const same = (x) => ({ ...x, model: 0, untested: 0, theta: 0, thetaFlag: 0, flags: 0, reliable: 0 });
  assert.deepEqual(same(a), same(b));
});

test('v3 view: P1h out-of-range reasons dropped, v3 reasons used; reliability follows', () => {
  const v = v3ViewResult(raw(ok3(5.7)));
  assert.deepEqual(v.flags.outOfRangeReasons, []);
  assert.equal(v.reliable, true);
  const clean = raw(ok3(5.7), { flags: { outOfRange: true, outOfRangeReasons: ['星数高于所有排名谱的最高读数（8.90）'] } });
  assert.equal(v3ViewResult(clean).reliable, true);
  const v3out = v3ViewResult(raw(ok3(9.5, { outOfRange: true, outOfRangeReasons: ['v3 读数高于所有排名谱的最高读数（9.10）'] }), { flags: {} }));
  assert.equal(v3out.reliable, false);
  assert.deepEqual(v3out.flags.outOfRangeReasons, ['v3 读数高于所有排名谱的最高读数（9.10）']);
  assert.equal(v3ViewResult(raw(ok3(9.5, { outOfRange: true }), { flags: {} })).reliable, false);
});

test('untested: star still given, flag carried, note in the copy text', () => {
  const r = raw(ok3(4.2, { untested: true }), { rate: 0.75 });
  const cv = cardView(r, 'v3');
  assert.equal(cv.fail, undefined);
  assert.equal(cv.r.star, 4.2);
  assert.equal(cv.r.untested, true);
  const text = cardCopyText(cv, v3Refs, p1hRefs, { header: {}, name: 'x.osu', p1hVer: P1H_VER });
  assert.ok(text.includes(`提示：${V3_UNTESTED_NOTE}`));
  assert.ok(!cardCopyText(cardView(raw(ok3(4.2)), 'v3'), v3Refs, p1hRefs, { p1hVer: P1H_VER }).includes(V3_UNTESTED_NOTE));
});

test('v3 failed: v3 mode shows the reason and the P1h hint; both mode falls back to P1h with a notice', () => {
  const fail = { ok: false, reason: 'load_error', text: '星数 v3 的模型没有加载成功（HTTP 404）' };
  const r = raw(fail);
  const cv = cardView(r, 'v3');
  assert.equal(cv.r, r);
  assert.equal(cv.fail, `${fail.text}。${V3_OFF_HINT}`);   // the reason already names v3: no second prefix
  assert.equal(cardView(raw({ ok: false, reason: 'run_error', text: '超时' }), 'v3').fail, `星数 v3：超时。${V3_OFF_HINT}`);
  assert.ok(cv.fail.includes('P1h 旧版'));
  assert.ok(cardView(raw(undefined), 'v3').fail.startsWith('星数 v3：'));
  assert.ok(cardView(raw({ ok: false, reason: 'run_error' }), 'v3').fail.includes('计算出错'));
  const both = cardView(r, 'both');
  assert.equal(both.r, r);
  assert.equal(both.old, undefined);
  assert.ok(both.notice.includes(fail.text));
  const text = cardCopyText(both, p1hRefs, p1hRefs, { p1hVer: P1H_VER });
  assert.ok(text.includes(`版本：${P1H_VER.version}`));
  assert.ok(text.includes('提示：星数 v3 没有算出来'));
});

test('p1h and cnn36 modes are unchanged; rejected charts pass through', () => {
  const r = raw(ok3(5.7));
  assert.equal(cardView(r, 'p1h').r, r);
  assert.equal(cardView(r, 'cnn36').r, r);
  assert.ok(cardView(r, 'cnn36').fail.startsWith('CNN36：'));
  const rej = { ok: false, reason: 'not_4k', message: '只支持 4K' };
  for (const m of STAR_MODELS) assert.equal(cardView(rej, m).r, rej);
});

test('both: v3 on top, old-star panel with P1h star, delta and P1h rice dan', () => {
  const r = raw(ok3(5.7), { reliable: true, flags: {} });
  const cv = cardView(r, 'both');
  assert.equal(cv.r.model, 'v3');
  assert.equal(cv.old, true);
  const o = oldStarView(cv.raw, cv.r, p1hRefs);
  assert.equal(o.star, 5);
  assert.ok(Math.abs(o.delta - (5 - 5.7)) < 1e-12);
  assert.equal(o.reliable, true);
  assert.ok(o.dan.rice && o.dan.rice.text);
  assert.ok(o.dan.single && o.dan.single.text);
  assert.equal(oldStarView(cv.raw, cv.r, null).dan, null);
  const text = cardCopyText(cv, v3Refs, p1hRefs, { header: {}, name: 'x.osu', p1hVer: P1H_VER });
  assert.ok(text.includes(`版本：${V3_VERSION}（冻结日期 ${V3_FROZEN}）`));
  assert.ok(text.includes('星数：5.70'));
  assert.ok(text.includes(`旧版星数（${P1H_VER.version}，冻结 ${P1H_VER.frozen}）：5.00（比上面 −0.70）`));
  assert.ok(text.includes('  旧版米段位：'));
  assert.ok(text.includes('  旧版米段位（按单曲换算）：'));
});

test('copy text version follows the star on the card', () => {
  assert.equal(V3_FROZEN, '2026-11-10');
  assert.equal(V3_VERSION, '星数 v3 测试版');
  assert.deepEqual(copyVersion({ model: 'v3' }, P1H_VER), { version: V3_VERSION, frozen: V3_FROZEN });
  assert.equal(copyVersion({ ok: true }, P1H_VER), P1H_VER);
  const v3text = cardCopyText(cardView(raw(ok3(5.7)), 'v3'), v3Refs, p1hRefs, { p1hVer: P1H_VER });
  assert.ok(v3text.includes(`版本：${V3_VERSION}（冻结日期 2026-11-10）`));
  assert.ok(!v3text.includes('旧版星数'));
  const p1hText = cardCopyText(cardView(raw(ok3(5.7)), 'p1h'), p1hRefs, p1hRefs, { p1hVer: P1H_VER });
  assert.ok(p1hText.includes('星数：5.00') && p1hText.includes(`版本：${P1H_VER.version}`));
});
