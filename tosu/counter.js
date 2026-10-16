// tosu counter: listens to tosu's v2 websocket, fetches the current .osu from tosu and scores it with the same P1h reader
// as the web page (js/worker.js, unchanged). Nothing is computed while a map is being played: the model is loaded only
// outside gameplay, and a computation still running when a play starts is stopped and redone afterwards.
import { readMods } from './mods.js';
import { VERSION, FROZEN } from './js/engine.js';
import { danEstimate } from './js/dan-estimate.js';
import { validateDanReferences, referencesForModel } from './js/dan-reference.js';
import { buildSegmentsSvg, fmtTime } from './js/ui-lib.js';
import { validateLadder } from './js/acc-ladder.js';
import { scoreV1Acc, playLevel, usableAcc, estimateLevel, fmtExpectedAcc, predictView, WIDE_SPREAD, NOVICE_BELOW } from './player.js';

const qs = new URLSearchParams(location.search);
const clampHelpers = v => Math.max(0, Math.min(8, Math.round(Number(v)) || 0));
const WS_URL = qs.get('ws') || `ws://${location.host}/websocket/v2`;
// tosu injects window.COUNTER_PATH into the page; fall back to the first path segment (the counter folder)
const COUNTER_PATH = window.COUNTER_PATH || decodeURI(location.pathname.split('/').filter(Boolean)[0] || '');
const CMD_URL = `ws://${location.host}/websocket/commands?l=${encodeURI(COUNTER_PATH)}`;
const FILE_URL = '/files/beatmap/file';
const STATE_PLAY = 2;            // tosu GameState.play
const STATE_RESULTS = 7;         // tosu GameState.resultScreen
const RESULTS_SETTLE_MS = 1500;  // read the results screen once tosu has filled it in
const HISTORY_KEY = 'osu-star-tosu|plays|1';
const HISTORY_MAX = 50;
const DEBOUNCE_MS = 400;         // song select scrolling: wait until the selection settles
const CACHE_KEY = `osu-star-tosu|${FROZEN}|3|`;   // 3: results keep the 97 % ScoreV2 reading and the segment curve
const CACHE_MAX = 300;
const BOTTOM = { hint: '使用提示', curve: '难度曲线', none: '不显示' };

const $ = id => document.getElementById(id);
const S = {
  ws: null, worker: null, helpers: [], phase: 'idle',   // idle | loading | ready | error
  playing: null, key: null, info: null, job: null, jobId: 0, timer: null, retries: 0, connected: false,
  cache: loadCache(), dans: null,
  // settings.json (tosu settings page); the URL parameters ?hint=0 / ?helpers=N only set the starting values
  settings: { hideWhilePlaying: false, bottom: qs.get('hint') === '0' ? BOTTOM.none : qs.get('curve') === '1' ? BOTTOM.curve : BOTTOM.hint,
    helpers: clampHelpers(qs.get('helpers') || 0), playerLevel: true, playerWindow: 5 },
  curveKey: null, curveEnd: 0, live: null,
  // finished plays (newest first) for the player level; state / results bookkeeping
  history: loadHistory(), ladder: null, state: null, resultsMsg: null, resultsTimer: null, lastPlay: null,
};

connect();
connectSettings();
loadDanReferences();
loadLadder();

// ---------------------------------------------------------------- tosu settings (Settings API, tosu >= 2.6)
// getSettings answers with the saved values (defaults from settings.json filled in); updateSettings arrives when the
// user changes them on tosu's settings page. Older tosu without /websocket/commands: the defaults stay.
function connectSettings(delay = 2000) {
  let ws;
  try { ws = new WebSocket(CMD_URL); } catch (e) { return; }
  let opened = false;
  ws.onopen = () => { opened = true; ws.send(`getSettings:${encodeURI(COUNTER_PATH)}`); };
  ws.onmessage = ev => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && (d.command === 'getSettings' || d.command === 'updateSettings')) applySettings(d.message);
  };
  ws.onclose = () => setTimeout(() => connectSettings(opened ? 2000 : Math.min(delay * 2, 30000)), opened ? 2000 : delay);
}

