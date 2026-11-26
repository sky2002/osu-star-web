// 页面逻辑：拖放/选择文件 → 主线程读头部 → 逐个送 worker 计算 → 渲染结果卡片。
import { spawnHelpers } from './pool.js';
import {
  validateDanReferences, referencesForModel, selectDanReferences, DAN_REFERENCE_NOTE, DAN_REFERENCE_WARNING,
} from './dan-reference.js';
import {
  listOsz, parseOsuHeader, decodeText, skipReason, mergeMeta, displayName,
  unreliableReasons, buildSegmentsSvg, fmtStar, fmtTime, segmentCaption,
  HT_NOTE, subRows, SUB_NOTE, patternItemView, ITEMS_NOTE, ITEMS_TECH_NOTE, V4_ITEMS_NOTE,
} from './ui-lib.js';
import {
  validateLadder, ladderCopyLine,
} from './acc-ladder.js';
import { danEstimate, danBadge, fmtDanPos, DAN_ESTIMATE_NOTE, DAN_UNRELIABLE_NOTE, DAN_SINGLE_TITLE } from './dan-estimate.js';
import { needsCnn, CNN_REFERENCES, CNN_VERSION, CNN_FROZEN } from './new-star.js';
import { V3_REFERENCES, V3_VERSION, V3_FROZEN, V3_UNTESTED_NOTE, fmtDelta } from './v3-star.js';
import {
  STAR_MODELS, needsV3, needsV4, loadStarModel as loadModelFrom, saveStarModel as saveModelTo,
  cardView, comparisonView, cardCopyText, scoreRequest, V4_REFERENCES, V4_VERSION, V4_FROZEN, V4_UNTESTED_NOTE, loadingText, MODEL_NOTE,
} from './v4-star.js';

import { createAccChart, createRatePanel } from './charts.js';
import { normalizeRate, settingKey, createRateCurveState } from './rate-curve.js';
import { droppedRecords, fileRecords } from './app-import.js';

const EXP_KEY = 'osu-star-experimental';
const RATES = [1, 0.75, 1.5];
const MODEL_NAMES = { v4: '星数 v4', v3: '星数 v3', p1h: 'P1h 旧版', cnn36: 'CNN36', both: '对比 v3' };
const MOD_KEY = 'osu-star-web.mod';
const OD_KEY = 'osu-star-web.od';   // 只记住滑条上的值；是否自定义不记，每次打开都从谱面文件 OD 开始
const OD_RANGE = [0, 10];
// 不随倍速、OD 变化的拒绝原因：算一次就够，所有设置共用
const RATE_FREE_REJECT = ['not_mania', 'not_4k', 'too_few_notes'];

export const FEEDBACK_URL = 'https://github.com/sky2002/osu-star-web/issues/new';

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------------------------------------------------------------- 状态
const state = {
  worker: null,
  helpers: [],
  phase: 'loading', // loading | ready | error
  ver: null, // {version, frozen}
  items: [],
  current: null, // { it, rate, job }
  jobs: [],
  loadErrors: new Map(),
  importEpoch: 0,
  uid: 0,
  job: 0,
  mod: loadMod(),
  experimental: loadExperimental(),
  odCustom: false, // 实验性功能：true 时用 odValue 代替谱面文件 OD
  odValue: loadOd(),
  references: null,
  referencesPhase: 'loading',
  ladder: null,
  ladderPhase: 'loading',
  starModel: loadStarModel(),
  cnnReferences: null,   // CNN36 的段位参照，第一次选 CNN36 时才加载
  cnnReferencesPhase: 'idle', // idle | loading | ready | error
  v3References: null,
  v3ReferencesPhase: 'idle', // idle | loading | ready | error
  v4References: null,
  v4ReferencesPhase: 'idle',
};

function storage() { try { return localStorage; } catch { return null; } }
function loadStarModel() { return loadModelFrom(storage()); }
function saveStarModel(v) { saveModelTo(storage(), v); }

function loadMod() {
  try {
    const v = Number(localStorage.getItem(MOD_KEY));
    return RATES.includes(v) ? v : 1;
  } catch { return 1; }
}

function saveMod(rate) {
  try { localStorage.setItem(MOD_KEY, String(rate)); } catch { /* 无痕模式等：不记住也没关系 */ }
}

// 旧版分项开关。准确率曲线始终可见。

function loadExperimental() {
  try { return localStorage.getItem(EXP_KEY) === '1'; } catch { return false; }
}
function saveExperimental(on) {
  try { localStorage.setItem(EXP_KEY, on ? '1' : '0'); } catch { /* 不记住也没关系 */ }
}
function loadOd() {
  try {
    const v = parseOd(localStorage.getItem(OD_KEY));
    return v === null ? 8 : v;
  } catch { return 8; }
}
function saveOd(v) {
  try { localStorage.setItem(OD_KEY, String(v)); } catch { /* 不记住也没关系 */ }
}
// 输入框文字 → OD（0–10，取一位小数）；不合法返回 null
function parseOd(text) {
  if (text === null || text === undefined || String(text).trim() === '') return null;
  const x = Number(String(text).trim());
  if (!Number.isFinite(x) || x < OD_RANGE[0] || x > OD_RANGE[1]) return null;
  return Math.round(x * 10) / 10;
}
// 当前生效的 OD：只有开着实验性功能且选了"自定义"时才覆盖谱面文件 OD
function activeOd() { return state.experimental && state.odCustom ? state.odValue : null; }
function resultFor(it, key) { return it.rejectAll || it.results.get(key) || null; }
async function loadDanReferences() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL('../data/dan-references.json', import.meta.url), { signal: controller.signal });
    if (!response.ok) throw new Error('段位参考加载失败');
    state.references = validateDanReferences(await response.json());
    state.referencesPhase = 'ready';
  } catch {
    state.referencesPhase = 'error';
  } finally {
    clearTimeout(timeout);
    for (const item of state.items) {
      if (item.status === 'done' && item.result?.ok) renderItem(item);
    }
  }
}

