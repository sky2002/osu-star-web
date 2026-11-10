// Helper worker: second-layer scores (Reader.secondLayerRange) for a range of reference-path profiles, and the star v3
// accuracy sums (V3Core.readoutRange) for a range of levels.
// Receives a MessagePort from the page; the compute worker talks to it through that port.
import { Reader } from './reader.js';
import { buildTable } from './tdist.js';
import { V3Core } from './v3.js';

let reader = null;
let v3 = null;
function handle(port, m) {
  try {
    if (m.type === 'init') {
      reader = new Reader(m.R, buildTable(m.R.t_nus, m.R.t_grid, m.R.t_c), null, null);
      port.postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const S = reader.secondLayerRange(m.l, m.comp, m.lnH, m.lnT, m.od, m.p0, m.p1, m.rate || 1, m.hit || '', m.cal || null);
      port.postMessage({ type: 'done', job: m.job, S }, [S.buffer]);
    } else if (m.type === 'v3init') {
      v3 = new V3Core(m.J, m.tab);
      port.postMessage({ type: 'done', job: m.job, S: null });
    } else if (m.type === 'v3run') {
      const S = v3.readoutRange(m.xs, m.comp, m.lnH, m.lnT, m.w, m.rate, m.p0, m.p1);
      port.postMessage({ type: 'done', job: m.job, S }, [S.buffer]);
    }
  } catch (e) {
    port.postMessage({ type: 'fail', job: m.job, message: String(e && e.message || e) });
  }
}
self.onmessage = (ev) => {
  if (ev.data.type === 'port') {
    const port = ev.data.port;
    port.onmessage = e => handle(port, e.data);
  }
};