function applySettings(v) {
  if (!v || typeof v !== 'object' || v.error) return;
  if (Array.isArray(v)) v = Object.fromEntries(v.filter(x => x && x.uniqueID).map(x => [x.uniqueID, x.value]));
  const bool = x => x === true || x === 'true';
  if ('hideWhilePlaying' in v) S.settings.hideWhilePlaying = bool(v.hideWhilePlaying);
  if ('bottomPanel' in v && Object.values(BOTTOM).includes(v.bottomPanel)) S.settings.bottom = v.bottomPanel;
  if ('helpers' in v) S.settings.helpers = clampHelpers(v.helpers);
  if ('playerLevel' in v) S.settings.playerLevel = bool(v.playerLevel);
  if ('playerWindow' in v) S.settings.playerWindow = Math.max(1, Math.min(20, Math.round(Number(v.playerWindow)) || 5));
  render();
}

// REFORM / LN dan charts read by the same model (small JSON, no computation)
async function loadDanReferences() {
  try {
    const r = await fetch(new URL('./data/dan-references.json', import.meta.url));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    S.dans = referencesForModel(validateDanReferences(await r.json()), { version: VERSION, frozen: FROZEN });
  } catch (e) { S.dans = null; }
  render();
}

// acc ladder of the web page ("达成水平"), read backwards for the player level
async function loadLadder() {
  try {
    const r = await fetch(new URL('./model/acc-ladder.json', import.meta.url));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    S.ladder = validateLadder(await r.json());
  } catch (e) { S.ladder = null; }
  render();
}

// ---------------------------------------------------------------- tosu websocket
function connect() {
  let ws;
  try { ws = new WebSocket(WS_URL); } catch (e) { return retryConnect(); }
  S.ws = ws;
  ws.onopen = () => { S.connected = true; render(); };
  ws.onclose = () => { S.connected = false; render(); retryConnect(); };
  ws.onerror = () => {};
  ws.onmessage = ev => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    onTosu(d);
  };
}
function retryConnect() { setTimeout(connect, 2000); }

function onTosu(d) {
  const playing = !!(d.state && d.state.number === STATE_PLAY);
  const bm = d.beatmap || {};
  const mods = readMods(d.play && d.play.mods);
  const info = {
    checksum: bm.checksum || '', mode: bm.mode ? bm.mode.number : null,
    title: [bm.artist, bm.title].filter(Boolean).join(' - '), version: bm.version || '', mods,
  };
  const key = info.checksum ? `${info.checksum}#${mods.ok ? mods.key : 'unsupported'}` : null;
  // playhead: map-time position since the first object, in real seconds (segments are in real time from the first note)
  const t = bm.time || {};
  S.live = playing && Number.isFinite(t.live) && Number.isFinite(t.firstObject) && mods.ok ? (t.live - t.firstObject) / mods.rate / 1000 : null;
  movePlayhead();
  trackResults(d, info);
  const wasPlaying = S.playing;
  S.playing = playing;
  if (playing && wasPlaying !== true) enterPlay();
  if (key !== S.key) { S.key = key; S.info = info; S.retries = 0; render(); schedule(); }
  else if (!playing && wasPlaying === true) { render(); schedule(); }
  else if (wasPlaying !== playing) render();
}

// ---------------------------------------------------------------- gameplay guard
function enterPlay() {
  // stop anything that uses the CPU; the current map is scored again after the play if it was not finished
  if (S.phase === 'loading' || S.job) stopWorker();
  clearTimeout(S.timer);
}

function stopWorker() {
  if (S.worker) S.worker.terminate();
  for (const h of S.helpers) h.terminate();
  S.worker = null; S.helpers = []; S.phase = 'idle'; S.job = null;
}