// 另一个模型的段位参照（CNN36 / v3）：第一次选到时才加载
async function loadModelReferences(prefix, file, expect) {
  const phase = prefix + 'ReferencesPhase';
  if (state[phase] !== 'idle' && state[phase] !== 'error') return;
  state[phase] = 'loading';
  try {
    const response = await fetch(new URL('../data/' + file, import.meta.url));
    if (!response.ok) throw new Error('段位参照加载失败');
    state[prefix + 'References'] = validateDanReferences(await response.json(), expect);
    state[phase] = 'ready';
  } catch {
    state[phase] = 'error';
  } finally {
    for (const item of state.items) {
      if (item.status === 'done' && item.result?.ok) renderItem(item);
    }
  }
}
const loadCnnReferences = () => loadModelReferences('cnn', 'dan-references-cnn36.json', CNN_REFERENCES);
const loadV3References = () => loadModelReferences('v3', 'dan-references-v3.json', V3_REFERENCES);
const loadV4References = () => loadModelReferences('v4', 'dan-references-v4.json', V4_REFERENCES);

function loadSelectedReferences() {
  if (needsCnn(state.starModel)) loadCnnReferences();
  if (needsV3(state.starModel)) loadV3References();
  if (needsV4(state.starModel)) loadV4References();
}

async function loadLadder() {
  try {
    const response = await fetch(new URL('../model/acc-ladder.json', import.meta.url));
    if (!response.ok) throw new Error('达成水平参数加载失败');
    state.ladder = validateLadder(await response.json());
    state.ladderPhase = 'ready';
  } catch {
    state.ladderPhase = 'error';
  } finally {
    for (const item of state.items) {
      if (item.status === 'done' && item.result?.ok) renderItem(item);
    }
  }
}


function setStatus(kind, message, progress = null, retry = false) {
  $('#status').className = 'status ' + kind;
  $('#status-text').textContent = message;
  const bar = $('#load-progress');
  bar.hidden = !progress;
  if (progress?.totalBytes > 0) {
    bar.max = progress.totalBytes;
    bar.value = progress.loadedBytes;
  } else bar.removeAttribute('value');
  $('#retry-load').hidden = !retry;
}

function syncReadyStatus() {
  if (state.phase !== 'ready' || !state.ver) return;
  const error = [...state.loadErrors.values()].find(e => e.phase === 'init'
    || (e.phase === 'v4' && needsV4(state.starModel)) || (e.phase === 'v3' && needsV3(state.starModel))
    || (e.phase === 'cnn' && needsCnn(state.starModel)));
  if (error) {
    setStatus('error', error.message, null, true);
    return;
  }
  const source = needsV4(state.starModel) ? [V4_VERSION, V4_FROZEN]
    : needsV3(state.starModel) ? [V3_VERSION, V3_FROZEN]
    : needsCnn(state.starModel) ? [CNN_VERSION, CNN_FROZEN] : [state.ver.version, state.ver.frozen];
  setStatus('ready', `可以选择文件 · ${source[0]}，冻结 ${source[1]}`);
}

const BROWSER_HINT = '请升级到新版 Chrome、Edge 或 Firefox 后重新打开页面。';
function startWorker() {
  if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') {
    initFailed('当前浏览器缺少计算所需的 Worker 或 WebAssembly 支持。' + BROWSER_HINT, false);
    return;
  }
  const mock = new URLSearchParams(location.search).get('mock') === '1';
  try {
    const w = new Worker(new URL(mock ? './mock-worker.js' : './worker.js', import.meta.url), { type: 'module' });
    state.worker = w;
    w.onmessage = onWorkerMessage;
    const shutdown = message => {
      if (state.worker !== w) return;
      stopWorkers();
      initFailed(message);
    };
    w.onerror = ev => shutdown(`计算模块无法运行（${ev.message || '加载失败'}）。${BROWSER_HINT}`);
    w.onmessageerror = () => shutdown('与计算模块通信失败。' + BROWSER_HINT);
    const n = mock ? 0 : Math.max(0, Math.min(4, (navigator.hardwareConcurrency || 2) - 2));
    const ports = n >= 2 ? spawnHelpers(n, helper => state.helpers.push(helper)) : [];
    w.postMessage({ type: 'init', ports }, ports);
  } catch (e) {
    stopWorkers();
    initFailed('当前浏览器无法启动计算模块。' + BROWSER_HINT);
  }
}

function stopWorkers() {
  state.worker?.terminate();
  for (const helper of state.helpers) helper.terminate();
  state.helpers = [];
  state.worker = null;
}

function initFailed(message, retry = true) {
  state.initError = message;
  state.phase = 'error';
  if (state.current) {
    const job = state.current;
    state.current = null;
    if (!job.cancelled) state.jobs.unshift(job);
  }
  setStatus('error', message, null, retry);
  for (const item of state.items) {
    if (item.status === 'queued' || item.status === 'running') { item.status = 'queued'; renderItem(item); }
  }
}

function retryLoad() {
  state.loadErrors.clear();
  if (state.phase === 'error') {
    state.phase = 'loading';
    setStatus('loading', loadingText());
    if (state.worker) state.worker.postMessage({ type: 'init' });
    else startWorker();
    return;
  }
  for (const it of state.items) {
    for (const raw of it.results.values()) {
      for (const model of ['v4','v3','cnn']) {
        if (raw[model]?.ok === false && raw[model].reason !== 'untested') raw[model + 'Computed'] = false;
      }
    }
  }
  syncReadyStatus();
  applySetting();
}

function onWorkerMessage(ev) {
  const m = ev.data || {};
  if (m.type === 'load_progress') {
    const mb = bytes => (bytes / 1000000).toFixed(1);
    const count = mb(m.loadedBytes) + (m.totalBytes > 0 ? ' / ' + mb(m.totalBytes) : '');
    setStatus('loading', `正在下载计算资源 ${count} MB · ${m.file}…`, m);
  } else if (m.type === 'load_error') {
    const error = { ...m, message: [m.file, m.message].filter(Boolean).join(' · ') };
    state.loadErrors.set(m.phase, error);
    setStatus('error', error.message, null, true);
  } else if (m.type === 'load_done') {
    state.loadErrors.delete(m.phase);
    syncReadyStatus();
  } else if (m.type === 'ready') {
    state.phase = 'ready';
    state.ver = { version: m.version, frozen: m.frozen };
    syncReadyStatus();
    pump();
  } else if (m.type === 'error' && m.id === undefined) {
    if (m.restart) stopWorkers();
    initFailed(m.message || '计算资源加载失败。');
  } else {
    const job = state.current;
    if (!job || job.id !== m.id) return;
    if (m.type === 'progress') {
      if (!job.cancelled && job.kind === 'display' && isVisible(job.it)) {
        job.it.stage = m.stage || '计算中';
        job.it.pct = Math.max(0, Math.min(100, Number(m.pct) || 0));
        updateProgress(job.it);
      }
      return;
    }
    if (!['error', 'result', 'cancelled'].includes(m.type)) return;
    state.current = null;
    if (!job.cancelled) {
      if (m.type === 'cancelled') job.reject(cancelError());
      else if (m.type === 'error') job.reject(new Error(m.message || '计算出错'));
      else {
        mergeResult(job, m.result);
        state.jobs.unshift(job);
      }
    }
    pump();
  }
}

