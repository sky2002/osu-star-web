// 页面逻辑：拖放/选择文件 → 主线程读头部 → 逐个送 worker 计算 → 渲染结果卡片。
import { spawnHelpers } from './pool.js';
import {
  validateDanReferences, referencesForModel, selectDanReferences, DAN_REFERENCE_NOTE, DAN_REFERENCE_WARNING,
} from './dan-reference.js';
import {
  listOsz, parseOsuHeader, decodeText, skipReason, mergeMeta, displayName,
  unreliableReasons, buildCopyText, buildSegmentsSvg, fmtStar, fmtTime, SEG_CAPTION,
  MOD_SHORT, HT_NOTE, modLabel, subRows, SUB_NOTE, patternItemView, ITEMS_NOTE, ITEMS_TECH_NOTE,
} from './ui-lib.js';
import {
  validateLadder, ladder, parseAcc, reverseNote, reverseCaption, lnNote, fmtLadderStar, ladderCopyLine,
  LADDER_TITLE, LADDER_CAPTION, LADDER_LABEL, LADDER_UNRELIABLE_NOTE,
} from './acc-ladder.js';
import { danEstimate, fmtDanPos, DAN_ESTIMATE_NOTE, DAN_UNRELIABLE_NOTE, DAN_SINGLE_TITLE } from './dan-estimate.js';
import {
  newStarView, newStarCopyLines, cnnViewResult, needsCnn, STAR_MODELS, CNN_REFERENCES, CNN_VERSION, CNN_FROZEN, NEW_STAR_NOTE, CNN_OFF_HINT,
} from './new-star.js';

const RATES = [1, 0.75, 1.5];
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
  phase: 'loading', // loading | ready | error
  ver: null, // {version, frozen}
  items: [],
  current: null, // { it, rate, job }
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
  starModel: loadStarModel(), // 页面最上面的星数模型开关：p1h | cnn36 | both
  cnnReferences: null,   // 新星数（CNN36）的段位参照，第一次选 CNN36 或“两个都看”时才加载
  cnnReferencesPhase: 'idle', // idle | loading | ready | error
};

const MODEL_KEY = 'osu-star-web.model';
function loadStarModel() {
  try {
    const v = localStorage.getItem(MODEL_KEY);
    return STAR_MODELS.includes(v) ? v : 'p1h';
  } catch { return 'p1h'; }
}
function saveStarModel(v) {
  try { localStorage.setItem(MODEL_KEY, v); } catch { /* 不记住也没关系 */ }
}

function loadMod() {
  try {
    const v = Number(localStorage.getItem(MOD_KEY));
    return RATES.includes(v) ? v : 1;
  } catch { return 1; }
}

function saveMod(rate) {
  try { localStorage.setItem(MOD_KEY, String(rate)); } catch { /* 无痕模式等：不记住也没关系 */ }
}

// 实验性功能开关（达成水平表、米 / 面分项、OD 口径）：默认关；关着时不渲染这些面板，计算模块也不算分项
const EXP_KEY = 'osu-star-experimental';
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
// 结果按 (倍速, OD) 分开记住，来回切换不用重算
function settingKey(rate = state.mod, od = activeOd()) { return `${rate}|${od === null ? 'file' : od.toFixed(1)}`; }
function resultFor(it, key) { return it.rejectAll || it.results.get(key) || null; }

// 该设置的结果是否已经够用：开着实验性功能时，没有分项（关着时算的）的结果要重算
function hasUsableResult(it, key) {
  const res = resultFor(it, key);
  if (!res) return false;
  if (!res.ok) return true;
  if (needsCnn(state.starModel) && !res.cnnComputed) return false;   // 选了 CNN36 / 两个都看：补算新星数（不重跑 P1h）
  if (!state.experimental) return true;
  return !!res.subComputed;   // 关着开关时算出的结果没有分项，开着时要重算
}

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