// ---------------------------------------------------------------- scheduling
function schedule() {
  clearTimeout(S.timer);
  if (S.playing) return;
  S.timer = setTimeout(run, DEBOUNCE_MS);
}

async function run() {
  const info = S.info, key = S.key;
  if (S.playing || !info || !key) return;
  if (!info.mods.ok || info.mode !== 3 || S.cache.has(key)) return render();
  if (S.job) return;                       // one at a time; finish() picks up the latest selection
  if (S.phase !== 'ready') return startWorker();
  const id = ++S.jobId;
  S.job = { id, key, pct: 0, checksum: info.checksum };
  render();
  let bytes;
  try {
    const r = await fetch(`${FILE_URL}?k=${encodeURIComponent(key)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    return finish(id, { ok: false, reason: 'fetch', message: '读不到谱面文件（' + String(e.message || e) + '）' });
  }
  if (!S.job || S.job.id !== id) return;   // stopped by a play in the meantime
  const m = info.mods;
  S.worker.postMessage({ type: 'score', id, bytes, rate: m.rate, hit: m.hit, odOverride: m.od, withSub: false }, [bytes.buffer]);
}

function finish(id, res) {
  const job = S.job;
  if (!job || job.id !== id) return;
  S.job = null;
  // tosu may already serve the next map's file while the websocket still reports the old checksum: try again shortly
  if (res.ok && res.md5 && job.checksum && res.md5 !== job.checksum) {
    if (S.retries++ < 3) { S.timer = setTimeout(run, 500); return; }
    res = { ok: false, reason: 'md5', message: '谱面文件与当前选中的谱对不上，请重新选一次' };
  }
  if (res.reason !== 'fetch' && res.reason !== 'md5') saveResult(job.key, res);
  else S.failed = { key: job.key, res };
  render();
  if (S.key !== job.key) schedule();
}

// ---------------------------------------------------------------- worker
function startWorker() {
  if (S.phase === 'loading') return;
  S.phase = 'loading';
  render();
  let w;
  try { w = new Worker(new URL('./js/worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { S.phase = 'error'; S.error = '无法启动计算模块（浏览器不支持模块 Worker）'; return render(); }
  S.worker = w;
  const ports = [];
  for (let i = 0; i < S.settings.helpers; i++) {
    try {
      const h = new Worker(new URL('./js/sl-worker.js', import.meta.url), { type: 'module' });
      const ch = new MessageChannel();
      h.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
      S.helpers.push(h); ports.push(ch.port2);
    } catch (e) { break; }
  }
  w.onmessage = ev => {
    const m = ev.data;
    if (w !== S.worker) return;
    if (m.type === 'ready') { S.phase = 'ready'; render(); schedule(); }
    else if (m.type === 'progress') { if (S.job && S.job.id === m.id) { S.job.pct = m.pct; render(); } }
    else if (m.type === 'result') finish(m.id, m.result);
    else if (m.type === 'error') {
      if (S.phase === 'loading') { S.phase = 'error'; S.error = m.message; render(); }
      else if (S.job) finish(S.job.id, { ok: false, reason: 'error', message: m.message });
    }
  };
  w.onerror = ev => {
    if (w !== S.worker) return;
    S.phase = 'error'; S.error = '计算模块出错：' + (ev && ev.message ? ev.message : '文件无法加载');
    S.job = null; render();
  };
  w.postMessage({ type: 'init', ports }, ports);
}

// ---------------------------------------------------------------- finished plays
// A play counts when the game goes from playing straight to the results screen (a pass, or NF). Watching someone
// else's replay also ends on the results screen, so the results' player name must match the logged-in profile.
// tosu fills the results in shortly after the state changes, so the record is taken RESULTS_SETTLE_MS later (or when
// the screen is left earlier) from the latest message.
function trackResults(d, info) {
  const st = d.state ? d.state.number : null;
  if (st === STATE_RESULTS) {
    S.resultsMsg = { d, info };
    if (S.state === STATE_PLAY) {
      clearTimeout(S.resultsTimer);
      S.resultsTimer = setTimeout(takeResults, RESULTS_SETTLE_MS);
    }
  } else if (S.state === STATE_RESULTS) {
    if (S.resultsTimer) { clearTimeout(S.resultsTimer); takeResults(); }
    S.lastPlay = null;
  }
  S.state = st;
}

function takeResults() {
  S.resultsTimer = null;
  const m = S.resultsMsg;
  if (!m) return;
  const { d, info } = m;
  const rs = d.resultsScreen || {};
  const me = d.profile && d.profile.name;
  if (me && rs.playerName && rs.playerName !== me) return;
  if (rs.mode && rs.mode.number !== 3) return;
  const mods = readMods(rs.mods || (d.play && d.play.mods));
  const acc = scoreV1Acc(rs.hits);
  if (!info.checksum || !mods.ok || acc === null) return;
  const rec = { at: Date.now(), checksum: info.checksum, title: info.title, version: info.version, key: `${info.checksum}#${mods.key}`,
    rate: mods.rate, label: mods.label, acc: Math.round(acc * 100) / 100, created: rs.createdAt || '', score: rs.score || 0 };
  const last = S.history[0];
  if (last && last.key === rec.key && last.created === rec.created && last.score === rec.score && last.acc === rec.acc) { S.lastPlay = last; return render(); }
  S.history.unshift(rec);
  S.history.length = Math.min(S.history.length, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(S.history)); } catch (e) { /* no storage: this session only */ }
  S.lastPlay = rec;
  render();
}

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(h) ? h : [];
  } catch (e) { return []; }
}

