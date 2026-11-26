import { ladder, ladderCurvePoints, parseAcc, LADDER_LABEL, LADDER_UNRELIABLE_NOTE, reverseNote, reverseCaption, lnNote } from './acc-ladder.js';
import { danPoints, danTiers, singlePoints, locateDan, danText } from './dan-estimate.js';
import { normalizeRate, RATE_ANCHORS, buildRateCurve, missingAnchors } from './rate-curve.js';
import { createPlot, liveRegion } from './chart-plot.js';

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function button(text, role, click) {
  const el = node('button', '', text);
  el.type = 'button';
  el.dataset.role = role;
  el.addEventListener('click', click);
  return el;
}

function input(type, min, max, step, value, name, role) {
  const el = node('input');
  Object.assign(el, { type, min, max, step, value });
  if (type === 'number') el.inputMode = 'decimal';
  el.setAttribute('aria-label', name);
  el.dataset.role = role;
  return el;
}

function referenceScale(data) {
  const whole = danTiers(danPoints(data, 'reform')), singles = danTiers(singlePoints(data));
  return {
    tiers: whole,
    text(star) {
      const single = singles.length > 1 ? locateDan(star, singles) : null;
      return `整段：${danText(locateDan(star, whole))} / 单曲：${danText(single)}`;
    },
  };
}

function accuracyLines(params, star, rate) {
  const samples = ladderCurvePoints(params, star, rate);
  let current = { kind: samples[0].label, points: [] };
  const lines = [current];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (current.kind !== sample.label) {
      const x = (samples[i - 1].acc + sample.acc) / 2;
      const join = { x, star: ladder(params, star, x, rate).star };
      current.points.push(join);
      current = { kind: sample.label, points: [join] };
      lines.push(current);
    }
    current.points.push({ x: sample.acc, star: sample.star });
  }
  return lines;
}

export function createAccChart({ params, P = params, result, references, acc = 96, onAcc }) {
  const section = node('section', 'acc-panel');
  section.setAttribute('aria-label', '准确率与达成水平');
  section.append(node('h3', 'chart-heading', '准确率与达成水平'));
  if (!P || !Number.isFinite(result?.star)) {
    section.append(node('p', 'chart-note', '暂时没有可用的准确率曲线。'));
    return section;
  }
  const { star, rate = 1 } = result;
  const scale = referenceScale(references);
  const legend = node('div', 'chart-legend');
  legend.append(node('span', 'legend-observed', '实线 · 观测'), node('span', 'legend-extrap', '虚线 · 外推'),
    node('span', 'legend-dan', '水平线 · REFORM 整段'));
  const readout = node('output', 'chart-readout');
  readout.setAttribute('aria-live', 'off');
  const caution = node('p', 'chart-note');
  const controls = node('div', 'chart-controls'), chips = node('div', 'chart-chips');
  const slider = input('range', 85, 99.5, 0.1, acc, '目标准确率滑条（%）', 'acc-range');
  const number = input('number', 85, 99.5, 0.1, acc, '目标准确率（%）', 'acc-number');
  let editing = false;
  const describe = (value, score) => `${value.toFixed(1)}%，${score.toFixed(2)} 星`;
  function show(value) {
    const reading = ladder(P, star, value, rate);
    const category = LADDER_LABEL[reading.label];
    const needed = reading.below ? '低于刻度' : `★ ${reading.star.toFixed(2)}`;
    const label = node('span', 'ladder-tag ' + reading.label, category.text);
    label.title = category.title;
    readout.replaceChildren(document.createTextNode(`打出 ${value.toFixed(1)}% ≈ ${needed}（${scale.text(reading.star)}） `), label);
    slider.value = value;
    if (!editing) number.value = value.toFixed(1);
    for (const chip of chips.children) chip.setAttribute('aria-pressed', Number(chip.value) === value);
    const note = reverseNote(P, value);
    caution.hidden = !note;
    caution.textContent = note?.text || '';
    onAcc?.(value);
  }
  const initial = parseAcc(P, acc) ?? 96;
  const plot = createPlot({
    title: 'ScoreV1 准确率与所需水平。方向键每次调整 0.1%。', yTitle: '所需水平 ★', min: 85, max: 99.5, step: 0.1,
    ticks: [85, 90, 93, 96, 98, 99], tickLabel: t => t + '%', describe, lines: accuracyLines(P, star, rate),
    tiers: scale.tiers, anchor: { x: 96, star, label: `96% · ★ ${star.toFixed(2)}` },
    initial, valueAt: value => ladder(P, star, value, rate).star, onMove: show,
  });
  for (const value of [90, 93, 96, 98, 99]) {
    const chip = button(value + '%', 'acc-preset', () => plot.move(value));
    chip.value = value;
    chips.append(chip);
  }
  slider.addEventListener('input', () => plot.move(Number(slider.value)));
  number.addEventListener('input', () => {
    const value = parseAcc(P, number.value);
    if (value == null) return;
    editing = true;
    plot.move(value);
    editing = false;
  });
  number.addEventListener('change', () => plot.move(parseAcc(P, number.value) ?? Number(slider.value)));
  const field = node('label', 'chart-field', '目标准确率（%）');
  field.append(number);
  controls.append(chips, slider, field);
  section.append(node('p', 'chart-note', '按 stable ScoreV1 和当前 OD 换算。96% 对应这张谱的总星数。'),
    legend, plot.host, controls, readout, caution, node('p', 'chart-note', reverseCaption(P)));
  const holdNote = lnNote(result);
  if (holdNote) section.append(node('p', 'chart-note dan-caution', holdNote));
  if (result.reliable === false) section.append(node('p', 'chart-note dan-caution', LADDER_UNRELIABLE_NOTE));
  plot.move(initial);
  return section;
}

