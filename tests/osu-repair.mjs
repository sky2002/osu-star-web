import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { decodeOsu, loadChart, metadata, parseOsuFeat, primaryBpm } from '../docs/js/osu.js';
import { prepareFeatureNotes } from '../docs/js/features.js';
import { tokensFromNotes } from '../docs/js/tokens.js';
import { listOsz } from '../docs/js/ui-lib.js';

const tap = (x, at) => `${x},192,${at},1,0,0:0:0:0:`;
const hold = (x, at, end) => `${x},192,${at},128,0,${end}:0:0:0:0:`;
const later = Array.from({ length: 20 }, (_, i) => tap(64 + (i % 4) * 128, 2000 + 100 * i));

function chart(objects, { od = 8.7, mode = 3, keys = 4, timing = [] } = {}) {
  return [
    'osu file format v14', '[General]', `Mode: ${mode}`, '[Metadata]', 'TitleUnicode: 测试谱',
    '[Difficulty]', `CircleSize: ${keys}`, ...(od === null ? [] : [`OverallDifficulty: ${od}`]),
    '[TimingPoints]', ...timing, '[HitObjects]', ...objects,
  ].join('\r\n');
}

test('a clean chart keeps note order, fractional times, file OD and the feature parser’s integer times', () => {
  const text = chart([
    hold(512, 225.625, 325.625), tap('-0', 100.125), tap(64, 100.5),
    tap(320, 225.625), tap(512, 325.625), ...later,
  ]);
  const main = loadChart(text);
  const feature = parseOsuFeat(text);
  assert.deepEqual(main.repairs, []);
  assert.deepEqual(feature.repairs, []);
  assert.equal(main.od, 8.7);
  assert.equal(feature.od, 8.7);
  assert.deepEqual(main.notes.slice(0, 5), [
    [0, 0, -0, 0], [0.375, 0.375, 0, 0], [125.5, 125.5, 2, 0], [125.5, 225.5, 3, 1], [225.5, 225.5, 3, 0],
  ]);
  assert.deepEqual(feature.notes.slice(0, 5), [[225, 3, 325], [100, 0, -1], [100, 0, -1], [225, 2, -1], [325, 3, -1]]);
  assert.deepEqual(Array.from(prepareFeatureNotes(feature).s.slice(0, 5)), [0, 0, 125, 125, 225]);
  assert.equal(tokensFromNotes(main.notes).nActions, later.length + 6);
});

test('repairs duplicate heads and crossing long notes in both parsers', () => {
  const text = chart([
    hold(100, 180, 260), tap(12, 100), tap(128, 100), tap(120, 100),
    hold(40, 100, 500), hold(100, 100, 400), tap(100, 180.5), ...later,
  ]);
  const main = loadChart(text);
  const feature = parseOsuFeat(text);
  assert.deepEqual(main.repairs, ['已自动清理 5 个同列重叠音符']);
  assert.deepEqual(feature.repairs, main.repairs);
  assert.deepEqual(main.notes.slice(0, 4), [[0, 79, 0, 1], [0, 0, 1, 0], [80, 80, 0, 0], [80.5, 80.5, 0, 0]]);
  assert.deepEqual(feature.notes.slice(0, 4), [[180, 0, -1], [100, 1, -1], [100, 0, 179], [180, 0, -1]]);
  const tk = tokensFromNotes(main.notes);
  assert.equal(tk.nNotes, later.length + 4);
  assert.equal(tk.nActions, later.length + 5);
  assert.ok(tk.lnT.every((tail, i) => tail > tk.lnH[i]));
});

test('keeps the first of two valid holds with the same head', () => {
  const text = chart([hold(64, 100, 250), hold(64, 100, 300), ...later]);
  assert.deepEqual(loadChart(text).notes[0], [0, 150, 0, 1]);
  assert.deepEqual(parseOsuFeat(text).notes[0], [100, 0, 250]);
});

