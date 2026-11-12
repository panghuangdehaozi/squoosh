import {
  backgroundRemovalAssets,
  backgroundRemovalCache,
  backgroundRemovalPath,
} from 'worker-shared/background-removal';

export type BackgroundRemovalPhase = 'loading' | 'processing';

interface Task {
  id: number;
  image: ImageData;
  signal: AbortSignal;
  controller: AbortController;
  onAbort(): void;
  onProgress?: (phase: BackgroundRemovalPhase) => void;
  resolve(image: ImageData): void;
  reject(error: Error): void;
}

let nextId = 0;
let worker: Worker | undefined;
let active: Task | undefined;
const queue: Task[] = [];

function abortError(): DOMException {
  return new DOMException('操作已取消', 'AbortError');
}

// Load only on demand. Keep model assets separate from the app's versioned cache.
async function prepareAssets(signal: AbortSignal): Promise<void> {
  let cache: Cache;
  try {
    cache = await caches.open(backgroundRemovalCache);
  } catch {
    // Browsers that disallow persistent storage can still process online.
    return;
  }

  await Promise.all(
    backgroundRemovalAssets.map(async (url) => {
      if (signal.aborted) throw abortError();
      const cached = await cache.match(url);
      if (cached?.ok) return;
      const response = await fetch(url, { signal });
      if (
        !response.ok ||
        response.headers.get('content-type')?.includes('text/html')
      ) {
        throw new Error('去背景资源加载失败，请重试');
      }
      try {
        await cache.put(url, response);
      } catch {
        // Storage quota failures must not prevent online processing.
      }
    }),
  );
}

function terminateWorker(): void {
  if (!worker) return;
  worker.onmessage = null;
  worker.onerror = null;
  worker.onmessageerror = null;
  worker.terminate();
  worker = undefined;
}

function finish(task: Task, error?: Error, image?: ImageData): void {
  if (active !== task) return;
  task.signal.removeEventListener('abort', task.onAbort);
  task.controller.abort();
  active = undefined;
  if (error) task.reject(error);
  else task.resolve(image!);
  pump();
}

function startWorker(): Worker {
  const url = new URL(backgroundRemovalPath + 'worker.js', location.href);
  const instance = new Worker(url.href);
  instance.onmessage = ({ data }) => {
    const task = active;
    if (worker !== instance || !task || data.id !== task.id) return;
    if (data.phase) {
      task.onProgress?.(data.phase);
      return;
    }
    if (data.error) {
      terminateWorker();
      finish(task, new Error(data.error));
    } else if (data.image instanceof ImageData) {
      finish(task, undefined, data.image);
    } else {
      terminateWorker();
      finish(task, new Error('去背景结果无效，请重试'));
    }
  };
  const onError = (event: Event) => {
    event.preventDefault();
    if (worker !== instance) return;
    const task = active;
    terminateWorker();
    if (task) finish(task, new Error('去背景处理失败，请重试'));
  };
  instance.onerror = onError;
  instance.onmessageerror = onError;
  return instance;
}

function pump(): void {
  if (active || !queue.length) return;
  const task = queue.shift()!;
  active = task;
  task.onProgress?.('loading');
  (async () => {
    if (!worker) await prepareAssets(task.controller.signal);
    if (active !== task || task.signal.aborted) return;
    if (!worker) worker = startWorker();
    // Clone the input: the editor still needs its pixels for the original view.
    worker.postMessage({ id: task.id, image: task.image });
  })().catch((error) => {
    if (active !== task) return;
    terminateWorker();
    finish(task, error instanceof Error ? error : new Error(String(error)));
  });
}

export function removeBackground(
  signal: AbortSignal,
  image: ImageData,
  onProgress?: (phase: BackgroundRemovalPhase) => void,
): Promise<ImageData> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const task: Task = {
      id: ++nextId,
      image,
      signal,
      controller: new AbortController(),
      resolve,
      reject,
      onProgress,
      onAbort() {
        if (active === task) {
          terminateWorker();
          finish(task, abortError());
          return;
        }
        const index = queue.indexOf(task);
        if (index !== -1) queue.splice(index, 1);
        signal.removeEventListener('abort', task.onAbort);
        task.controller.abort();
        reject(abortError());
      },
    };
    signal.addEventListener('abort', task.onAbort);
    queue.push(task);
    pump();
  });
}

export function releaseBackgroundRemoval(): void {
  const tasks = queue.splice(0);
  if (active) tasks.push(active);
  active = undefined;
  terminateWorker();
  for (const task of tasks) {
    task.signal.removeEventListener('abort', task.onAbort);
    task.controller.abort();
    task.reject(abortError());
  }
}