// the star reading of a recorded play comes from the reading cache (map + mods), filled at song select or after the play
function playsWithStars() {
  return S.history.map(p => {
    const c = S.cache.get(p.key);
    return { ...p, star: c && c.ok ? c.star : null, reliable: c && c.ok ? c.reliable : null };
  });
}

function renderPlayer(res) {
  const box = $('player');
  const P = S.ladder;
  box.replaceChildren();
  box.hidden = !S.settings.playerLevel || !P;
  if (box.hidden) return;
  const line = (text, cls = '') => { const el = document.createElement('div'); el.className = 'pl-line ' + cls; el.textContent = text; box.append(el); };
  const plays = playsWithStars();
  if (S.state === STATE_RESULTS && S.lastPlay) {
    const p = plays.find(x => x.at === S.lastPlay.at) || S.lastPlay;
    if (!Number.isFinite(p.star)) line(`这局 ${p.acc.toFixed(2)}%（ScoreV1）· 等星数算好后换算水平`, 'muted');
    else if (!usableAcc(P, p.acc)) line(`这局 ${p.acc.toFixed(2)}%（ScoreV1）· acc 太高或太低，不用来估水平`, 'muted');
    else line(`这局 ${p.acc.toFixed(2)}%（ScoreV1）≈ ${playLevel(P, p.star, p.acc, p.rate).toFixed(2)} 星水平${p.reliable === false ? '（星数不可靠，不计入）' : ''}`);
  }
  const est = estimateLevel(P, plays, S.settings.playerWindow);
  if (est.level === null) {
    line(`我的水平：已有 ${est.used.length}/${est.needed} 局可用成绩（完整打完的 4K 谱，acc 85%–99%）`, 'muted');
    return;
  }
  if (res && res.ok) {
    const m = S.info && S.info.mods.ok ? S.info.mods : { rate: 1, hit: '', od: null };
    const v = predictView(P, est.level, res.star, m.rate);
    if (v.tooHard) line(`比你最近的水平难 ${v.gap.toFixed(1)} 星：回测里这种谱打完的局多半比公式高很多，预计不可靠`, 'warn');
    else line(`预计 acc ${fmtExpectedAcc(P, v.acc)}（十局约八局在 ${fmtExpectedAcc(P, v.lo)} ～ ${fmtExpectedAcc(P, v.hi)}）`, 'strong');
    const tested = m.rate === 1 && !m.hit && m.od === null;
    line(`按最近 ${est.used.length} 局估的水平 ${est.level.toFixed(2)} 星（单局 ${est.lo.toFixed(1)}–${est.hi.toFixed(1)}）· `
      + (tested ? '区间按回测给出，只测过 NoMod 排名谱、打完的局' : '开了 Mod：区间未经检验（回测只有 NoMod）'), 'muted');
  } else {
    line(`我的水平 ≈ ${est.level.toFixed(2)} 星（近 ${est.used.length} 局，单局 ${est.lo.toFixed(1)}–${est.hi.toFixed(1)}）`);
  }
  if (est.hi - est.lo >= WIDE_SPREAD) line('最近几局起伏大，区间可能偏窄', 'warn');
  if (est.level < NOVICE_BELOW) line('3 星以下实测更宽：十局约八局在 −3 / +9 个百分点内', 'warn');
}

