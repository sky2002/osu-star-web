const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 220, LEFT = 36, RIGHT = 64, TOP = 25, BOTTOM = 177;

function svgNode(name, attrs, text) {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text != null) el.textContent = text;
  return el;
}

/** 元素移出卡片时解除尺寸监听和状态订阅，切回标签时再连接。 */
export function liveRegion(connect) {
  if (!customElements.get('star-chart-region')) {
    customElements.define('star-chart-region', class extends HTMLElement {
      connectedCallback() { this.cleanup = this.connect?.(); }
      disconnectedCallback() { this.cleanup?.(); }
    });
  }
  const el = document.createElement('star-chart-region');
  el.style.display = 'block';
  el.connect = connect;
  return el;
}

function yScale(values) {
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * 0.07, 0.10);
  const min = low - pad, max = high + pad;
  const rawStep = (max - min) / 4;
  const unit = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].find(k => k * unit >= rawStep) * unit;
  const ticks = [];
  for (let i = Math.ceil(min / step); i <= Math.floor(max / step); i++) ticks.push(i * step);
  return { min, max, ticks, y: star => BOTTOM - (star - min) / (max - min) * (BOTTOM - TOP) };
}

/** 一个可用指针和键盘读取的坐标系。横轴标签过近时分两行，纵轴右侧留给段位名。 */
export function createPlot({ title, yTitle, min, max, step, ticks, tickLabel, describe, lines, marks = [],
  tiers, anchor, selected, initial, valueAt, onMove, onPick }) {
  const svg = svgNode('svg', { class: 'interactive-chart', role: 'slider', tabindex: 0, width: '100%', height: HEIGHT,
    'aria-label': title, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-orientation': 'horizontal' });
  const grid = svgNode('g', { 'aria-hidden': true });
  const data = svgNode('g', { 'aria-hidden': true });
  const cursor = svgNode('line', { class: 'plot-cursor' });
  const point = svgNode('circle', { class: 'plot-cursor-dot', r: 4.8 });
  svg.append(svgNode('title', {}, title), grid, data, cursor, point);
  const { y, min: low, max: high, ticks: yTicks } = yScale(lines.flatMap(line => line.points.map(p => p.star)));
  let width = 0, current = initial;
  const x = value => LEFT + (value - min) / (max - min) * (width - LEFT - RIGHT);
  function move(value, emit = true) {
    current = Math.max(min, Math.min(max, Number((Math.round(value / step) * step).toFixed(2))));
    const star = valueAt(current);
    const horizontal = x(current);
    cursor.setAttribute('x1', horizontal);
    cursor.setAttribute('x2', horizontal);
    cursor.setAttribute('y1', TOP);
    cursor.setAttribute('y2', BOTTOM);
    point.setAttribute('cx', horizontal);
    point.setAttribute('cy', y(star));
    svg.setAttribute('aria-valuenow', current);
    svg.setAttribute('aria-valuetext', describe(current, star));
    if (emit) onMove(current);
  }
  function draw() {
    const nextWidth = Math.round(svg.getBoundingClientRect().width);
    if (nextWidth <= 0 || nextWidth === width) return;
    width = nextWidth;
    svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    grid.replaceChildren(svgNode('text', { x: LEFT, y: 14, class: 'plot-axis-text' }, yTitle));
    for (const value of yTicks) {
      grid.append(svgNode('line', { x1: LEFT, x2: x(max), y1: y(value), y2: y(value), class: 'plot-grid' }),
        svgNode('text', { x: LEFT - 5, y: y(value) + 3, class: 'plot-axis-text', 'text-anchor': 'end' }, Number(value.toFixed(2))));
    }
    let lastDanY = -Infinity;
    for (const tier of [...tiers].reverse()) {
      if (tier.star < low || tier.star > high) continue;
      const row = y(tier.star);
      grid.append(svgNode('line', { x1: LEFT, x2: x(max), y1: row, y2: row, class: 'plot-dan-line' }));
      if (row - lastDanY >= 15) {
        grid.append(svgNode('text', { x: x(max) + 5, y: row + 3, class: 'plot-dan-text' }, tier.label));
        lastDanY = row;
      }
    }
    const endLabels = [-Infinity, -Infinity];
    for (const tick of ticks) {
      const col = x(tick), label = tickLabel(tick), half = label.length * 3.3;
      const row = col - half > endLabels[0] + 2 ? 0 : 1;
      endLabels[row] = col + half;
      grid.append(svgNode('line', { x1: col, x2: col, y1: BOTTOM, y2: BOTTOM + 3, class: 'plot-grid' }),
        svgNode('text', { x: col, y: BOTTOM + 16 + row * 14, class: 'plot-axis-text', 'text-anchor': 'middle' }, label));
    }
    data.replaceChildren();
    for (const line of lines) {
      const d = line.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(2)},${y(p.star).toFixed(2)}`).join(' ');
      data.append(svgNode('path', { d, fill: 'none', class: 'plot-line ' + (line.kind || '') }));
    }
    if (selected != null) {
      data.append(svgNode('line', { x1: x(selected), x2: x(selected), y1: TOP, y2: BOTTOM, class: 'plot-selected' }));
    }
    for (const p of marks) {
      data.append(svgNode('circle', { cx: x(p.x), cy: y(p.star), r: 3.5, class: 'plot-dot', 'data-rate': p.x.toFixed(2) }));
    }
    if (anchor) {
      data.append(svgNode('circle', { cx: x(anchor.x), cy: y(anchor.star), r: 5.5, class: 'plot-anchor' }),
        svgNode('text', { x: x(anchor.x) - 5, y: Math.max(TOP + 9, y(anchor.star) - 9),
          'text-anchor': 'end', class: 'plot-anchor-label' }, anchor.label));
    }
    move(current, false);
  }
  function fromPointer(event) {
    const rect = svg.getBoundingClientRect();
    return min + ((event.clientX - rect.left) / rect.width * width - LEFT) / (width - LEFT - RIGHT) * (max - min);
  }
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') svg.setPointerCapture(e.pointerId);
    move(fromPointer(e));
  });
  svg.addEventListener('pointermove', e => move(fromPointer(e)));
  if (onPick) svg.addEventListener('click', e => { move(fromPointer(e)); onPick(current); });
  svg.addEventListener('keydown', e => {
    const stride = step * (e.shiftKey ? 10 : 1);
    if (e.key === 'Home') move(min);
    else if (e.key === 'End') move(max);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') move(current + stride);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') move(current - stride);
    else if ((e.key === 'Enter' || e.key === ' ') && onPick) onPick(current);
    else return;
    e.preventDefault();
  });
  const host = liveRegion(() => {
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(svg);
    return () => observer.disconnect();
  });
  host.append(svg);
  return { host, move };
}
