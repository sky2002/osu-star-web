export class CancelledError extends Error {
  constructor() {
    super('计算已取消。');
    this.name = 'CancelledError';
  }
}

export function checkCancelled(isCancelled) {
  if (isCancelled?.()) throw new CancelledError();
}

const lastYield = new WeakMap();

export async function checkpoint(isCancelled) {
  if (!isCancelled) return;
  checkCancelled(isCancelled);
  const now = performance.now();
  if (now - (lastYield.get(isCancelled) ?? -Infinity) < 32) return;
  lastYield.set(isCancelled, now);
  // WASM may resolve a promise without giving the worker a chance to receive messages.
  await new Promise(resolve => setTimeout(resolve, 0));
  checkCancelled(isCancelled);
}

// A cancelled chart can leave a shared resource download running for the next chart.
export function untilCancelled(promise, isCancelled) {
  const signal = isCancelled?.signal;
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new CancelledError());
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
