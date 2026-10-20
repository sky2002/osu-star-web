// Helper workers for the second layer of long charts. They are spawned by the page (main thread) and connected to the
// compute worker with MessagePorts, so no nested workers are needed. Results are identical to the single-thread path:
// every profile row is computed by the same code and accumulated in the same order.

// main thread: start `size` helpers, return the ports to hand to the compute worker
export function spawnHelpers(size) {
  const ports = [];
  for (let i = 0; i < size; i++) {
    try {
      const w = new Worker(new URL('./sl-worker.js', import.meta.url), { type: 'module' });
      const ch = new MessageChannel();
      w.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
      ports.push(ch.port2);
    } catch (e) { break; }
  }
  return ports;
}

// compute worker: a pool over the helper ports (null if none answer)
export async function createPool(R, ports, timeoutMs = 20000) {
  if (!ports || !ports.length) return null;
  const ok = await Promise.all(ports.map(p => new Promise(res => {
    const timer = setTimeout(() => res(false), timeoutMs);
    p.onmessage = e => { clearTimeout(timer); res(e.data.type === 'ready'); };
    p.postMessage({ type: 'init', R });
  })));
  const live = ports.filter((_, i) => ok[i]);
  if (!live.length) return null;
  let job = 0, next = 0;
  const pending = new Map();
  for (const p of live) {
    p.onmessage = e => {
      const q = pending.get(e.data.job);
      pending.delete(e.data.job);
      if (!q) return;
      if (e.data.type === 'done') q.res(e.data.S); else q.rej(new Error(e.data.message));
    };
  }
  return {
    size: live.length,
    run(l, comp, lnH, lnT, od, p0, p1, rate = 1, hit = '', cal = null) {
      const id = ++job;
      const p = live[next++ % live.length];
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        p.postMessage({ type: 'run', job: id, l, comp, lnH, lnT, od, p0, p1, rate, hit, cal });
      });
    },
  };
}
