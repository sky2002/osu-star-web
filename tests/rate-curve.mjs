import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ladder, ladderCurvePoints } from '../docs/js/acc-ladder.js';
import { RATE_ANCHORS, normalizeRate, settingKey, buildRateCurve, createRateCurveState } from '../docs/js/rate-curve.js';

const params = JSON.parse(readFileSync(new URL('../docs/model/acc-ladder.json', import.meta.url)));
const points = (rates, stars) => rates.map((rate, i) => ({ rate, star: stars[i] }));

test('rate input and cache keys use hundredths across the entire range', () => {
  for (const [input, value] of [[0, 0.5], [3, 2], [' 1.151 ', 1.15], [1.156, 1.16], [null, 1], ['', 1], ['x', 1]]) {
    assert.equal(normalizeRate(input), value);
  }
  assert.equal(settingKey(0.1 + 1.05), '1.15|file');
  assert.equal(settingKey('1', 8), '1.00|8.0');
  assert.notEqual(settingKey(1.15, 8), settingKey(1.15));
  assert.equal(new Set(Array.from({ length: 151 }, (_, i) => settingKey((50 + i) / 100))).size, 151);
});

test('PCHIP passes every measured point and keeps each interval monotone, including flats and turns', () => {
  const rates = [0.5, 0.75, 1, 1.01, 1.15, 1.25, 1.5, 1.75, 2];
  for (const stars of [
    [2, 2, 2.001, 8, 8.25, 8.251, 9, 14.61, 15],
    [11, 10, 8.5, 3, 3, 2.3, 2.1, 2.01, 1.99],
    [7, 5, 6, 9, 8, 8, 8, 10, 7.999],
    rates.map(() => 3.33),
  ]) {
    const anchors = points(rates, stars);
    const curve = buildRateCurve([...anchors].reverse());
    assert.equal(curve.length, 151);
    assert.deepEqual(curve.filter(p => p.measured).map(({ rate, star }) => ({ rate, star })), anchors);
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1], b = anchors[i];
      const segment = curve.filter(p => p.rate >= a.rate && p.rate <= b.rate);
      for (let j = 1; j < segment.length; j++) {
        const v = segment[j].star;
        assert.ok(v >= Math.min(a.star, b.star) && v <= Math.max(a.star, b.star));
        assert.ok((v - segment[j - 1].star) * (b.star - a.star) >= 0);
      }
    }
  }
});

test('a new exact measurement becomes a control point, repeated measurements share one position', () => {
  const anchors = points(RATE_ANCHORS, [1, 2, 3, 4, 5, 6, 7]);
  const before = buildRateCurve(anchors);
  assert.equal(before[65].measured, false);
  const after = buildRateCurve([...anchors, { rate: 1.15, star: 3 }, { rate: 1.15, star: 3.45 }]);
  assert.deepEqual(after[65], { rate: 1.15, star: 3.45, measured: true });
  assert.equal(after.filter(p => p.measured).length, 8);
});

test('all 151 rates give continuous accuracy curves within each speed group and preserve the 96% reading', () => {
  const star = 6.57;
  const normal = ladderCurvePoints(params, star, 1), fast = ladderCurvePoints(params, star, 1.5);
  for (let i = 50; i <= 200; i++) {
    const rate = i / 100, curve = ladderCurvePoints(params, star, rate);
    assert.equal(curve.length, 30);
    assert.equal(curve[0].acc, 85);
    assert.equal(curve.at(-1).acc, 99.5);
    assert.equal(curve.find(p => p.acc === 96).star, star);
    assert.deepEqual(curve, rate <= 1.25 ? normal : fast);
    for (let j = 1; j < curve.length; j++) {
      assert.equal(curve[j].acc - curve[j - 1].acc, 0.5);
      const between = ladder(params, star, curve[j].acc - 0.1, rate);
      assert.ok(curve[j - 1].star < between.star && between.star < curve[j].star);
    }
  }
});

test('original three rates retain exact JS readings and labels', () => {
  const normal = [5.381546088472205, 6.079127542062919, 6.57, 8.015327200386094];
  const fast = [5.09348631581315, 5.960148920118571, 6.57, 8.365648420858115];
  for (const rate of [1, 0.75, 1.5]) {
    const rows = [85, 93, 96, 99.5].map(acc => ladder(params, 6.57, acc, rate));
    assert.deepEqual(rows.map(p => p.star), rate === 1.5 ? fast : normal);
    assert.deepEqual(rows.map(p => p.label), ['extrap', 'observed', 'observed', 'extrap']);
  }
});

test('only the second confirmation can run anchors, cached points are skipped, one call at a time', async () => {
  const state = createRateCurveState(), cache = [{ rate: 1, star: 4 }], calls = [];
  let active = 0;
  const options = { getPoints: () => cache, async computeAnchor(rate) {
    assert.equal(active++, 0);
    calls.push(rate);
    await Promise.resolve();
    cache.push({ rate, star: 4 + rate });
    active--;
  } };
  state.proceed();
  await state.start(options);
  state.request();
  await state.start(options);
  assert.equal(state.phase, 'warning');
  state.dismiss();
  state.proceed();
  await state.start(options);
  assert.deepEqual(calls, []);
  state.request();
  state.proceed();
  state.dismiss();
  await state.start(options);
  assert.deepEqual(calls, []);
  state.request();
  state.proceed();
  await Promise.all([state.start(options), state.start(options)]);
  assert.deepEqual(calls, [0.5, 0.75, 1.25, 1.5, 1.75, 2]);
  assert.equal(state.phase, 'complete');
  state.dismiss();
  assert.equal(state.phase, 'complete');
});

test('stopping cancels the current anchor, retains earlier measurements and requires both warnings to resume', async () => {
  const state = createRateCurveState(), cache = [], calls = [];
  let abort;
  const options = { getPoints: () => cache,
    computeAnchor(rate) {
      calls.push(rate);
      if (!cache.length) { cache.push({ rate, star: 2 }); return Promise.resolve(); }
      return new Promise((resolve, reject) => { abort = () => reject(new Error('cancelled')); });
    },
    cancelAnchor: () => abort(),
  };
  state.request();
  state.proceed();
  const pending = state.start(options);
  await Promise.resolve();
  assert.equal(state.current, 0.75);
  state.dismiss();
  await pending;
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(cache, [{ rate: 0.5, star: 2 }]);
  state.request();
  await state.start(options);
  assert.deepEqual(calls, [0.5, 0.75]);
  state.proceed();
  await state.start({ getPoints: () => cache, computeAnchor: rate => cache.push({ rate, star: 5 }) });
  assert.equal(state.phase, 'complete');
  assert.equal(cache.length, 7);
});

test('failed anchors expose the error and leave completed anchor results reusable', async () => {
  const state = createRateCurveState(), cache = [];
  state.request();
  state.proceed();
  await state.start({ getPoints: () => cache, computeAnchor(rate) {
    if (rate === 0.75) throw new Error('资源加载失败');
    cache.push({ rate, star: 2 });
  } });
  assert.equal(state.phase, 'failed');
  assert.equal(state.error, '资源加载失败');
  assert.deepEqual(cache.map(p => p.rate), [0.5]);
});
