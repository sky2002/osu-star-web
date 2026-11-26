import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateDanReferences } from '../docs/js/dan-reference.js';
import { patternItemView, segmentCaption, V4_SEG_CAPTION, SEG_CAPTION, V4_ITEMS_NOTE, V4_ITEMS_UNTESTED_NOTE } from '../docs/js/ui-lib.js';
import { sortItems } from '../docs/js/v4-items.js';
import { V3_REFERENCES } from '../docs/js/v3-star.js';
import {
  STAR_MODELS, DEFAULT_STAR_MODEL, MODEL_KEY, loadStarModel, saveStarModel, scoreRequest,
  V4_VERSION, V4_FROZEN, V4_UNTESTED_NOTE, cardView, comparisonView, cardCopyText,
} from '../docs/js/v4-star.js';

const v3Path = new URL('../docs/data/dan-references-v3.json', import.meta.url);
const v3Refs = validateDanReferences(JSON.parse(fs.readFileSync(v3Path)), V3_REFERENCES);
const item = (id, star, share, display = true) => ({ id, star, share, display });
const items = [item('ln', 7.3, .9, false), item('tech', 5.25, .2), item('jack', 6.5, .2),
  item('chordstream', 5.25, .2), item('stream', 5.9, .45)];
const segment = (star) => ({ startS: 5, endS: 15, star, nObj: 60, sparse: false });
const ok4 = (over = {}) => ({ ok: true, star: 6, theta: 1, items: sortItems(items), stamina: item('stamina', 6.7, .67),
  segments: [segment(6.2)], hardest: segment(6.2), ...over });
const ok3 = { ok: true, star: 5.5, theta: .5 };
const raw = (over = {}) => ({ ok: true, star: 5, rate: 1, hit: '', odOverride: null, flags: {},
  v2: { star: 5.5 }, sub: { rice: { ok: true, star: 5 }, v2: { star: 5.5 } },
  segments: [segment(4.3)], hardest: segment(4.3), v4: ok4(), v3: ok3, ...over });

test('v4 is selected by default and the page remembers its own model choice', () => {
  assert.deepEqual(STAR_MODELS, ['v4', 'v3', 'p1h', 'cnn36', 'both']);
  assert.equal(DEFAULT_STAR_MODEL, 'v4');
  assert.equal(MODEL_KEY, 'osu-star-web.model.v4');
  const previous = new Map([['osu-star-web.model.v3', 'p1h']]);
  const storage = { getItem: (key) => previous.get(key), setItem: (key, value) => previous.set(key, value) };
  assert.equal(loadStarModel(storage), 'v4');
  assert.equal(loadStarModel(null), 'v4');
  saveStarModel(storage, 'both');
  saveStarModel(storage, 'invalid');
  assert.equal(loadStarModel(storage), 'both');
  const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-model="v4" aria-pressed="true"/);
  assert.match(html, /data-model="both"[^>]+>对比 v3/);
});

test('switching models and features requests only missing readings', () => {
  assert.deepEqual(scoreRequest(null, 'v4', false), {
    type: 'score', withSub: false, withItems: false, withSegments: false, withV4: true, withV3: false, withCnn: false,
  });
  assert.deepEqual(scoreRequest(null, 'both', true), {
    type: 'score', withSub: true, withItems: false, withSegments: false, withV4: true, withV3: true, withCnn: false,
  });
  const result = raw({ v4Computed: true, v3Computed: true });
  assert.equal(scoreRequest(result, 'both', false), null);
  assert.deepEqual(scoreRequest(result, 'v3', false), {
    type: 'score', withSub: false, withItems: true, withSegments: true, withV4: false, withV3: false, withCnn: false,
  });
  assert.deepEqual(scoreRequest({ ...result, v4Computed: false, legacyComputed: true }, 'v4', false), { type: 'v4' });
  assert.deepEqual(scoreRequest({ ...result, legacyComputed: true }, 'cnn36', false), { type: 'cnn' });
  assert.equal(scoreRequest({ ok: false, reason: 'not_4k' }, 'v4', false), null);
});

test('v4 displays all five rows by loss share, preserving the order of ties and the raw readings', () => {
  const result = raw();
  const source = structuredClone(result.v4.items);
  const view = patternItemView(cardView(result, 'v4').r);
  assert.deepEqual(view.rows.map((r) => r.label), ['面（长条）', '乱', '叠（jack）', '切（双押切、三押切）', '技（节奏变化、协调）']);
  assert.deepEqual(view.rows.map((r) => r.star), [null, 5.9, 6.5, 5.25, 5.25]);
  assert.deepEqual(view.rows.map((r) => r.share), [.9, .45, .2, .2, .2]);
  assert.equal(view.rows[0].text, '这类键太少');
  assert.deepEqual(result.v4.items, source);
  assert.equal(view.stamina.label, '耐力（高疲劳段）');
  assert.equal(view.stamina.star, 6.7);
  assert.equal(view.stamina.share, .67);
  assert.equal(view.untestedNote, '');
  assert.equal(view.hints, undefined);
  const short = raw({ v4: ok4({ stamina: item('stamina', null, 0, false) }) });
  assert.equal(patternItemView(cardView(short, 'v4').r).stamina.text, '耐力段较短');
});

