const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function phaseFor(file) {
  if (file.includes('v4')) return 'v4';
  if (file.includes('v3')) return 'v3';
  if (file.includes('cnn36')) return 'cnn';
  return 'init';
}

export function createResourceLoader(base, send, { fetchFile = fetch, timeoutMs = 30000, backoff = [1000, 2000, 4000] } = {}) {
  const groups = new Map(), pending = new Map();

  function report(phase, file, group) {
    let loadedBytes = 0, totalBytes = 0, known = true;
    for (const part of group.values()) {
      if (part.failed) return;
      loadedBytes += part.loaded;
      totalBytes += part.total ?? 0;
      if (part.total == null) known = false;
    }
    send({ type: 'load_progress', phase, loadedBytes, totalBytes: known ? totalBytes : 0, file });
  }

  async function read(file, part, progress, asJson) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      part.loaded = 0;
      part.total = null;
      try {
        const response = await fetchFile(new URL(file, base), { signal: controller.signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('HTTP ' + response.status);
        }
        const length = response.headers.get('Content-Length');
        if (length && !response.headers.get('Content-Encoding') && Number.isFinite(Number(length))) part.total = Number(length);
        progress();
        let bytes;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              part.loaded += value.byteLength;
              progress();
            }
          } finally { reader.releaseLock(); }
          bytes = new Uint8Array(part.loaded);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        } else {
          bytes = new Uint8Array(await response.arrayBuffer());
          part.loaded = bytes.byteLength;
        }
        if (part.total !== null && part.total !== bytes.length) throw new Error('下载的文件不完整');
        part.total = bytes.length;
        progress();
        return asJson ? JSON.parse(new TextDecoder().decode(bytes)) : bytes;
      } catch (e) {
        if (attempt >= backoff.length) {
          const detail = controller.signal.aborted ? '网络超时' : e instanceof TypeError ? '网络连接失败：' + e.message :
            e instanceof SyntaxError ? '资源文件格式错误' : e.message || String(e);
          throw Object.assign(new Error(file + '：' + detail), { file, phase: phaseFor(file) });
        }
      } finally { clearTimeout(timer); }
      await sleep(backoff[attempt]);
    }
  }

  function load(file, asJson) {
    if (pending.has(file)) return pending.get(file);
    const phase = phaseFor(file);
    if (!groups.has(phase)) groups.set(phase, new Map());
    const group = groups.get(phase);
    const part = { loaded: 0, total: null, done: false };
    group.set(file, part);
    const active = read(file, part, () => report(phase, file, group), asJson).then(value => {
      part.done = true;
      if ([...group.values()].every(p => p.done)) {
        groups.delete(phase);
        send({ type: 'load_done', phase });
      }
      return value;
    }, error => {
      part.failed = true;
      throw error;
    }).finally(() => pending.delete(file));
    pending.set(file, active);
    return active;
  }
  return { loadBytes: file => load(file, false), loadJson: file => load(file, true) };
}