async function loadCnnReferences() {
  if (state.cnnReferencesPhase !== 'idle' && state.cnnReferencesPhase !== 'error') return;
  state.cnnReferencesPhase = 'loading';
  try {
    const response = await fetch(new URL('../data/dan-references-cnn36.json', import.meta.url));
    if (!response.ok) throw new Error('新星数段位参照加载失败');
    state.cnnReferences = validateDanReferences(await response.json(), CNN_REFERENCES);
    state.cnnReferencesPhase = 'ready';
  } catch {
    state.cnnReferencesPhase = 'error';
  } finally {
    for (const item of state.items) {
      if (item.status === 'done' && item.result?.ok) renderItem(item);
    }
  }
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

function setStatus(kind, text) {
  const box = $('#status');
  box.className = 'status ' + kind;
  $('#status-text').textContent = text;
}

const BROWSER_HINT = '请换用新版 Chrome、Edge 或 Firefox 再试。';

// ---------------------------------------------------------------- worker
function startWorker() {
  const mock = new URLSearchParams(location.search).get('mock') === '1';
  let w;
  try {
    w = new Worker(new URL(mock ? './mock-worker.js' : './worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    return initFailed('当前浏览器无法启动计算模块。' + BROWSER_HINT);
  }
  state.worker = w;
  w.onmessage = onWorkerMessage;
  w.onerror = (ev) => {
    const msg = ev && ev.message ? ev.message : '计算模块文件无法加载';
    if (state.phase === 'loading') return initFailed(`模型加载失败：${msg}。${BROWSER_HINT}`);
    if (state.current) finishCurrent({ ok: false, reason: 'parse_error', message: '计算时出错：' + msg });
  };
  w.onmessageerror = () => {
    if (state.phase === 'loading') initFailed('与计算模块通信失败。' + BROWSER_HINT);
  };
  // helper workers for long charts (second layer in parallel); the compute worker gets their ports
  const nHelpers = mock ? 0 : Math.max(0, Math.min(8, (navigator.hardwareConcurrency || 2) - 2));
  const ports = nHelpers >= 2 ? spawnHelpers(nHelpers) : [];
  w.postMessage({ type: 'init', ports }, ports);
}

function initFailed(message) {
  state.phase = 'error';
  setStatus('error', message);
  // 已排队的谱面全部标为失败
  for (const it of state.items) {
    if (it.status === 'queued' || it.status === 'running') failItem(it, '计算模块没有启动，无法计算。');
  }
  state.current = null;
}

function onWorkerMessage(ev) {
  const m = ev.data || {};
  if (m.type === 'ready') {
    state.phase = 'ready';
    state.ver = { version: m.version, frozen: m.frozen };
    const sec = typeof m.loadMs === 'number' ? (m.loadMs / 1000).toFixed(1) : '?';
    setStatus('ready', `模型已就绪（加载 ${sec} 秒）· ${m.version}，冻结 ${m.frozen}`);
    pump();
  } else if (m.type === 'error') {
    if (m.id !== undefined && state.current && state.current.job === m.id) {
      finishCurrent({ ok: false, reason: 'parse_error', message: m.message || '计算出错' });
    } else if (state.phase === 'loading') {
      initFailed(`模型加载失败：${m.message || '未知错误'}。${BROWSER_HINT}`);
    }
  } else if (m.type === 'progress') {
    const cur = state.current;
    const it = cur && cur.job === m.id && cur.key === settingKey() ? cur.it : null;
    if (it && it.status === 'running') {
      it.stage = m.stage || '';
      it.pct = Math.max(0, Math.min(100, Number(m.pct) || 0));
      updateProgress(it);
    }
  } else if (m.type === 'result') {
    if (state.current && state.current.job === m.id) finishCurrent(m.result);
    else { state.current = null; pump(); }
  }
}

// 只算当前 Mod / OD 还没有结果的谱；谱面字节留在页面里，换设置时再送一份副本
function pump() {
  if (state.phase !== 'ready' || state.current) return;
  const rate = state.mod, od = activeOd(), key = settingKey(rate, od);
  const next = state.items.find((x) => x.bytes && !x.failed && !hasUsableResult(x, key));
  if (!next) return;
  const job = ++state.job;
  const withCnn = needsCnn(state.starModel);
  // P1h 结果已经够用、只差新星数：只补算新星数（同一套谱面特征 + CNN36，不重跑逐动作模型）
  const have = resultFor(next, key);
  const cnnOnly = !!(have && have.ok && withCnn && !have.cnnComputed && (!state.experimental || have.subComputed));
  state.current = { it: next, rate, od, key, job, withSub: state.experimental, withCnn, kind: cnnOnly ? 'cnn' : 'score' };
  next.status = 'running';
  next.stage = cnnOnly ? '新星数' : '开始';
  next.pct = 0;
  renderItem(next);
  const bytes = next.bytes.slice();
  if (cnnOnly) {
    state.worker.postMessage({ type: 'cnn', id: job, bytes, rate, odOverride: od, theta: have.theta }, [bytes.buffer]);
    return;
  }
  state.worker.postMessage(
    { type: 'score', id: job, bytes, name: next.name, oszHasOsb: next.oszHasOsb, rate, odOverride: od, withSub: state.experimental, withItems: true,
      withCnn },
    [bytes.buffer],
  );
}

function finishCurrent(result) {
  const cur = state.current;
  state.current = null;
  if (cur) {
    const it = cur.it;
    if (cur.kind === 'cnn') {
      const res = it.results.get(cur.key);
      if (res) {
        res.cnn = (result && result.cnn) || { ok: false, reason: 'run_error', text: (result && result.message) || '新星数没有算出来' };
        res.cnnComputed = true;
      }
    } else {
      const res = result || { ok: false, reason: 'parse_error', message: '没有收到计算结果' };
      if (res.ok) { res.subComputed = !!cur.withSub; res.cnnComputed = !!cur.withCnn; }
      if (!res.ok && RATE_FREE_REJECT.includes(res.reason)) it.rejectAll = res;
      else it.results.set(cur.key, res);
    }
    // 算的过程中设置变了（换了 Mod / OD / 星数模型，或刚打开实验性功能）就不显示，pump 会按新设置排队
    if (cur.key === settingKey() && hasUsableResult(it, cur.key)) {
      it.status = 'done';
      it.result = resultFor(it, cur.key);
      renderItem(it);
    }
  }
  pump();
}

function failItem(it, message) {
  it.status = 'done';
  it.bytes = null;
  it.failed = true;
  it.result = { ok: false, reason: 'parse_error', message };
  renderItem(it);
}

// 设置（Mod、OD、实验性功能）变了以后：有结果的直接显示，没有的排队；正在算的那一局符合新设置就继续显示进度
function applySetting() {
  const key = settingKey();
  for (const it of state.items) {
    if (it.status === 'skipped' || it.failed) continue;
    const cur = state.current;
    if (hasUsableResult(it, key)) { it.status = 'done'; it.result = resultFor(it, key); }
    else if (cur && cur.it === it && cur.key === key && (cur.withSub || !state.experimental) && (cur.withCnn || !needsCnn(state.starModel))) {
      it.status = 'running'; it.result = null;
    }
    else { it.status = 'queued'; it.result = null; }
    renderItem(it);
  }
  pump();
}

function setMod(rate) {
  if (!RATES.includes(rate)) return;
  state.mod = rate;
  saveMod(rate);
  syncModButtons();
  applySetting();
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

// 星数模型：P1h（现行）/ CNN36（测试）/ 两个都看。切到需要 CNN36 的选项时，已算好的谱只补算新星数
function setStarModel(mode) {
  if (!STAR_MODELS.includes(mode)) return;
  state.starModel = mode;
  saveStarModel(mode);
  syncModelButtons();
  if (needsCnn(mode)) loadCnnReferences();
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

function addGroup(title, note) {
  showResultsSec();
  resultsEl().append(h('div', { class: 'group' }, h('strong', { text: title }), note ? h('span', { class: 'muted', text: ' ' + note }) : null));
}

function addNotice(text) {
  showResultsSec();
  resultsEl().append(h('div', { class: 'card skipped' }, h('div', { class: 'body' }, h('div', { class: 'muted', text: text }))));
}

function addItem({ name, header, bytes, oszHasOsb, skip }) {
  const it = {
    uid: ++state.uid, name, header, bytes, oszHasOsb: !!oszHasOsb, results: new Map(), failed: false,
    status: skip ? 'skipped' : 'queued', skip, result: null, stage: '', pct: 0, el: h('article', { class: 'card' }),
  };
  state.items.push(it);
  showResultsSec();
  resultsEl().append(it.el);
  if (skip) it.bytes = null;
  if (!skip && state.phase === 'error') failItem(it, '计算模块没有启动，无法计算。');
  else renderItem(it);
  return it;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const f of files) {
    const lower = f.name.toLowerCase();
    try {
      if (lower.endsWith('.osz')) {
        const u8 = new Uint8Array(await f.arrayBuffer());
        let parsed;
        try { parsed = listOsz(u8); } catch (e) { addNotice(`${f.name}：无法解压（${e && e.message ? e.message : '文件损坏'}）。`); continue; }
        if (!parsed.entries.length) { addNotice(`${f.name}：压缩包里没有 .osu 难度。`); continue; }
        const ok = parsed.entries.filter((e) => !e.skip).length;
        addGroup(f.name, `${parsed.entries.length} 个难度，${ok} 个可计算${parsed.hasOsb ? '；含 .osb（storyboard）' : ''}`);
        for (const e of parsed.entries) {
          addItem({
            name: e.name, header: e.header, skip: e.skip,
            bytes: e.skip ? null : e.bytes.slice(), oszHasOsb: parsed.hasOsb,
          });
        }
      } else if (lower.endsWith('.osu')) {
        const u8 = new Uint8Array(await f.arrayBuffer());
        const header = parseOsuHeader(decodeText(u8));
        // 非 mania 4K 也交给 worker 拒绝一次，保证 .osu 的提示口径与 worker 一致
        addItem({ name: f.name, header, bytes: u8, oszHasOsb: false, skip: null });
      } else {
        addNotice(`${f.name}：只支持 .osu 和 .osz 文件。`);
      }
    } catch (e) {
      addNotice(`${f.name}：读取失败（${e && e.message ? e.message : '未知错误'}）。`);
    }
  }
  pump();
}

// ---------------------------------------------------------------- 渲染
function updateProgress(it) {
  const bar = it.el.querySelector('.bar > i');
  const lbl = it.el.querySelector('.stage');
  if (bar) bar.style.width = it.pct + '%';
  if (lbl) lbl.textContent = `${it.stage || '计算中'} ${Math.round(it.pct)}%`;
}

function renderItem(it) {
  const header = it.header || {};
  const raw = it.result;
  // 只看 CNN36：总星数和挂在它上面的读数换成新星数版本；这张谱没有新星数（HT、自定义 OD 等）时整卡显示原因
  const cnnMode = state.starModel === 'cnn36' && !!(raw && raw.ok);
  const cnnView = cnnMode ? cnnViewResult(raw) : null;
  const r = cnnView || raw;
  const meta = mergeMeta(header, r && !it.skip ? r : null);
  const title = displayName(meta, it.name);
  const el = it.el;
  el.className = 'card';
  el.replaceChildren();

  const info = h('div', { class: 'info' },
    h('div', { class: 'name', text: title }),
    h('div', { class: 'sub muted' }, subline(it, meta)));

  let side;
  const extra = [];
  if (it.status === 'skipped') {
    el.classList.add('skipped');
    side = h('div', { class: 'star none', text: '—' });
    extra.push(h('div', { class: 'msg muted', text: it.skip }));
  } else if (it.status === 'queued') {
    el.classList.add('pending');
    side = h('div', { class: 'star none', text: '…' });
    extra.push(h('div', { class: 'msg muted', text: state.phase === 'ready' ? '排队中' : '等待模型加载' }));
  } else if (it.status === 'running') {
    el.classList.add('pending');
    side = h('div', { class: 'star none', text: '…' });
    extra.push(
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: `width:${it.pct}%` })),
      h('div', { class: 'stage muted', text: `${it.stage || '计算中'} ${Math.round(it.pct)}%` }),
    );
  } else if (cnnMode && !cnnView) {
    el.classList.add('skipped');
    side = h('div', { class: 'star none', text: '—' });
    extra.push(h('div', { class: 'msg muted', text: `CNN36：${(raw.cnn && raw.cnn.text) || '这张谱没有新星数'}。${CNN_OFF_HINT}` }));
  } else if (r && r.ok) {
    const reasons = unreliableReasons(r);
    if (reasons.length) el.classList.add('unreliable');
    const tag = MOD_SHORT[r.rate || 1];
    side = h('div', { class: 'star' }, '★ ' + fmtStar(r.star), tag ? h('span', { class: 'mod-tag', text: tag }) : null,
      r.model === 'cnn36' ? h('span', { class: 'mod-tag', title: CNN_VERSION, text: 'CNN36' }) : null);
    if (state.experimental && r.sub && r.sub.v2 && Number.isFinite(r.sub.v2.star)) {
      side.append(h('span', { class: 'star-alt', title: `整谱按 97% ScoreV2（LN 段位口径，${odSource(r)}）读出的星数，约定换算，仅供参考`,
        text: 'LN 口径 ★ ' + fmtStar(r.sub.v2.star) }));
    }
    const de = danEstimateRow(r);
    if (de) extra.push(de);
    if (state.starModel === 'both') {
      const ns = newStarPanel(r);
      if (ns) extra.push(ns);
    }
    if (reasons.length) {
      extra.push(h('div', { class: 'warn' },
        h('span', { class: 'tag', text: '不可靠' }),
        h('ul', null, reasons.map((x) => h('li', { text: x })))));
    }
    if (r.rate === 0.75) extra.push(h('div', { class: 'note', text: HT_NOTE }));
    const pp = patternPanel(r);
    if (pp) extra.push(pp);
    if (state.experimental) {
      extra.push(ladderPanel(r, it));
      const sp = subPanel(r);
      if (sp) extra.push(sp);
    }
    extra.push(danReferencePanel(r));
    const svg = buildSegmentsSvg(r.segments, r.hardest);
    if (svg) {
      const box = h('div', { class: 'seg' });
      const holder = h('div', { class: 'seg-svg' });
      holder.innerHTML = svg;
      box.append(holder);
      if (r.hardest && Number.isFinite(r.hardest.star)) {
        box.append(h('div', { class: 'seg-hard', text: `最难的一段：${fmtTime(r.hardest.startS)}–${fmtTime(r.hardest.endS)}（高亮处）` }));
      }
      box.append(h('div', { class: 'seg-cap muted', text: SEG_CAPTION }));
      extra.push(box);
    }
  } else {
    el.classList.add('rejected');
    side = h('div', { class: 'star none', text: '—' });
    extra.push(h('div', { class: 'msg muted', text: (r && r.message) || '没有读数' }));
  }

  if (it.status === 'done') extra.push(copyRow(it));
  el.append(side, h('div', { class: 'body' }, info, extra));
}

// 米 / 面段位：紧跟在谱名下面，和主读数并排
// 段位参照跟着读数的模型走：CNN36 的读数只和 CNN36 自己读出的段位谱比
function referencesFor(result) {
  return result && result.model === 'cnn36'
    ? { data: state.cnnReferences, loading: state.cnnReferencesPhase === 'loading' || state.cnnReferencesPhase === 'idle' }
    : { data: referencesForModel(state.references, state.ver), loading: state.referencesPhase === 'loading' };
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
      h('strong', { class: 'dan-est-text', text: x.text }),
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

// 新星数（测试版）：只在实验性功能里显示；和上面的总星数并排比较，米段位按新星数自己的段位参照换算
function newStarPanel(result) {
  const v = newStarView(result, state.cnnReferences);
  if (!v) return null;
  const head = h('h3', null, '新星数', h('span', { class: 'beta-tag', text: '测试版' }));
  if (v.state !== 'ok') {
    return h('section', { class: 'sub-items new-star off', 'aria-label': '新星数（测试版）' }, head, h('p', { class: 'muted sub-caption', text: v.text }));
  }
  const sign = v.delta >= 0 ? '+' : '−';
  const row = (label, star, text) => h('li', null,
    h('span', { class: 'sub-label', text: label }), h('strong', { class: 'sub-star', text: star }), text ? h('span', { class: 'sub-text muted', text }) : null);
  const list = h('ul', { class: 'sub-list' }, row('总星数', '★ ' + fmtStar(v.star), `比上面 ${sign}${Math.abs(v.delta).toFixed(2)}`));
  if (v.dan && v.dan.rice) list.append(row('米段位', v.dan.rice.text, ''));
  if (v.dan && v.dan.single) list.append(row('米段位（按单曲）', v.dan.single.text, v.dan.single.note));
  if (!v.dan) {
    list.append(row('米段位', '—', state.cnnReferencesPhase === 'error' ? '段位参照加载失败' : '正在加载段位参照…'));
  }
  const warn = v.reliable ? null : h('div', { class: 'warn' }, h('span', { class: 'tag', text: '不可靠' }),
    h('ul', null, (v.reasons.length ? v.reasons : ['上面的星数不可靠，新星数也一样']).map((x) => h('li', { text: x }))));
  return h('section', { class: 'sub-items new-star', 'aria-label': '新星数（测试版）' },
    head, list, warn, h('p', { class: 'muted sub-caption', text: NEW_STAR_NOTE }));
}

// 键型分项（测试版）：叠 / 乱切 / 单手交互★ 与失分构成，单独一块，不和米 / 面分项混在一起
function patternPanel(result) {
  const v = patternItemView(result);
  if (!v) return null;
  const head = h('h3', null, '键型分项', h('span', { class: 'beta-tag', text: '测试版' }));
  if (v.state !== 'ok') {
    return h('section', { class: 'sub-items pattern-items off', 'aria-label': '键型分项（测试版）' }, head, h('p', { class: 'muted sub-caption', text: v.text }));
  }
  const list = h('ul', { class: 'sub-list' });
  for (const r of v.rows) {
    list.append(h('li', { class: r.star === null ? 'none' : null },
      h('span', { class: 'sub-label', text: r.label }),
      h('strong', { class: 'sub-star', text: r.star === null ? '—' : '★ ' + fmtStar(r.star) }),
      h('span', { class: 'sub-text muted', text: (r.text ? r.text + ' · ' : '') + `占失分 ${Number.isFinite(r.share) ? Math.round(r.share * 100) + '%' : '—'}` })));
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
  const panel = h('section', { class: 'dan-reference', 'aria-label': '附近段位参考谱' },
    h('h3', { text: '附近段位参考谱' }));
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

// 达成水平：四条预设线 + 自定义 acc（每张卡各自记住输入值）；只依赖总星数，不需要重新计算
function ladderPanel(result, it) {
  const panel = h('section', { class: 'ladder', 'aria-label': LADDER_TITLE }, h('h3', { text: LADDER_TITLE }));
  const P = state.ladder;
  if (!P) {
    panel.append(h('p', { class: 'muted dan-caption', text: state.ladderPhase === 'loading' ? '正在加载达成水平参数…' : '达成水平暂不可用；星数计算不受影响。' }));
    return panel;
  }
  const rate = result.rate || 1;
  const tag = (row) => {
    const L = LADDER_LABEL[row.label];
    return h('span', { class: 'ladder-tag ' + row.label, title: L.title, text: L.text });
  };
  const tbody = h('tbody');
  for (const t of P.presets) {
    const row = ladder(P, result.star, t, rate);
    tbody.append(h('tr', t === 96 ? { class: 'is96' } : null,
      h('td', { text: `${t}%` }), h('td', { class: 'ladder-star', text: fmtLadderStar(row) }), h('td', null, tag(row))));
  }
  const input = h('input', {
    type: 'number', min: String(P.input_range[0]), max: String(P.input_range[1]), step: '0.1', inputmode: 'decimal',
    value: String(it.ladderT ?? 96), 'aria-label': '自定义 acc（%）',
  });
  const slider = h('input', {
    type: 'range', min: String(P.input_range[0]), max: String(P.input_range[1]), step: '0.1',
    value: String(it.ladderT ?? 96), 'aria-label': '自定义 acc（%，滑条）',
  });
  const outStar = h('td', { class: 'ladder-star' });
  const outTag = h('td');
  const outNote = h('p', { class: 'ladder-rev muted' });
  const update = () => {
    const t = parseAcc(P, input.value);
    outTag.replaceChildren();
    outNote.className = 'ladder-rev muted';
    if (t === null) {
      outStar.textContent = `请输入 ${P.input_range[0]}–${P.input_range[1]}`;
      outNote.textContent = '';
      return;
    }
    it.ladderT = t;
    slider.value = String(t);
    const row = ladder(P, result.star, t, rate);
    outStar.textContent = fmtLadderStar(row);
    outTag.append(tag(row));
    const rn = reverseNote(P, t);
    outNote.textContent = rn ? rn.text : '';
    if (rn) outNote.className = 'ladder-rev ' + (rn.level === 'bad' ? 'dan-caution' : 'muted');
  };
  input.addEventListener('input', update);
  // 滑条只改输入框的数字，换算仍走同一个 update（只依赖总星数，拖动时实时更新）
  slider.addEventListener('input', () => { input.value = Number(slider.value).toFixed(1); update(); });
  tbody.append(h('tr', { class: 'custom' }, h('td', null, input, '%'), outStar, outTag),
    h('tr', { class: 'custom-slider' }, h('td', { colspan: '3' }, slider)));
  update();
  panel.append(
    h('p', { class: 'muted dan-caption', text: LADDER_CAPTION }),
    h('table', { class: 'ladder-tab' },
      h('thead', null, h('tr', null, h('th', { text: 'acc' }), h('th', { text: '需要的水平' }), h('th', { text: '依据' }))),
      tbody),
    outNote,
    h('p', { class: 'muted dan-caption', text: reverseCaption(P) }),
  );
  if (!result.reliable) panel.append(h('p', { class: 'dan-caution', text: LADDER_UNRELIABLE_NOTE }));
  const ln = lnNote(result);
  if (ln) panel.append(h('p', { class: 'dan-caution', text: ln }));
  return panel;
}

function subline(it, meta) {
  const r = it.result;
  const bits = [];
  if (meta.creator) bits.push('mapper：' + meta.creator);
  const n = r && r.ok ? r.nNotes : (it.header && it.header.nObjects);
  if (n) bits.push(`物件 ${n}`);
  if (r && r.ok) {
    if ((r.rate || 1) !== 1) bits.push(modLabel(r.rate));
    if (Number.isFinite(r.durationS)) bits.push(`时长 ${fmtTime(r.durationS)}`);
    if (Number.isFinite(r.odOverride)) {
      const fileOd = it.header && Number.isFinite(it.header.od) ? `；谱面 ${Number(it.header.od).toFixed(1)}` : '';
      bits.push(`OD ${Number(r.odOverride).toFixed(1)}（自定义${fileOd}）`);
    } else if (Number.isFinite(r.od)) bits.push(`OD ${Number(r.od).toFixed(1)}`);
    if (Number.isFinite(r.seconds)) bits.push(`计算 ${r.seconds.toFixed(1)} 秒`);
  }
  return bits.join(' · ');
}

function odSource(r) {
  return Number.isFinite(r.odOverride) ? `自定义 OD ${Number(r.odOverride).toFixed(1)}` : 'OD 用谱面文件';
}

function copyRow(it) {
  const btn = h('button', { type: 'button', class: 'btn small', text: '复制读数信息' });
  const row = h('div', { class: 'actions' }, btn);
  btn.addEventListener('click', async () => {
    const raw = it.result;
    const r = (state.starModel === 'cnn36' && cnnViewResult(raw)) || raw;
    const cnn = r && r.model === 'cnn36';
    const { data } = referencesFor(r);
    let text = buildCopyText(r, it.header, it.name, cnn ? { version: CNN_VERSION, frozen: CNN_FROZEN } : state.ver, selectDanReferences(r, data),
      state.experimental ? ladderCopyLine(state.ladder, r) : null, state.experimental, danEstimate(r, data));
    if (state.starModel === 'both') {
      const lines = newStarCopyLines(newStarView(raw, state.cnnReferences), fmtStar);
      if (lines.length) text += '\n' + lines.join('\n');
    }
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

  const input = $('#file-input');
  const drop = $('#drop');
  $('#pick').addEventListener('click', (e) => { e.preventDefault(); input.click(); });
  input.addEventListener('change', () => {
    const files = Array.from(input.files);
    input.value = '';
    handleFiles(files);
  });

  let depth = 0;
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('over'); });
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    handleFiles(Array.from(e.dataTransfer.files));
  });
  // 拖偏了也别让浏览器直接打开文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

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

  $('#clear').addEventListener('click', () => {
    state.items = state.items.filter((x) => state.current && x === state.current.it);
    resultsEl().replaceChildren(...state.items.map((x) => x.el));
    if (!state.items.length) $('#results-sec').hidden = true;
  });
}

setupUi();
startWorker();
loadDanReferences();
loadLadder();
if (needsCnn(state.starModel)) loadCnnReferences();