test('clamps finite coordinates, skips other object types and repairs missing OD and long-note tails', () => {
  const text = chart([
    tap(-23, 100), tap(700, 200), hold(192, 300, 300), hold(320, 400, 399),
    '64,192,500,128,0', hold(192, 600, ''), '320,192,700,128', '256,192,800,8,0,900', ...later,
  ], { od: null });
  const main = loadChart(text);
  const feature = parseOsuFeat(text);
  assert.deepEqual(main.repairs, [
    '缺少 OD 定义，已按默认 OD 5.0 计算', '已自动修正 2 个横坐标越界的物件',
    '已跳过 1 个非单点、非长条物件', '已将 5 个尾部时间缺失或无效的长条改为单点',
  ]);
  assert.deepEqual(feature.repairs, main.repairs);
  assert.equal(main.od, 5);
  assert.equal(prepareFeatureNotes(feature).od, 5);
  assert.deepEqual(main.notes.slice(0, 7), [
    [0, 0, 0, 0], [100, 100, 3, 0], [200, 200, 1, 0], [300, 300, 2, 0],
    [400, 400, 0, 0], [500, 500, 1, 0], [600, 600, 2, 0],
  ]);
  assert.deepEqual(feature.notes.slice(0, 7), [
    [100, 0, -1], [200, 3, -1], [300, 1, -1], [400, 2, -1], [500, 0, -1], [600, 1, -1], [700, 2, -1],
  ]);
  assert.equal(tokensFromNotes(main.notes).nNotes, later.length + 7);
  const declaredNaN = chart(later, { od: 'NaN' });
  assert.equal(loadChart(declaredNaN).od, 5);
  assert.equal(parseOsuFeat(declaredNaN).od, 5);
});

test('keeps mode, key count and minimum object count rejections', () => {
  const prepare = text => prepareFeatureNotes(parseOsuFeat(text));
  assert.throws(() => prepare(chart(later, { mode: 0 })), { reason: 'not_mania' });
  assert.throws(() => prepare(chart(later, { keys: 7 })), { reason: 'not_4k' });
  assert.throws(() => prepare(chart(later.slice(1))), { reason: 'too_few_notes' });
  const dropped = chart([...later.slice(1), '256,192,800,8,0,900']);
  assert.throws(() => prepare(dropped), { reason: 'too_few_notes' });
  assert.throws(() => loadChart(dropped), { reason: 'too_few_notes' });
  const duplicated = chart([...later.slice(1), later.at(-1)]);
  assert.throws(() => prepare(duplicated), { reason: 'too_few_notes' });
  assert.throws(() => loadChart(duplicated), { reason: 'too_few_notes' });
});

test('decodes UTF-8 and both UTF-16 byte orders with BOM', () => {
  const text = chart(later);
  const utf8 = Buffer.from(text, 'utf8');
  const utf8Bom = Buffer.from('\ufeff' + text, 'utf8');
  const utf16Le = Buffer.from('\ufeff' + text, 'utf16le');
  const utf16Be = Buffer.from(utf16Le).swap16();
  for (const bytes of [utf8, utf8Bom, utf16Le, utf16Be]) {
    assert.equal(decodeOsu(bytes), text);
    assert.equal(metadata(decodeOsu(bytes)).title, '测试谱');
    assert.deepEqual(loadChart(decodeOsu(bytes)), loadChart(text));
  }
  const { entries } = listOsz(zipSync({ 'map.osu': utf16Be }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].skip, null);
  assert.equal(entries[0].header.nObjects, later.length);
});

test('primary BPM weights red lines over the playable duration and combines repeated tempos', () => {
  const text = chart([tap(64, 1000), hold(192, 3000, 5500)], { timing: [
    '3300,500,4,1,0,100,1,0', '2000,-25,4,1,0,100,0,0', '-3000,250,4,1,0,100,1,0',
    '800,500,4,1,0,100,1,0', '1800,400,4,1,0,100,1,0', '4500,300,4,1,0,100,1,0',
    '6000,250,4,1,0,100,1,0',
  ] });
  assert.equal(primaryBpm(text), 120);
  assert.equal(primaryBpm(chart([tap(64, 0), hold(192, 1100, 3000)], { timing: ['0,500', '1000,250'] })), 240);
  assert.equal(primaryBpm(chart(later, { timing: ['0,-50,4,1,0,100,0,0'] })), null);
  assert.equal(primaryBpm(chart(later, { timing: ['0,NaN'] })), null);
});
