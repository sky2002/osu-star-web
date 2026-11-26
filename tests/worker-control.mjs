import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceLoader } from '../docs/js/resources.js';
import { CancelledError, checkpoint, untilCancelled } from '../docs/js/task-control.js';
import { createPool } from '../docs/js/pool.js';
import { v4HelperCount } from '../docs/js/v4.js';
import { Engine } from '../docs/js/engine.js';

const base = new URL('http://localhost/');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function task() {
  const ctl = new AbortController();
  const cancelled = Object.assign(() => ctl.signal.aborted, { signal: ctl.signal });
  return { ctl, cancelled };
}

test('resource progress counts streamed bodies across files and reports completion', async () => {
  const events = [];
  const load = createResourceLoader(base, e => events.push(e), {
    fetchFile: async url => {
      const chunks = url.pathname.endsWith('.json') ? ['{', '}'] : ['ab', 'cd'];
      const bytes = chunks.map(s => Uint8Array.from([...s], c => c.charCodeAt(0)));
      const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(b); c.close(); } });
      return new Response(stream, { headers: { 'Content-Length': String(chunks.join('').length) } });
    },
  });
  const [json, bytes] = await Promise.all([load.loadJson('model/v4.json'), load.loadBytes('model/v4a.onnx')]);
  assert.deepEqual(json, {});
  assert.equal(bytes.length, 4);
  const progress = events.filter(e => e.type === 'load_progress');
  assert.ok(progress.some(e => e.totalBytes === 6 && e.loadedBytes > 0 && e.loadedBytes < 6));
  assert.equal(progress.at(-1).loadedBytes, 6);
  assert.deepEqual(events.at(-1), { type: 'load_done', phase: 'v4' });
});

test('HTTP errors identify the file, retry up to three times and allow a fresh request', async () => {
  let calls = 0;
  const load = createResourceLoader(base, () => {}, { backoff: [0, 0, 0],
    fetchFile: async () => ++calls <= 4 ? new Response('', { status: 503 }) : new Response('{"ok":true}'),
  });
  await assert.rejects(load.loadJson('model/v4.json'), e => {
    assert.equal(e.file, 'model/v4.json');
    return e.message.includes('HTTP 503');
  });
  assert.equal(calls, 4);
  assert.deepEqual(await load.loadJson('model/v4.json'), { ok: true });

  const events = [];
  let finish;
  const delayed = new Promise(res => { finish = res; });
  const siblings = createResourceLoader(base, e => events.push(e), { backoff: [],
    fetchFile: async url => url.pathname.endsWith('.json') ? new Response('', { status: 404 }) : delayed,
  });
  const slow = siblings.loadBytes('model/v4a.onnx');
  await assert.rejects(siblings.loadJson('model/v4.json'), /HTTP 404/);
  const afterFailure = events.length;
  finish(new Response('ok'));
  await slow;
  assert.equal(events.length, afterFailure, 'a late sibling cannot hide the retry button');
});

test('a timeout also covers a response whose body stops arriving', async () => {
  const load = createResourceLoader(base, () => {}, { timeoutMs: 5, backoff: [],
    fetchFile: async (_, { signal }) => new Response(new ReadableStream({ start(c) {
      signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
    } })),
  });
  await assert.rejects(load.loadBytes('model/v4a.onnx'), /v4a\.onnx.*网络超时/);
});

test('a busy worker yields to a cancellation message before the next block', async () => {
  const { ctl, cancelled } = task();
  const timer = setTimeout(() => ctl.abort(), 0);
  try { await assert.rejects(checkpoint(cancelled), CancelledError); }
  finally { clearTimeout(timer); }
});

test('a chart can stop waiting while another chart uses the same download', async () => {
  const { ctl, cancelled } = task();
  let finish;
  const download = new Promise(res => { finish = res; });
  const wait = untilCancelled(download, cancelled);
  ctl.abort();
  await assert.rejects(wait, CancelledError);
  finish(17);
  assert.equal(await download, 17);
});

test('the helper pool uses successful handshakes and forwards cancellation to the working helper', async () => {
  const channels = [new MessageChannel(), new MessageChannel()];
  try {
    let job, stop;
    const stopped = new Promise(resolve => { stop = resolve; });
    channels[0].port2.onmessage = ({ data }) => {
      if (data.type === 'init') channels[0].port2.postMessage({ type: 'ready' });
      else if (data.type === 'cancel') { assert.equal(data.job, job); stop(); }
      else job = data.job;
    };
    channels[1].port2.onmessage = () => channels[1].port2.postMessage({ type: 'fail' });
    const pool = await createPool({}, channels.map(ch => ch.port1));
    assert.equal(pool.size, 1);
    const { ctl, cancelled } = task();
    const run = pool.callOn(0, { type: 'run' }, cancelled);
    ctl.abort();
    await assert.rejects(run, CancelledError);
    await stopped;
  } finally {
    for (const ch of channels) { ch.port1.close(); ch.port2.close(); }
  }
});

test('helper count is capped for both ordinary and large charts', () => {
  assert.equal(v4HelperCount(8, 300, 0), 4);
  assert.equal(v4HelperCount(4, 22000, 6000), 2);
  assert.equal(v4HelperCount(1, 30000, 500), 1);
});

test('v4 preserves loading, memory and chart diagnostics, and cancellation bypasses warnings', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const e = new Engine();
  const options = { od: 5, rate: 1, flags: {} };
  e.ensureV4 = async () => { throw Object.assign(new Error('model/v4.json：网络超时'), { file: 'model/v4.json' }); };
  const load = await e.v4Star([], options);
  assert.equal(load.reason, 'load_error');
  assert.match(load.text, /v4\.json.*网络超时/);
  assert.equal(load.file, 'model/v4.json');
  for (const [message, expected] of [['out of memory', /内存不足/], ['invalid chart', /谱面计算异常/]]) {
    e.ensureV4 = async () => ({ model: { run: async () => { throw new Error(message); } } });
    const result = await e.v4Star([], options);
    assert.equal(result.reason, 'run_error');
    assert.match(result.text, expected);
  }
  e.ensureV4 = async () => { throw new CancelledError(); };
  await assert.rejects(e.v4Star([], options), CancelledError);
  assert.equal(warnings.mock.callCount(), 3);
});

test('worker removes a waiting chart and acknowledges a running cancellation exactly once', async t => {
  const messages = [];
  const original = globalThis.self;
  globalThis.self = { postMessage: m => messages.push(m) };
  t.after(() => { if (original === undefined) delete globalThis.self; else globalThis.self = original; });
  await import('../docs/js/worker.js');
  const send = data => self.onmessage({ data });
  send({ type: 'score', id: 11 });
  send({ type: 'score', id: 12 });
  send({ type: 'cancel', id: 12 });
  send({ type: 'cancel', id: 11 });
  await tick();
  assert.deepEqual(messages, [{ type: 'cancelled', id: 12 }, { type: 'cancelled', id: 11 }]);
});