// ---------------------------------------------------------------- cache (per browser, survives restarts)
function loadCache() {
  const m = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY + 'results') || '[]');
    for (const [k, v] of raw) m.set(k, v);
  } catch (e) { /* no storage: keep the results of this session only */ }
  return m;
}
function saveResult(key, res) {
  const keep = res.ok
    ? { ok: true, star: res.star, reliable: res.reliable, thetaFlag: res.thetaFlag, md5: res.md5, rate: res.rate,
        v2: res.v2 ? { star: res.v2.star } : null, lnFrac: res.lnFrac,
        // segment curve, rounded to keep the browser cache small
        segments: (res.segments || []).map(g => ({ startS: r1(g.startS), endS: r1(g.endS), star: g.star === null ? null : r2(g.star), sparse: g.sparse })),
        hardest: res.hardest ? { startS: r1(res.hardest.startS), endS: r1(res.hardest.endS), star: r2(res.hardest.star) } : null,
        flags: { sv: res.flags.sv, storyboard: res.flags.storyboard, outOfRangeReasons: res.flags.outOfRangeReasons, jackHeavy: res.flags.jackHeavy } }
    : { ok: false, reason: res.reason, message: res.message };
  S.cache.delete(key);
  S.cache.set(key, keep);
  while (S.cache.size > CACHE_MAX) S.cache.delete(S.cache.keys().next().value);
  try { localStorage.setItem(CACHE_KEY + 'results', JSON.stringify([...S.cache])); } catch (e) { /* full or blocked */ }
}