export function createRateChart({ points, rate, references, onRate }) {
  const chart = node('div', 'rate-chart');
  const curve = buildRateCurve(points), scale = referenceScale(references);
  if (curve.length !== 151) return chart;
  const byRate = new Map(curve.map(p => [p.rate, p]));
  const readout = node('output', 'chart-readout');
  readout.setAttribute('aria-live', 'off');
  const current = normalizeRate(rate);
  const describe = (value, star) => `${value.toFixed(2)}× · ★ ${star.toFixed(2)}`;
  const plot = createPlot({
    title: '倍速与总星数，方向键预览，回车计算。', yTitle: '总星数 ★', min: 0.5, max: 2, step: 0.01,
    ticks: RATE_ANCHORS, tickLabel: value => value.toFixed(2) + '×', describe,
    lines: [{ points: curve.map(p => ({ x: p.rate, star: p.star })) }],
    marks: curve.filter(p => p.measured).map(p => ({ x: p.rate, star: p.star })),
    tiers: scale.tiers, selected: current, initial: current, valueAt: value => byRate.get(value).star,
    onMove(value) {
      const p = byRate.get(value);
      readout.textContent = `${describe(value, p.star)}（${scale.text(p.star)}） · ${p.measured ? '实算' : '插值预览'}`;
    },
    onPick: onRate,
  });
  chart.append(node('p', 'chart-note', '实心点为模型实算值，连线为平滑插值预览。点击曲线可按 0.01× 精算，并更新下方准确率曲线。'),
    plot.host, readout);
  plot.move(current);
  return chart;
}