test('all rates and OD settings expose six rows with a caveat, while SV keeps the rows off', () => {
  for (const settings of [{ rate: 0.5 }, { rate: 0.75 }, { rate: 1.15 }, { rate: 1.5 }, { rate: 2 }, { odOverride: 8 }, { hit: 'hr' }, { hit: 'ez' }]) {
    const cv = cardView(raw({ ...settings, v4: ok4({ itemsUntested: true }) }), 'v4');
    const view = patternItemView(cv.r);
    assert.equal(view.state, 'ok');
    assert.equal(view.rows.length, 5);
    assert.equal(view.stamina.star, 6.7);
    assert.equal(view.untestedNote, '非原速或自定义 OD 下的六维分项未经检验，仅供参考');
    assert.ok(cardCopyText(cv).includes(V4_ITEMS_UNTESTED_NOTE));
  }
  const sv = cardView(raw({ flags: { sv: true }, v4: ok4({ itemsUntested: true }) }), 'v4');
  assert.equal(patternItemView(sv.r).state, 'off');
  assert.match(patternItemView(sv.r).text, /非变速谱/);
  assert.ok(!cardCopyText(sv).includes(V4_ITEMS_UNTESTED_NOTE));
});

test('both the card and the six-item help explain why shares may not sum to 100 percent', () => {
  const note = '各项占比可以重叠，且不含慢速或零散过渡音符，所以加起来不必刚好等于 100%。';
  const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const help = html.split('<summary>六维键型分项（测试版）</summary>')[1]?.split('</details>')[0];
  assert.ok(help?.includes(note));
  assert.ok(V4_ITEMS_NOTE.includes(note));
});

test('v4 switches the curve and shifts only the separate experimental readings', () => {
  const result = raw({ reliable: false, flags: { outOfRange: true, outOfRangeReasons: ['旧版范围提示'] } });
  const v4 = cardView(result, 'v4').r;
  assert.equal(v4.star, 6);
  assert.equal(v4.v2.star, 6.5);
  assert.equal(v4.sub.rice.star, 6);
  assert.equal(v4.segments, result.v4.segments);
  assert.equal(v4.hardest, result.v4.hardest);
  assert.equal(segmentCaption(v4), V4_SEG_CAPTION);
  assert.equal(v4.reliable, true);
  assert.deepEqual(v4.flags.outOfRangeReasons, []);
  const warning = cardView(raw({ v4: ok4({ outOfRange: true, outOfRangeReasons: ['排名谱范围提示'] }) }), 'v4').r;
  assert.deepEqual(warning.flags.outOfRangeReasons, ['排名谱范围提示']);
  assert.equal(warning.reliable, false);
  assert.equal(cardView(result, 'v3').r.segments, result.segments);
  assert.equal(segmentCaption(cardView(result, 'p1h').r), SEG_CAPTION);
});

test('the comparison uses v3 stars and both v3 rice dan readings', () => {
  const cv = cardView(raw(), 'both');
  const v = comparisonView(cv, v3Refs);
  assert.equal(cv.r.star, 6);
  assert.equal(v.star, 5.5);
  assert.equal(v.delta, -.5);
  assert.ok(v.dan.rice.text && v.dan.single.text);
  const copy = cardCopyText(cv, null, v3Refs);
  assert.match(copy, /星数 v3 对比：5\.50（比上面 −0\.50）/);
  assert.match(copy, /v3 米段位（按整段）/);
  assert.match(copy, /v3 米段位（按单曲）/);
  const missing = cardView(raw({ v3: { ok: false, text: '星数 v3 加载失败' } }), 'both');
  assert.equal(missing.r.model, 'v4');
  assert.match(cardCopyText(missing), /星数 v3 对比：星数 v3 加载失败/);
});

test('a failed v4 requests fallback data once and identifies the reading shown', () => {
  const bad4 = { ok: false, reason: 'load_error', text: '星数 v4 加载失败。' };
  const result = raw({ v4: bad4, v4Computed: true, v3: null });
  assert.deepEqual(scoreRequest(result, 'v4', false), {
    type: 'score', withSub: false, withItems: true, withSegments: true, withV4: false, withV3: true, withCnn: false,
  });
  for (const mode of ['v4', 'both']) {
    const good3 = cardView({ ...result, v3: ok3 }, mode);
    assert.equal(good3.r.model, 'v3');
    assert.match(good3.notice, /当前显示 星数 v3/);
    assert.match(cardCopyText(good3), /提示：星数 v4 加载失败/);
    const bad3 = { ...result, legacyComputed: true, v3Computed: true, v3: { ok: false } };
    assert.equal(scoreRequest(bad3, mode, false), null);
    const old = cardView(bad3, mode);
    assert.equal(old.r.star, 5);
    assert.match(old.notice, /当前显示 P1h 旧版/);
  }
});

test('copy uses the v4 version and exactly the card order, with stamina on its own line', () => {
  const cv = cardView(raw(), 'v4');
  const text = cardCopyText(cv);
  assert.equal(V4_VERSION, '星数 v4 测试版');
  assert.equal(V4_FROZEN, '2026-11-23');
  assert.match(text, /版本：星数 v4 测试版（冻结日期 2026-11-23）/);
  const rows = patternItemView(cv.r).rows.map((r) => r.label);
  const lines = text.split('\n').filter((line) => line.includes('占失分'));
  assert.deepEqual(lines.map((line) => line.split(' · ')[0]), [...rows, '耐力（高疲劳段）']);
  assert.match(lines[0], /^面（长条） · — · 占失分 90% · 这类键太少$/);
  assert.match(lines.at(-1), /★ 6\.70 · 占失分 67%$/);
  assert.doesNotMatch(text, /苦手提示/);
  assert.ok(cardCopyText(cardView(raw({ rate: .75, v4: ok4({ untested: true }) }), 'v4')).includes(V4_UNTESTED_NOTE));
});