// ---------------------------------------------------------------- view
function render() {
  $('card').classList.toggle('hidden-play', !!(S.playing && S.settings.hideWhilePlaying));
  $('hint').hidden = S.settings.bottom !== BOTTOM.hint;
  const info = S.info;
  const res = S.key ? S.cache.get(S.key) || (S.failed && S.failed.key === S.key ? S.failed.res : null) : null;
  $('title').textContent = info && info.checksum ? `${info.title}${info.version ? ` [${info.version}]` : ''}` : '';
  $('mod').textContent = info ? (info.mods.ok ? info.mods.label : '不支持的 Mod') : '';
  $('mod').hidden = !info;
  const starEl = $('star');
  const tags = [];
  let status = '', star = '–', dim = true, dan = null;
  if (!S.connected) status = '连不上 tosu，重连中…（请确认 tosu 已运行）';
  else if (!info || !info.checksum) status = '等待 tosu 报告谱面…';
  else if (!info.mods.ok) status = info.mods.why;
  else if (info.mode !== 3) status = '不是 osu!mania 谱面（转谱不支持）';
  else if (res && res.ok) {
    star = res.star.toFixed(2); dim = false;
    if (!info.mods.tested) tags.push(['warn', info.mods.untested.join('；')]);
    if (!res.reliable) {
      const why = [];
      if (res.flags.sv) why.push('明显变速（SV）');
      if (res.flags.storyboard) why.push('带 storyboard');
      if (res.flags.outOfRangeReasons && res.flags.outOfRangeReasons.length) why.push(res.flags.outOfRangeReasons[0]);
      tags.push(['bad', '不可靠：' + why.join('、')]);
    }
    if (res.flags.jackHeavy) tags.push(['warn', 'jack 很多（jackheavy）']);
    dan = danEstimate(res, S.dans);
  } else if (res) status = res.message;
  else if (S.playing) status = '打歌中：暂停计算，回到选歌界面后再算';
  else if (S.phase === 'error') status = S.error || '模型加载失败';
  else if (S.phase === 'loading') status = '加载模型中…';
  else if (S.job) status = `计算中 ${S.job.pct}%`;
  else status = '准备计算…';
  if (info && info.mods.ok && info.mods.notes.length && !dim) tags.push(['info', info.mods.notes.join('；')]);
  renderDan(dan, info);
  renderPlayer(res && res.ok ? res : null);
  renderCurve(res && res.ok && S.settings.bottom === BOTTOM.curve ? res : null);
  starEl.textContent = star;
  starEl.classList.toggle('dim', dim);
  $('status').textContent = status;
  $('status').hidden = !status;
  const box = $('tags');
  box.replaceChildren(...tags.map(([k, t]) => { const s = document.createElement('div'); s.className = 'tag ' + k; s.textContent = t; return s; }));
}
// 米 / 面段位: where this reading sits among the REFORM / LN dan charts (same model, same line); not a pass prediction
function renderDan(est, info) {
  const box = $('dan');
  box.replaceChildren();
  box.hidden = !est;
  if (!est) return;
  const chip = (x, name) => {
    if (!x) return null;
    const el = document.createElement('span');
    el.className = 'dan-item' + (x.muted || est.unreliable ? ' muted' : '');
    el.textContent = `${name} ${x.text}${x.note ? `（${x.note}）` : ''}`;
    return el;
  };
  box.append(...[chip(est.rice, '米段位'), chip(est.face, '面段位')].filter(Boolean));
  const m = info && info.mods;
  if (m && m.ok && (m.rate !== 1 || m.hit || m.od !== null)) {
    const n = document.createElement('div');
    n.className = 'dan-note';
    n.textContent = `${m.label}：用这组 Mod 下的读数和 NoMod 段位谱比较`;
    box.append(n);
  }
}

const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;

// 难度曲线 (setting): the web page's segment curve (10 s windows, old public-star scale, only for the shape)
function renderCurve(res) {
  const box = $('curve');
  const key = res ? S.key : null;
  box.hidden = !res || !res.segments || !res.segments.length;
  if (key === S.curveKey) return;
  S.curveKey = key;
  if (box.hidden) { box.replaceChildren(); return; }
  const svg = buildSegmentsSvg(res.segments, res.hardest);
  S.curveEnd = Math.max(...res.segments.map(g => g.endS), 1);
  // same plot box as buildSegmentsSvg (W 320, H 96, L 30, R 8, T 8, B 18)
  box.innerHTML = svg.replace('</svg>', '<line id="playhead" class="playhead" x1="0" y1="8" x2="0" y2="78" visibility="hidden"/></svg>');
  const cap = document.createElement('div');
  cap.className = 'curve-cap';
  cap.textContent = (res.hardest ? `最难一段 ${fmtTime(res.hardest.startS)}–${fmtTime(res.hardest.endS)}（高亮）· ` : '') + '每 10 秒一段，只看起伏，不等于总星数';
  box.append(cap);
  movePlayhead();
}

function movePlayhead() {
  const ph = document.getElementById('playhead');
  if (!ph) return;
  if (S.live === null || !(S.live >= 0) || S.live > S.curveEnd) { ph.setAttribute('visibility', 'hidden'); return; }
  const x = (30 + (S.live / S.curveEnd) * (320 - 30 - 8)).toFixed(1);
  ph.setAttribute('x1', x); ph.setAttribute('x2', x); ph.setAttribute('visibility', 'visible');
}

render();
document.title = `${VERSION} · tosu`;