const cancelError = () => new DOMException('已取消计算', 'AbortError');
const isVisible = it => !it.group || it.group.active === it;
const selectionKey = it => settingKey(it.rate, activeOd());

function enqueue(it, rate, kind) {
  const key = settingKey(rate, activeOd());
  const have = resultFor(it, key);
  if (have && !scoreRequest(have, state.starModel, state.experimental)) return Promise.resolve(have);
  return new Promise((resolve, reject) => {
    const job = { it, rate, od: activeOd(), key, kind, mode: state.starModel, sub: state.experimental, resolve, reject };
    const firstBackground = state.jobs.findIndex(x => x.kind !== 'display');
    if (kind === 'display' && firstBackground >= 0) state.jobs.splice(firstBackground, 0, job);
    else state.jobs.push(job);
    pump();
  });
}

function cancelJobs(test) {
  for (const job of state.jobs.filter(test)) job.reject(cancelError());
  state.jobs = state.jobs.filter(job => !test(job));
  const cur = state.current;
  if (cur && !cur.cancelled && test(cur)) {
    cur.cancelled = true;
    cur.reject(cancelError());
    state.worker?.postMessage({ type: 'cancel', id: cur.id });
  }
}

function pump() {
  if (state.phase !== 'ready' || state.current) return;
  while (state.jobs.length) {
    const job = state.jobs.shift();
    const have = resultFor(job.it, job.key);
    const request = scoreRequest(have, job.mode, job.sub);
    if (!request) { job.resolve(have); continue; }
    job.request = request;
    job.id = ++state.job;
    state.current = job;
    if (request.withV3 || request.type === 'v3') loadV3References();
    if (job.kind === 'display' && isVisible(job.it)) {
      Object.assign(job.it, { status: 'running', pct: 0, stage: '正在计算' });
      renderItem(job.it);
    }
    try {
      const bytes = job.it.bytes.slice();
      state.worker.postMessage({ ...request, id: job.id, bytes, name: job.it.name, oszHasOsb: job.it.oszHasOsb,
        rate: job.rate, odOverride: job.od, theta: have?.theta }, [bytes.buffer]);
      return;
    } catch (e) {
      state.current = null;
      job.reject(e);
    }
  }
}

function mergeResult(job, result) {
  const { it, request, key } = job;
  const prev = it.results.get(key);
  // 文件读取或运行环境本身也可能在网络已完成后才返回加载错误。
  for (const model of ['v4', 'v3', 'cnn']) {
    const failure = result?.[model];
    if (failure?.reason !== 'load_error') continue;
    state.loadErrors.set(model, { phase: model, message: failure.text || '计算资源加载失败。' });
    syncReadyStatus();
  }
  if (request.type !== 'score') {
    const model = request.type;
    prev[model] = result?.[model] || { ok: false, reason: 'run_error', text: result?.message || '计算未返回读数' };
    prev[model + 'Computed'] = true;
    return;
  }
  const raw = result || { ok: false, reason: 'parse_error', message: '没有收到计算结果' };
  if (raw.ok) {
    for (const [model, wanted] of [['cnn', request.withCnn], ['v3', request.withV3], ['v4', request.withV4]]) {
      const field = model + 'Computed';
      if (!wanted && prev?.[field]) raw[model] = prev[model];
      raw[field] = wanted || !!prev?.[field];
    }
    if (!request.withSub && prev?.subComputed) raw.sub = prev.sub;
    if (!request.withSegments && prev?.legacyComputed) {
      raw.segments = prev.segments;
      raw.hardest = prev.hardest;
      raw.items = prev.items;
    }
    raw.subComputed = request.withSub || !!prev?.subComputed;
    raw.legacyComputed = request.withSegments || !!prev?.legacyComputed;
  }
  if (!raw.ok && RATE_FREE_REJECT.includes(raw.reason)) it.rejectAll = raw;
  else it.results.set(key, raw);
}

function cancelDisplay(it) {
  it.rev++;
  cancelJobs(job => job.it === it && job.kind === 'display');
  it.status = 'cancelled';
  it.result = null;
}
function displayScore(it) {
  const rev = ++it.rev;
  const have = resultFor(it, selectionKey(it));
  if (have && !scoreRequest(have, state.starModel, state.experimental)) {
    Object.assign(it, { status: 'done', result: have });
    renderItem(it);
    return;
  }
  Object.assign(it, { status: 'queued', result: null, error: null });
  renderItem(it);
  enqueue(it, it.rate, 'display').then(result => {
    if (it.rev !== rev) return;
    Object.assign(it, { result, status: 'done' });
    renderItem(it);
  }, e => {
    if (it.rev !== rev) return;
    it.status = e.name === 'AbortError' ? 'cancelled' : 'failed';
    it.error = e.message;
    renderItem(it);
  });
}

function dismissCurve(it) {
  for (const curve of it.curves.values()) curve.dismiss();
}
function applySetting() {
  for (const it of state.items) {
    dismissCurve(it);
    if (it.group) stopPack(it.group);
    cancelDisplay(it);
  }
  for (const it of state.items.filter(isVisible)) displayScore(it);
  syncAdvanced();
}
function setMod(rate) {
  if (!RATES.includes(rate)) return;
  state.mod = rate;
  saveMod(rate);
  syncModButtons();
  for (const it of state.items) it.rate = rate;
  applySetting();
}
function syncAdvanced() {
  const label = $('#advanced-state');
  const tags = [];
  if (state.starModel !== 'v4') tags.push(MODEL_NAMES[state.starModel]);
  if (activeOd() !== null) tags.push('OD ' + activeOd().toFixed(1));
  if (state.experimental && activeOd() === null) tags.push('旧版分项');
  if (state.mod !== 1) tags.push('默认 ' + state.mod.toFixed(2) + '×');
  label.textContent = tags.length ? '当前：' + tags.join(' · ') : '';
  label.hidden = !tags.length;
}

