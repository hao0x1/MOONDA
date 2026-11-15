/** Shared data downloads: a stalled connection is retried, while a slow transfer that
 * keeps making progress can finish even when a large height map takes a minute. */
export interface DataFetchOptions {
  tries?: number;
  idleTimeoutMs?: number;
  retryDelayMs?: number;
  cache?: RequestCache;
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void;
}

function stopped(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Download cancelled', 'AbortError');
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  stopped(signal);
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Download cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function download(url: string, options: DataFetchOptions): Promise<ArrayBuffer> {
  stopped(options.signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`Download stalled: ${url}`)), options.idleTimeoutMs ?? 15000);
  };
  const abort = () => controller.abort(options.signal?.reason ?? new DOMException('Download cancelled', 'AbortError'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  touch();
  try {
    const body = (async () => {
      const response = await fetch(url, { signal: controller.signal, cache: options.cache });
      stopped(controller.signal);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      touch();
      const length = Number(response.headers.get('content-length'));
      const total = length > 0 ? length : null;
      if (!response.body) return response.arrayBuffer();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        stopped(controller.signal);
        if (done) break;
        if (!value.byteLength) continue;
        touch();
        chunks.push(value); size += value.byteLength;
        options.onProgress?.(size, total);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes.buffer;
    })();
    return await Promise.race([body, interrupted]);
  } finally {
    clearTimeout(timer!);
    options.signal?.removeEventListener('abort', abort);
    // Abort also releases an unfinished native fetch/body before the next attempt starts.
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

async function readWithRetry<T>(url: string, options: DataFetchOptions, decode: (bytes: ArrayBuffer) => T): Promise<T> {
  const tries = Math.max(1, options.tries ?? 3);
  for (let attempt = 0; ; attempt++) {
    try { return decode(await download(url, options)); }
    catch (error) {
      stopped(options.signal);
      if (attempt + 1 >= tries) throw error;
      await pause((options.retryDelayMs ?? 500) * 2 ** attempt, options.signal);
    }
  }
}

export function fetchBytesWithRetry(url: string, options: DataFetchOptions = {}): Promise<ArrayBuffer> {
  return readWithRetry(url, options, bytes => bytes);
}

export function fetchJsonWithRetry<T>(url: string, options: DataFetchOptions = {}): Promise<T> {
  return readWithRetry(url, options, bytes => JSON.parse(new TextDecoder().decode(bytes)) as T);
}