export function createRatePanel({ state, rate = 1, references, nActions = 0, nLongNotes = 0, seconds,
  getPoints, onPreview, onSelect, computeAnchor, cancelAnchor }) {
  const section = node('section', 'rate-panel');
  section.setAttribute('aria-label', '倍速调节');
  const current = normalizeRate(rate);
  const controls = node('div', 'chart-controls'), chips = node('div', 'chart-chips');
  const slider = input('range', 0.5, 2, 0.01, current, '播放倍速滑条', 'rate-range');
  const number = input('number', 0.5, 2, 0.01, current.toFixed(2), '播放倍速（×）', 'rate-number');
  const longNote = node('p', 'chart-note'), longChart = nActions >= 10000 || nLongNotes >= 4000;
  const cached = value => getPoints().some(p => normalizeRate(p.rate) === value && Number.isFinite(p.star));
  function preview(value, format = true) {
    slider.value = value;
    if (format) number.value = value.toFixed(2);
    for (const chip of chips.children) chip.setAttribute('aria-pressed', Number(chip.value) === value);
    longNote.hidden = !longChart || cached(value);
    onPreview?.(value);
  }
  function select(value) {
    state.dismiss();
    preview(value);
    onSelect(value);
  }
  for (const [value, name] of [[0.75, 'HT'], [1, 'NoMod'], [1.5, 'DT']]) {
    const chip = button(`${name} ${value.toFixed(2)}×`, 'rate-preset', () => select(value));
    chip.value = value;
    chips.append(chip);
  }
  function commitNumber() {
    if (Number.isFinite(number.valueAsNumber)) select(normalizeRate(number.valueAsNumber));
    else preview(current);
  }
  slider.addEventListener('input', () => preview(normalizeRate(slider.value)));
  slider.addEventListener('change', () => select(normalizeRate(slider.value)));
  number.addEventListener('input', () => {
    if (Number.isFinite(number.valueAsNumber)) preview(normalizeRate(number.valueAsNumber), false);
  });
  number.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitNumber();
  });
  const field = node('label', 'chart-field', '倍速（×）');
  field.append(number);
  longNote.textContent = '这张谱的物件或长条较多，单次计算预计约 10–30 秒，可随时点击取消。';
  controls.append(chips, slider, field, button('计算', 'rate-calculate', commitNumber));
  section.append(node('h3', 'chart-heading', '倍速与星数'), controls, longNote);
  const curveArea = node('div', 'curve-area');
  function renderCurve(focusRole = '') {
    const phase = state.phase;
    const points = getPoints(), missing = missingAnchors(points);
    if (phase === 'complete' && !missing.length) {
      curveArea.replaceChildren(createRateChart({ points, rate: current, references, onRate: select }));
    } else if (phase === 'warning' || phase === 'confirm') {
      const second = phase === 'confirm', box = node('div', 'curve-warning');
      box.dataset.step = second ? '2' : '1';
      const perPoint = seconds > 0 && Number.isFinite(seconds) ? seconds : (longChart ? 30 : Math.max(3, Math.ceil(nActions / 750)));
      const duration = Math.ceil(perPoint * missing.length), count = missing.length;
      const firstHint = `还需计算 ${count} 个锚点，预计约 ${duration} 秒。全倍速曲线需要在你的浏览器本地连续运行多次神经网络计算，期间可能较耗时且占用较高 CPU，是否继续？`;
      const secondHint = `再次确认：即将开始后台逐点计算 ${count} 个倍速锚点（预计约 ${duration} 秒），过程中可随时点击取消，确定现在开始吗？`;
      const actions = node('div', 'curve-actions');
      actions.append(second ? button('确认开始计算', 'curve-confirm', () => state.start({ getPoints, computeAnchor, cancelAnchor }))
        : button('继续', 'curve-continue', state.proceed), button(second ? '放弃' : '取消', 'curve-dismiss', state.dismiss));
      box.append(node('p', '', second ? secondHint : firstHint), actions);
      curveArea.replaceChildren(box);
    } else if (phase === 'running') {
      const status = node('div', 'curve-progress');
      status.setAttribute('role', 'status');
      status.textContent = `全倍速曲线计算中 ${7 - missing.length} / 7（${state.current.toFixed(2)}×）…`;
      curveArea.replaceChildren(status, button('停止计算', 'curve-stop', state.dismiss));
    } else {
      const children = [];
      if (phase === 'failed') children.push(node('p', 'chart-note dan-caution', `计算中断：${state.error}。已完成的倍速已保留。`));
      if (phase === 'stopped') children.push(node('p', 'chart-note', `已停止全倍速计算，已保留 ${7 - missing.length} 个锚点。`));
      children.push(button('生成全倍速曲线（0.50×–2.00×）', 'curve-generate', state.request));
      curveArea.replaceChildren(...children);
    }
    if (focusRole) {
      const target = { warning: 'curve-continue', confirm: 'curve-confirm', running: 'curve-stop',
        idle: 'curve-generate', stopped: 'curve-generate', failed: 'curve-generate' }[phase];
      const next = target ? curveArea.querySelector(`[data-role="${target}"]`) : curveArea.querySelector('svg');
      next?.focus({ preventScroll: true });
    }
  }
  const lifecycle = liveRegion(() => {
    renderCurve();
    return state.subscribe(() => renderCurve(curveArea.contains(document.activeElement)));
  });
  lifecycle.append(curveArea);
  section.append(lifecycle);
  for (const chip of chips.children) chip.setAttribute('aria-pressed', Number(chip.value) === current);
  longNote.hidden = !longChart || cached(current);
  return section;
}