// 关掉时结果保留，只是不再显示分项；自定义 OD 不再生效，回到谱面文件 OD 的结果
function setExperimental(on) {
  state.experimental = !!on;
  saveExperimental(state.experimental);
  const box = document.querySelector('#experimental');
  if (box) box.checked = state.experimental;
  syncOdUi();
  applySetting();
}

function setStarModel(mode) {
  if (!STAR_MODELS.includes(mode)) return;
  state.starModel = mode;
  saveStarModel(mode);
  syncModelButtons();
  syncReadyStatus();
  loadSelectedReferences();
  applySetting();
}

function syncModelButtons() {
  for (const b of document.querySelectorAll('#star-model [data-model]')) {
    b.setAttribute('aria-pressed', String(b.dataset.model === state.starModel));
  }
}

function setOdCustom(on) {
  if (state.odCustom === !!on) return;
  state.odCustom = !!on;
  syncOdUi();
  applySetting();
}

// 滑条松手或输入框确认后才重算（拖动过程中只同步数字）
function commitOd(v, keepNumber = false) {
  if (v === null) return;
  const changed = v !== state.odValue || !state.odCustom;
  state.odValue = v;
  state.odCustom = true;
  saveOd(v);
  syncOdUi(keepNumber);
  if (changed) applySetting();
}

