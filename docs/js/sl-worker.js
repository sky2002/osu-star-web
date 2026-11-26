// Helper worker: second-layer scores (Reader.secondLayerRange) for a range of reference-path profiles, and the star v3
// accuracy sums (V3Core.readoutRange) for a range of levels.
// Receives a MessagePort from the page; the compute worker talks to it through that port.
import { Reader } from './reader.js';
import { buildTable } from './tdist.js';
import { V3Core } from './v3.js';
import { CancelledError, checkpoint } from './task-control.js';

let reader = null;
let v3 = null;
let V4Score = null;
const modulePath = './v4-score.js';
const running = new Map();
async function handle(port, m) {
  if (m.type === 'cancel') {
    const task = running.get(m.job);
    if (task) task.cancelled = true;
    return;
  }
  const task = { cancelled: false };
  const isCancelled = () => task.cancelled;
  if (m.job != null) running.set(m.job, task);
  try {
    if (m.type === 'init') {
      reader = new Reader(m.R, buildTable(m.R.t_nus, m.R.t_grid, m.R.t_c), null, null);
      port.postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const A = m.comp.length;
      const S = new Float32Array((m.p1 - m.p0) * A);
      for (let p = m.p0; p < m.p1; p++) {
        await checkpoint(isCancelled);
        S.set(reader.secondLayerRange(m.l, m.comp, m.lnH, m.lnT, m.od, p, p + 1, m.rate || 1, m.hit || '', m.cal || null), (p - m.p0) * A);
      }
      port.postMessage({ type: 'done', job: m.job, S }, [S.buffer]);
    } else if (m.type === 'v3init') {
      v3 = new V3Core(m.J, m.tab);
      port.postMessage({ type: 'done', job: m.job, S: null });
    } else if (m.type === 'v3run') {
      const S = new Float64Array(m.p1 - m.p0);
      for (let p = m.p0; p < m.p1; p++) {
        await checkpoint(isCancelled);
        S.set(v3.readoutRange(m.xs, m.comp, m.lnH, m.lnT, m.w, m.rate, p, p + 1), p - m.p0);
      }
      port.postMessage({ type: 'done', job: m.job, S }, [S.buffer]);
    } else if (m.type === 'v4init') {
      ({ V4Score } = await import(modulePath));
      port.postMessage({ type: 'done', job: m.job, S: null });
    } else if (m.type === 'v4run') {
      const score = new V4Score(m.outputs, m.layout, m.od, m.rate, m.hit);
      const S = await score.readRows(m.levels, isCancelled);
      port.postMessage({ type: 'done', job: m.job, S }, [S.buffer]);
    }
  } catch (e) {
    if (!(e instanceof CancelledError)) port.postMessage({ type: 'fail', job: m.job, message: String(e?.message || e) });
  } finally {
    running.delete(m.job);
  }
}
self.onmessage = (ev) => {
  if (ev.data.type === 'port') {
    const port = ev.data.port;
    port.onmessage = e => handle(port, e.data);
  }
};
