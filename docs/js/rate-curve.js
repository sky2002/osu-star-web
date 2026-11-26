export const RATE_ANCHORS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);

export function normalizeRate(value) {
  if (value == null || String(value).trim() === '') return 1;
  const number = Number(value);
  if (Number.isNaN(number)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(number * 100) / 100));
}

export function settingKey(rate, od = null) {
  return `${normalizeRate(rate).toFixed(2)}|${od === null ? 'file' : od.toFixed(1)}`;
}

export function missingAnchors(points) {
  const done = new Set(points.filter(p => Number.isFinite(p.star)).map(p => normalizeRate(p.rate)));
  return RATE_ANCHORS.filter(rate => !done.has(rate));
}

function measuredPoints(points) {
  const byRate = new Map();
  for (const p of points) {
    if (Number.isFinite(p.rate) && Number.isFinite(p.star)) byRate.set(normalizeRate(p.rate), p.star);
  }
  return [...byRate].sort(([a], [b]) => a - b).map(([rate, star]) => ({ rate, star }));
}

/** Fritsch–Carlson 单调三次 Hermite 曲线；局部极值取水平切线，平段内保持常数。 */
export function buildRateCurve(points) {
  const measured = measuredPoints(points);
  if (measured.length < 2) return [];
  const width = [], slopes = [], tangent = [];
  for (let i = 0; i + 1 < measured.length; i++) {
    width.push(measured[i + 1].rate - measured[i].rate);
    slopes.push((measured[i + 1].star - measured[i].star) / width[i]);
  }
  tangent.push(slopes[0]);
  for (let i = 1; i < slopes.length; i++) {
    tangent.push(slopes[i - 1] * slopes[i] > 0 ? (slopes[i - 1] + slopes[i]) / 2 : 0);
  }
  tangent.push(slopes[slopes.length - 1]);
  for (let i = 0; i < slopes.length; i++) {
    if (slopes[i] === 0) {
      tangent[i] = tangent[i + 1] = 0;
      continue;
    }
    const length = Math.hypot(tangent[i] / slopes[i], tangent[i + 1] / slopes[i]);
    if (length > 3) {
      tangent[i] *= 3 / length;
      tangent[i + 1] *= 3 / length;
    }
  }
  const curve = [];
  let i = 0;
  for (let c = Math.round(measured[0].rate * 100); c <= Math.round(measured.at(-1).rate * 100); c++) {
    const rate = c / 100;
    while (rate > measured[i + 1].rate) i++;
    const a = measured[i], b = measured[i + 1];
    if (rate === a.rate || rate === b.rate) {
      curve.push({ rate, star: rate === a.rate ? a.star : b.star, measured: true });
      continue;
    }
    if (a.star === b.star) {
      curve.push({ rate, star: a.star, measured: false });
      continue;
    }
    const t = (rate - a.rate) / width[i], s = 1 - t;
    const star = s * s * (1 + 2 * t) * a.star + t * t * (3 - 2 * t) * b.star
      + width[i] * t * s * (s * tangent[i] - t * tangent[i + 1]);
    curve.push({ rate, star, measured: false });
  }
  return curve;
}

/** 一份状态属于一张谱的一个模型和 OD。每次运行都从实算缓存重新清点锚点。 */
export function createRateCurveState() {
  let epoch = 0, cancelCurrent = null;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(); };
  const state = {
    phase: 'idle', current: null, error: '',
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    request() {
      if (!['idle', 'stopped', 'failed'].includes(state.phase)) return;
      state.phase = 'warning';
      state.error = '';
      notify();
    },
    proceed() {
      if (state.phase !== 'warning') return;
      state.phase = 'confirm';
      notify();
    },
    dismiss() {
      if (state.phase === 'complete' || state.phase === 'idle') return;
      const running = state.phase === 'running';
      const cancel = cancelCurrent;
      epoch++;
      cancelCurrent = null;
      state.current = null;
      state.phase = running ? 'stopped' : 'idle';
      if (running) cancel?.();
      notify();
    },
    async start({ getPoints, computeAnchor, cancelAnchor }) {
      if (state.phase !== 'confirm') return;
      const run = ++epoch;
      state.phase = 'running';
      try {
        for (const rate of RATE_ANCHORS) {
          if (!missingAnchors(getPoints()).includes(rate)) continue;
          state.current = rate;
          cancelCurrent = cancelAnchor;
          notify();
          if (run !== epoch) return;
          await computeAnchor(rate);
          if (run !== epoch) return;
          cancelCurrent = null;
          if (missingAnchors(getPoints()).includes(rate)) throw new Error('未收到该倍速的星数，请重试。');
        }
        state.phase = 'complete';
      } catch (error) {
        if (run !== epoch) return;
        state.phase = 'failed';
        state.error = error?.message || String(error);
      } finally {
        if (run === epoch) {
          cancelCurrent = null;
          state.current = null;
          notify();
        }
      }
    },
  };
  return state;
}