function syncModButtons() {
  for (const b of document.querySelectorAll('#mods [data-rate]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === state.mod));
  }
}

// keepNumber：用户正在输入框里打字时不改写输入框
function syncOdUi(keepNumber = false) {
  const box = $('#od-ctl');
  if (!box) return;
  box.hidden = !state.experimental;
  box.dataset.custom = String(state.odCustom);
  for (const b of box.querySelectorAll('[data-od]')) {
    b.setAttribute('aria-pressed', String((b.dataset.od === 'custom') === state.odCustom));
  }
  $('#od-range').value = String(state.odValue);
  if (!keepNumber) $('#od-num').value = state.odValue.toFixed(1);
}

// ---------------------------------------------------------------- 添加文件
function resultsEl() { return $('#results'); }

function showResultsSec() { $('#results-sec').hidden = false; }


function addNotice(text) {
  showResultsSec();
  resultsEl().append(h('p', { class: 'card skipped', text }));
}
function makeItem(entry, oszHasOsb, group = null) {
  const it = {
    ...entry, oszHasOsb, group, rate: state.mod, rev: 0, curves: new Map(), results: new Map(),
    status: 'idle', result: null, stage: '', pct: 0, el: h('article', { class: 'card' }),
  };
  state.items.push(it);
  return it;
}
function currentRaw(it) {
  const raw = resultFor(it, selectionKey(it));
  return raw && !scoreRequest(raw, state.starModel, state.experimental) ? raw : null;
}
function syncTabs(group) {
  if (!group) return;
  for (const it of group.items) {
    const { r, fail } = cardView(currentRaw(it), state.starModel);
    const value = it.tab.querySelector('.tab-star');
    value.textContent = r?.ok && !fail ? '★ ' + fmtStar(r.star) : '—';
    value.classList.toggle('known', !!r?.ok && !fail);
    it.tab.setAttribute('aria-selected', String(it === group.active));
    it.tab.tabIndex = it === group.active ? 0 : -1;
  }
  group.button.textContent = group.batch ? '停止计算本包' : '计算本包全部 4K 难度';
  group.button.disabled = !group.batch && group.items.every(it => currentRaw(it));
}
function stopPack(group) {
  if (!group.batch) return;
  group.batch = null;
  cancelJobs(job => job.it.group === group && job.kind === 'batch');
  syncTabs(group);
}
function chooseTab(group, it) {
  if (group.active === it) return;
  stopPack(group);
  if (group.active) {
    dismissCurve(group.active);
    cancelDisplay(group.active);
    group.active.el.replaceChildren();
  }
  group.active = it;
  group.body.replaceChildren(it.el);
  syncTabs(group);
  displayScore(it);
}
async function calculatePack(group) {
  if (group.batch) { stopPack(group); return; }
  const missing = group.items.filter(it => !currentRaw(it));
  if (!missing.length) return;
  if (missing.length >= 5 && !window.confirm(`本包还有 ${missing.length} 个 4K 难度需要逐张计算，可能较耗时。现在开始吗？`)) return;
  const token = {};
  group.batch = token;
  syncTabs(group);
  try {
    for (const it of missing) {
      if (group.batch !== token) break;
      await enqueue(it, it.rate, 'batch');
      if (group.batch !== token) break;
      if (it === group.active) displayScore(it);
      else syncTabs(group);
    }
  } catch (e) {
    if (e.name !== 'AbortError') addNotice('曲包计算中断：' + e.message);
  } finally {
    if (group.batch === token) { group.batch = null; syncTabs(group); }
  }
}
function addPack(title, entries, hasOsb) {
  const playable = entries.filter(entry => !entry.skip);
  const skipped = entries.filter(entry => entry.skip);
  const group = { items: [], active: null, body: h('div', { class: 'pack-body', role: 'tabpanel' }), batch: null };
  group.button = h('button', { class: 'btn small', type: 'button', text: '计算本包全部 4K 难度' });
  group.button.addEventListener('click', () => calculatePack(group));
  const tabs = h('div', { class: 'difficulty-tabs', role: 'tablist', 'aria-label': '曲包难度' });
  const box = h('section', { class: 'pack-card' },
    h('div', { class: 'pack-head' }, h('div', null, h('h3', { text: title }),
      h('small', { class: 'muted', text: `${playable.length} 个 4K 难度 · ${hasOsb ? '含 .osb' : '无 .osb'}` })), group.button), tabs, group.body);
  if (skipped.length) box.append(h('details', { class: 'pack-skips' },
    h('summary', { text: `${skipped.length} 个非 4K 难度已跳过` }), h('ul', null, skipped.map(e => h('li', { text: e.name + ' · ' + e.skip })))));
  showResultsSec();
  resultsEl().append(box);
  for (const entry of playable) {
    const it = makeItem(entry, hasOsb, group);
    it.tab = h('button', { class: 'difficulty-tab', type: 'button', role: 'tab' },
      h('span', { class: 'tab-star', text: '—' }), h('span', { text: '[' + (it.header.version || it.name) + ']' }));
    it.tab.addEventListener('click', () => chooseTab(group, it));
    it.tab.addEventListener('keydown', e => {
      const index = group.items.indexOf(it), n = group.items.length;
      const target = { ArrowLeft: (index + n - 1) % n, ArrowRight: (index + 1) % n, Home: 0, End: n - 1 }[e.key];
      if (target === undefined) return;
      e.preventDefault();
      chooseTab(group, group.items[target]);
      group.items[target].tab.focus();
    });
    tabs.append(it.tab);
    group.items.push(it);
  }
  syncTabs(group);
  if (group.items.length) chooseTab(group, group.items[0]);
}

async function readSingle(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = parseOsuHeader(decodeText(bytes));
  return { name: file.name, bytes, header, skip: skipReason(header) };
}
async function handleFiles(records, epoch) {
  if (epoch !== state.importEpoch) return;
  const folders = new Map();
  for (const { file, directory } of records) {
    if (epoch !== state.importEpoch) return;
    try {
      if (/\.osz$/i.test(file.name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (epoch !== state.importEpoch) return;
        const parsed = listOsz(bytes);
        if (parsed.entries.length) addPack(file.name, parsed.entries, parsed.hasOsb);
        else addNotice(file.name + '：压缩包里没有 .osu 难度。');
      } else if (directory && /\.(osu|osb)$/i.test(file.name)) {
        if (!folders.has(directory)) folders.set(directory, { entries: [], hasOsb: false });
        const folder = folders.get(directory);
        if (/\.osb$/i.test(file.name)) folder.hasOsb = true;
        else folder.entries.push(await readSingle(file));
      } else if (/\.osu$/i.test(file.name)) {
        const entry = await readSingle(file);
        if (epoch !== state.importEpoch) return;
        const it = makeItem(entry, false);
        showResultsSec();
        resultsEl().append(it.el);
        displayScore(it);
      } else if (!/\.osb$/i.test(file.name)) {
        addNotice(file.name + '：请选择 .osu、.osz 或曲包文件夹。');
      }
    } catch (e) {
      if (epoch === state.importEpoch) addNotice(`${file.name}：读取失败（${e.message || '文件可能损坏'}）。`);
    }
  }
  if (epoch !== state.importEpoch) return;
  for (const [name, folder] of folders) if (folder.entries.length) addPack(name, folder.entries, folder.hasOsb);
  if (records.every(({ file }) => /\.osb$/i.test(file.name))) addNotice('这个位置没有可读取的 .osu 或 .osz 文件。');
}

function updateProgress(it) {
  const bar = it.el.querySelector('.bar');
  if (bar) {
    bar.setAttribute('aria-valuenow', Math.round(it.pct));
    bar.firstElementChild.style.width = it.pct + '%';
  }
  const label = it.el.querySelector('.stage');
  if (label) label.textContent = `${it.stage} ${Math.round(it.pct)}%`;
}
function exactReading(raw) {
  if (!raw?.ok) return null;
  const cv = cardView(raw, state.starModel);
  const expected = state.starModel === 'both' ? 'v4' : state.starModel;
  if (cv.fail || !Number.isFinite(cv.r?.star) || (cv.r.model || 'p1h') !== expected) return null;
  return cv.r;
}
function ratePanel(it, result, onPreview) {
  const curveKey = state.starModel + '|' + String(activeOd());
  if (!it.curves.has(curveKey)) it.curves.set(curveKey, createRateCurveState());
  const counts = result || it.header;
  return createRatePanel({
    state: it.curves.get(curveKey), rate: it.rate, references: referencesFor(result || { model: state.starModel === 'both' ? 'v4' : state.starModel }).data,
    nActions: counts.nActions ?? ((counts.nObjects || 0) + (counts.nLongNotes || 0)), nLongNotes: counts.nLongNotes ?? Math.round(counts.nNotes * counts.lnFrac || 0),
    seconds: result?.seconds, onPreview,
    getPoints() {
      const points = [];
      for (const [key, raw] of it.results) {
        if (key !== settingKey(raw.rate ?? 1, activeOd())) continue;
        const r = exactReading(raw);
        if (r) points.push({ rate: raw.rate || 1, star: r.star });
      }
      return points;
    },
    onSelect(rate) {
      if (it.group) stopPack(it.group);
      cancelDisplay(it);
      it.rate = normalizeRate(rate);
      displayScore(it);
    },
    async computeAnchor(rate) {
      const raw = await enqueue(it, rate, 'anchor');
      const r = exactReading(raw);
      if (!r) throw new Error(raw?.v4?.text || cardView(raw, state.starModel).fail || raw?.message || '这个倍速未能读出所选模型的星数。');
      return r.star;
    },
    cancelAnchor() { cancelJobs(job => job.it === it && job.kind === 'anchor'); },
  });
}

function renderItem(it) {
  if (!isVisible(it)) { syncTabs(it.group); return; }
  const cv = it.status === 'done' ? cardView(it.result, state.starModel) : {};
  const r = cv.r?.ok && !cv.fail ? cv.r : null;
  const meta = mergeMeta(it.header, r);
  const el = it.el;
  el.className = 'card';
  const score = h('div', { class: 'score-block' },
    h('div', { class: 'star' + (r ? '' : ' none'), text: r ? '★ ' + fmtStar(r.star) : '—' }),
    h('span', { class: 'mod-tag', text: MODEL_NAMES[r?.model || (r ? 'p1h' : state.starModel)] + ' · ' + it.rate.toFixed(2) + '×' }));
  if (cv.comparison) score.append(h('small', { class: 'star-alt', text: 'v3 ★ ' + fmtStar(cv.comparison.star) + ' · ' + fmtDelta(cv.comparison.star - r.star) }));
  if (state.experimental && Number.isFinite(r?.sub?.v2?.star)) score.append(h('small', { class: 'star-alt', text: 'LN 口径 ★ ' + fmtStar(r.sub.v2.star) }));
  const head = h('div', { class: 'card-head' },
    h('div', { class: 'info' }, h('span', { class: 'key-badge', text: it.header.circleSize ? it.header.circleSize + 'K' : '谱面' }),
      h('h3', { class: 'name', text: displayName(meta, it.name) }),
      meta.creator ? h('p', { class: 'sub muted', text: '谱师 ' + meta.creator }) : null), score);
  const strip = h('div', { class: 'meta-strip' });
  function stat(label, text) {
    const value = h('strong', { text });
    strip.append(h('div', { class: 'meta-stat' }, h('small', { text: label }), value));
    return value;
  }
  const bpmCell = stat('主 BPM', '—');
  const timeCell = stat('时长', '—');
  const n = r?.nNotes ?? it.header.nObjects;
  const ln = r?.nLongNotes ?? (Number.isFinite(r?.lnFrac) ? Math.round(n * r.lnFrac) : it.header.nLongNotes);
  stat('物件与长条', Number.isFinite(ln) && n ? `${n} · ${ln} 长条（${Math.round(100 * ln / n)}%）` : String(n ?? '—'));
  const od = activeOd() ?? r?.od ?? it.header.od;
  stat('OD', Number.isFinite(od) ? od.toFixed(1) + (activeOd() === null ? '' : ' 自定义') : '—');
  stat('计算耗时', Number.isFinite(r?.seconds) ? r.seconds.toFixed(1) + ' 秒' : '—');
  function preview(rate) {
    const bpm = it.header.bpm ?? r?.bpm;
    const baseS = Number.isFinite(r?.durationS) ? r.durationS * (r.rate || 1) : it.header.durationS;
    bpmCell.textContent = Number.isFinite(bpm) ? String(Math.round(bpm * rate * 10) / 10) : '—';
    timeCell.textContent = Number.isFinite(baseS) ? fmtTime(baseS / rate) : '—';
  }
  preview(it.rate);
  const body = h('div', { class: 'body' });
  el.replaceChildren(head, strip, body);
  const append = node => { if (node) body.append(node); };
  if (r?.repairs?.length) append(h('p', { class: 'note repairs', text: r.repairs.join('。') }));
  if (r) {
    const de = danEstimateRow(r);
    if (de) head.append(h('div', { class: 'score-details' }, de));
    if (r.untested && ['v3', 'v4'].includes(r.model)) append(h('p', { class: 'note', text: r.model === 'v3' ? V3_UNTESTED_NOTE : V4_UNTESTED_NOTE }));
    if (cv.notice) append(h('p', { class: 'note', text: cv.notice }));
    if (it.result?.v4?.ok === false && needsV4(state.starModel)) append(button('重试星数 v4', retryLoad));
    if (cv.comparison || cv.comparisonMessage) append(comparisonPanel(cv));
    const reasons = unreliableReasons(r);
    if (reasons.length) append(h('div', { class: 'warn' }, h('span', { class: 'tag', text: '不可靠' }),
      h('ul', null, reasons.map(text => h('li', { text })))));
    if (r.rate === 0.75 && r.model !== 'v4') append(h('p', { class: 'note', text: HT_NOTE }));
    append(patternPanel(r));
  } else if (it.status === 'running' || it.status === 'queued') {
    append(h('div', { class: 'run-state' },
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': '计算进度', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': it.pct }, h('i', { style: 'width:' + it.pct + '%' })),
      h('span', { class: 'stage muted', text: it.status === 'running' ? (it.stage + ' ' + Math.round(it.pct) + '%')
        : state.phase === 'error' ? state.initError : state.phase === 'ready' ? '排队中' : '等待计算资源' }),
      button('取消', () => { if (it.group) stopPack(it.group); cancelDisplay(it); renderItem(it); }, 'cancel')));
  } else {
    append(h('p', { class: 'msg muted', text: cv.fail || it.result?.message || (it.status === 'cancelled' ? '已取消计算。' : it.error || '没有读数') }));
    if (it.status === 'failed' || it.status === 'cancelled') append(button('重新计算', () => displayScore(it)));
  }
  if (!it.rejectAll && !it.skip) append(ratePanel(it, r, preview));
  if (r) {
    if (state.ladder) append(createAccChart({ params: state.ladder, result: r, references: referencesFor(r).data, acc: it.ladderT ?? 96, onAcc(acc) { it.ladderT = acc; } }));
    else append(h('p', { class: 'muted', text: state.ladderPhase === 'loading' ? '正在加载准确率曲线…' : '准确率曲线数据暂不可用。' }));
    const svg = buildSegmentsSvg(r.segments, r.hardest);
    if (svg) {
      const holder = h('div', { class: 'seg-svg' });
      holder.innerHTML = svg;
      append(h('section', { class: 'seg' }, h('h3', { text: '10 秒分段难度' }), holder,
        Number.isFinite(r.hardest?.star) ? h('p', { class: 'seg-hard', text: `最难的一段：${fmtTime(r.hardest.startS)}–${fmtTime(r.hardest.endS)}` }) : null,
        h('p', { class: 'seg-cap muted', text: segmentCaption(r) })));
    }
    append(danReferencePanel(r));
    if (state.experimental) append(subPanel(r));
  }
  if (it.status === 'done') append(copyRow(it));
  syncTabs(it.group);
}
function button(text, action, cls = '') {
  const element = h('button', { type: 'button', class: 'btn small ' + cls, text });
  element.addEventListener('click', action);
  return element;
}

// 米 / 面段位：紧跟在谱名下面，和主读数并排
// 段位参照跟着读数的模型走：CNN36 / v3 的读数只和各自读出的段位谱比
function referencesFor(result) {
  const other = (prefix) => ({
    data: state[prefix + 'References'],
    loading: state[prefix + 'ReferencesPhase'] === 'loading' || state[prefix + 'ReferencesPhase'] === 'idle',
  });
  if (result && result.model === 'cnn36') return other('cnn');
  if (result && result.model === 'v3') return other('v3');
  if (result && result.model === 'v4') return other('v4');
  return { data: referencesForModel(state.references, state.ver), loading: state.referencesPhase === 'loading' };
}

function danEstimateRow(result) {
  const { data, loading } = referencesFor(result);
  if (!data) {
    return loading ? h('div', { class: 'dan-est muted', text: '正在加载段位参照…' }) : null;
  }
  const est = danEstimate(result, data);
  if (!est) return null;
  const chip = (x, label = x && x.label + '段位', title = '') => {
    if (!x) return null;
    const muted = x.muted || est.unreliable;
    return h('div', { class: 'dan-est-item' + (muted ? ' muted-item' : ''), title: `${title}段位位置 ${fmtDanPos(x.loc, x.group)}` },
      h('span', { class: 'dan-est-label', text: label }),
      h('strong', { class: 'dan-badge' + (x.loc?.extrapolated ? ' extrapolated' : ''), text: danBadge(x), title: x.text }),
      h('span', { class: 'dan-est-text', text: x.text }),
      x.note ? h('span', { class: 'dan-est-note', text: x.note }) : null);
  };
  const notes = [];
  if (est.unreliable) notes.push(DAN_UNRELIABLE_NOTE);
  if (est.rateNote) notes.push(est.rateNote);
  if (Number.isFinite(result.odOverride)) notes.push(`自定义 OD ${Number(result.odOverride).toFixed(1)}：用这个 OD 下的读数和段位谱（按各自谱面文件 OD）比较。`);
  return h('div', { class: 'dan-est', title: DAN_ESTIMATE_NOTE },
    h('div', { class: 'dan-est-items' }, chip(est.rice), chip(est.face)),
    // 米段位第二行：按 REFORM 官方单曲换算（主读数仍是上面按整段的那一个）
    est.single ? h('div', { class: 'dan-est-single' }, chip(est.single, est.single.label, DAN_SINGLE_TITLE + '\n')) : null,
    notes.length ? h('div', { class: est.unreliable ? 'dan-est-caution' : 'dan-est-sub muted', text: notes.join(' ') }) : null);
}

function comparisonPanel(cv) {
  const { data, loading } = referencesFor(cv.comparison);
  const v = comparisonView(cv, data);
  const panel = h('section', { class: 'sub-items new-star', 'aria-label': '星数 v3 对比' }, h('h3', { text: '星数 v3 对比' }));
  if (!v) {
    panel.append(h('p', { class: 'muted sub-caption', text: cv.comparisonMessage }));
    return panel;
  }
  const row = (label, star, text) => h('li', null,
    h('span', { class: 'sub-label', text: label }), h('strong', { class: 'sub-star', text: star }), text ? h('span', { class: 'sub-text muted', text }) : null);
  const list = h('ul', { class: 'sub-list' },
    row('总星数', '★ ' + fmtStar(v.star), fmtDelta(v.delta) + (v.reliable ? '' : '（不可靠）')));
  if (v.dan && v.dan.rice) list.append(row('米段位（按整段）', v.dan.rice.text, ''));
  if (v.dan && v.dan.single) list.append(row('米段位（按单曲）', v.dan.single.text, v.dan.single.note));
  if (!v.dan) list.append(row('米段位', '—', loading ? '正在加载段位参照…' : '段位参照暂不可用'));
  panel.append(list);
  return panel;
}

// 键型分项（测试版）：叠 / 乱 / 切 / 单手交互★ 与失分构成，单独一块，不和米 / 面分项混在一起
function patternPanel(result) {
  const v = patternItemView(result);
  if (!v) return null;
  const head = h('h3', null, '键型分项', h('span', { class: 'beta-tag', text: '测试版' }));
  if (v.state !== 'ok') {
    return h('section', { class: 'sub-items pattern-items off', 'aria-label': '键型分项（测试版）' }, head, h('p', { class: 'muted sub-caption', text: v.text }));
  }
  const list = h('ul', { class: v.stamina ? 'sub-list pattern-grid' : 'sub-list' });
  const row = (r) => {
    const share = `占失分 ${Number.isFinite(r.share) ? Math.round(r.share * 100) + '%' : '—'}`;
    return h('li', { class: r.star === null ? 'none' : null },
      h('span', { class: 'sub-label', text: r.label }),
      h('strong', { class: 'sub-star', text: r.star === null ? '—' : '★ ' + fmtStar(r.star) }),
      h('span', { class: 'sub-text muted', text: [share, r.text].filter(Boolean).join(' · ') }),
      v.stamina ? h('span', { class: 'share-track', 'aria-hidden': true }, h('i', { style: 'width:' + Math.max(0, Math.min(100, (r.share || 0) * 100)) + '%' })) : null);
  };
  list.append(...v.rows.map(row));
  if (v.stamina) {
    return h('section', { class: 'sub-items pattern-items', 'aria-label': '六维键型分项（测试版）' },
      head, list, h('ul', { class: 'sub-list stamina-list' }, row(v.stamina)), h('p', { class: 'muted sub-caption', text: V4_ITEMS_NOTE }),
      v.untestedNote ? h('p', { class: 'note items-untested', text: v.untestedNote }) : null);
  }
  return h('section', { class: 'sub-items pattern-items', 'aria-label': '键型分项（测试版）' },
    head, list,
    h('p', { class: 'pattern-mix', text: v.mixText }),
    h('p', { class: 'pattern-mix muted', text: v.overlapText }),
    // “苦手要小心”：某类键失分占比很高时；悬停看数字来源与检验范围
    v.hints.map((x) => h('p', { class: 'pattern-hint', title: x.title },
      h('span', { class: 'hint-tag', text: x.tag }), x.text, x.note ? h('span', { class: 'hint-note', text: x.note }) : null)),
    v.tech ? h('p', { class: 'pattern-tech', text: ITEMS_TECH_NOTE }) : null,
    h('p', { class: 'muted sub-caption', text: ITEMS_NOTE }));
}

function subPanel(result) {
  const rows = subRows(result);
  if (!rows.length) return null;
  const list = h('ul', { class: 'sub-list' });
  for (const r of rows) {
    list.append(h('li', { class: r.star === null ? 'none' : null },
      h('span', { class: 'sub-label', text: r.label }),
      h('strong', { class: 'sub-star', text: r.star === null ? '—' : '★ ' + fmtStar(r.star) }),
      r.text ? h('span', { class: 'sub-text muted', text: r.text }) : null));
  }
  return h('section', { class: 'sub-items', 'aria-label': '米 / 面分项与 OD 口径' },
    h('h3', { text: '分项（约定换算）' }), list, h('p', { class: 'muted sub-caption', text: SUB_NOTE }));
}

function danReferencePanel(result) {
  const panel = h('details', { class: 'dan-reference', 'aria-label': '附近段位参考谱' },
    h('summary', { text: '附近段位参考谱' }));
  const refs = referencesFor(result);
  const view = selectDanReferences(result, refs.data);
  if (!view?.available) {
    panel.append(h('p', { class: 'muted dan-caption', text: refs.loading ? '正在加载段位参考…' : '段位参考暂不可用；星数计算不受影响。' }));
    return panel;
  }
  panel.append(h('p', { class: 'muted dan-caption', text: DAN_REFERENCE_NOTE }));
  if (view.resultUnreliable) panel.append(h('p', { class: 'dan-caution', text: DAN_REFERENCE_WARNING }));
  const groups = h('div', { class: 'dan-groups' });
  for (const group of view.groups) {
    const section = h('div', { class: 'dan-group' }, h('h4', { text: group.label }));
    if (!group.matches.length) {
      section.append(h('p', { class: 'muted dan-empty', text: '暂无接近的参考谱' }));
    } else {
      const list = h('ul', { class: 'dan-list' });
      for (const entry of group.matches) {
        const name = entry.url
          ? h('a', { href: entry.url, target: '_blank', rel: 'noopener', text: entry.label })
          : h('span', { text: entry.label });
        list.append(h('li', null,
          h('div', { class: 'dan-name' }, name, entry.reliable ? null : h('span', { class: 'dan-caution', text: '读数不可靠' })),
          h('strong', { class: 'dan-star', text: '★ ' + fmtStar(entry.star) })));
      }
      section.append(list);
    }
    if (group.note) section.append(h('p', { class: 'muted dan-caption', text: group.note }));
    groups.append(section);
  }
  panel.append(groups);
  return panel;
}

function copyRow(it) {
  const btn = h('button', { type: 'button', class: 'btn small', text: '复制读数信息' });
  const row = h('div', { class: 'actions' }, btn);
  btn.addEventListener('click', async () => {
    const cv = cardView(it.result, state.starModel);
    const text = cardCopyText(cv, referencesFor(cv.r).data, state.v3References, {
      header: it.header, name: it.name, p1hVer: state.ver,
      ladderLine: state.ladder && cv.r?.ok ? ladderCopyLine(state.ladder, cv.r) : null, withSub: state.experimental,
    });
    const ok = await copyText(text);
    row.querySelector('textarea')?.remove();
    if (ok) {
      btn.textContent = '已复制';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = '复制读数信息'; btn.disabled = false; }, 2000);
    } else {
      btn.textContent = '复制失败，请手动复制下面的文字';
      const ta = h('textarea', { class: 'manual', readonly: true, rows: '8' });
      ta.value = text;
      row.append(ta);
      ta.focus();
      ta.select();
    }
  });
  return row;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 退回到 textarea 方式 */ }
  const ta = h('textarea', { readonly: true, style: 'position:fixed;left:-9999px;top:0;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------- 初始化
function setupUi() {
  for (const a of document.querySelectorAll('a[data-feedback]')) a.href = FEEDBACK_URL;
  if (state.phase === 'loading') setStatus('loading', loadingText());
  const note = $('#model-note');
  if (note) note.textContent = MODEL_NOTE();

  const input = $('#file-input');
  const drop = $('#drop');
  drop.addEventListener('click', e => { if (e.target !== input) { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => {
    const files = Array.from(input.files);
    input.value = '';
    handleFiles(fileRecords(files), state.importEpoch);
  });

  $('#retry-load').addEventListener('click', retryLoad);
  const overlay = $('#drop-overlay');
  const isFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', e => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', e => {
    if (!depth) return;
    e.preventDefault();
    if (--depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', e => {
    if (!isFiles(e)) return;
    e.preventDefault();
  });
  window.addEventListener('drop', async e => {
    if (!depth && !isFiles(e) && !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const epoch = state.importEpoch;
    try { await handleFiles(await droppedRecords(e.dataTransfer), epoch); }
    catch (err) { if (epoch === state.importEpoch) addNotice('读取拖入的文件失败：' + err.message); }
  });
  for (const b of document.querySelectorAll('#mods [data-rate]')) {
    b.addEventListener('click', () => setMod(Number(b.dataset.rate)));
  }
  syncModButtons();
  for (const b of document.querySelectorAll('#star-model [data-model]')) {
    b.addEventListener('click', () => setStarModel(b.dataset.model));
  }
  syncModelButtons();

  const expBox = $('#experimental');
  if (expBox) {
    expBox.checked = state.experimental;
    expBox.addEventListener('change', () => setExperimental(expBox.checked));
  }

  // OD：滑条和输入框并存。拖动滑条只同步数字，松手才重算；输入框停顿 0.6 秒或确认（回车 / 离开）后重算
  for (const b of document.querySelectorAll('#od-ctl [data-od]')) {
    b.addEventListener('click', () => setOdCustom(b.dataset.od === 'custom'));
  }
  const odRange = $('#od-range'), odNum = $('#od-num');
  odRange.addEventListener('input', () => { odNum.value = Number(odRange.value).toFixed(1); });
  odRange.addEventListener('change', () => commitOd(parseOd(odRange.value)));
  let odTimer = null;
  odNum.addEventListener('input', () => {
    clearTimeout(odTimer);
    const v = parseOd(odNum.value);
    if (v === null) return;
    odRange.value = String(v);
    odTimer = setTimeout(() => commitOd(v, true), 600);
  });
  odNum.addEventListener('change', () => {
    clearTimeout(odTimer);
    const v = parseOd(odNum.value);
    if (v === null) syncOdUi();   // 不合法：退回当前值
    else commitOd(v);
  });
  syncOdUi();

  syncAdvanced();
  $('#clear').addEventListener('click', () => {
    state.importEpoch++;
    for (const it of state.items) {
      it.rev++;
      dismissCurve(it);
      if (it.group) stopPack(it.group);
    }
    cancelJobs(() => true);
    state.items.length = 0;
    resultsEl().replaceChildren();
    $('#results-sec').hidden = true;
  });
}

setupUi();
startWorker();
loadDanReferences();
loadLadder();
loadSelectedReferences();
