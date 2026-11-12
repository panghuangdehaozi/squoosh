/* Background removal worker. Third-party licenses are listed in NOTICE.txt. */

const assetBase = new URL('./', self.location.href);
const modelURL = new URL('u2netp.onnx', assetBase).href;
const modelSize = 320;
const mean = [0.485, 0.456, 0.406];
const standardDeviation = [0.229, 0.224, 0.225];
let sessionPromise;
let queue = Promise.resolve();

function canvasContext(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法处理这张图片，请重试');
  return context;
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      importScripts(new URL('ort.wasm.min.js', assetBase).href);
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = assetBase.href;

      let response;
      if ('caches' in self) {
        try {
          response = await caches.match(modelURL);
        } catch (_) {
          // Restricted storage must not prevent online processing.
        }
      }
      if (!response || !response.ok) response = await fetch(modelURL);
      if (!response.ok) throw new Error('去背景资源加载失败，请重试');

      return ort.InferenceSession.create(await response.arrayBuffer(), {
        executionProviders: ['wasm'],
      });
    })().catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
  }
  return sessionPromise;
}

async function prepareInput(image) {
  const canvas = new OffscreenCanvas(modelSize, modelSize);
  const context = canvasContext(canvas);
  const bitmap = await createImageBitmap(image);
  try {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, modelSize, modelSize);
    const pixels = context.getImageData(0, 0, modelSize, modelSize).data;
    let maximum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      maximum = Math.max(maximum, pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    maximum = Math.max(maximum, 1e-6);

    const planeSize = modelSize * modelSize;
    const values = new Float32Array(planeSize * 3);
    for (let i = 0; i < planeSize; i++) {
      for (let channel = 0; channel < 3; channel++) {
        values[channel * planeSize + i] =
          (pixels[i * 4 + channel] / maximum - mean[channel]) /
          standardDeviation[channel];
      }
    }
    return new ort.Tensor('float32', values, [1, 3, modelSize, modelSize]);
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}

function applyMask(image, prediction) {
  const [batch, channels, height, width] = prediction.dims;
  const count = width * height;
  if (
    batch !== 1 ||
    channels < 1 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > modelSize * modelSize ||
    prediction.data.length < count
  ) {
    throw new Error('去背景处理失败，请重试');
  }

  let minimum = Infinity;
  let maximum = -Infinity;
  for (let i = 0; i < count; i++) {
    const value = prediction.data[i];
    if (!Number.isFinite(value)) throw new Error('去背景处理失败，请重试');
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }

  const range = maximum - minimum;
  const maskPixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    // A constant prediction has no contrast to normalize; retain its probability.
    const value =
      range > 1e-6 ? (prediction.data[i] - minimum) / range : minimum;
    const intensity = Math.round(Math.max(0, Math.min(1, value)) * 255);
    maskPixels[i * 4] =
      maskPixels[i * 4 + 1] =
      maskPixels[i * 4 + 2] =
        intensity;
    maskPixels[i * 4 + 3] = 255;
  }

  const smallCanvas = new OffscreenCanvas(width, height);
  const fullCanvas = new OffscreenCanvas(image.width, image.height);
  try {
    canvasContext(smallCanvas).putImageData(
      new ImageData(maskPixels, width, height),
      0,
      0,
    );
    const context = canvasContext(fullCanvas);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(smallCanvas, 0, 0, image.width, image.height);
    const mask = context.getImageData(0, 0, image.width, image.height).data;
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i + 3] = Math.round((image.data[i + 3] * mask[i]) / 255);
    }
    return image;
  } finally {
    smallCanvas.width = smallCanvas.height = 0;
    fullCanvas.width = fullCanvas.height = 0;
  }
}

async function removeBackground({ id, image }) {
  if (
    !image ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !(image.data instanceof Uint8ClampedArray) ||
    image.data.length !== image.width * image.height * 4
  ) {
    throw new Error('图片数据无效，请重新选择');
  }
  if (
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new Error('当前浏览器不支持去背景，请使用新版浏览器');
  }

  self.postMessage({ id, phase: 'loading' });
  const session = await getSession();
  self.postMessage({ id, phase: 'processing' });
  const input = await prepareInput(image);
  let outputs;
  try {
    outputs = await session.run({ [session.inputNames[0]]: input }, [
      session.outputNames[0],
    ]);
    const prediction = outputs[session.outputNames[0]];
    if (!prediction) throw new Error('去背景处理失败，请重试');
    const result = applyMask(image, prediction);
    self.postMessage({ id, image: result }, [result.data.buffer]);
  } finally {
    input.dispose();
    if (outputs) {
      for (const output of Object.values(outputs)) output.dispose();
    }
  }
}

self.onmessage = ({ data }) => {
  if (!data || !Number.isSafeInteger(data.id)) return;
  queue = queue
    .then(() => removeBackground(data))
    .catch((error) => {
      self.postMessage({
        id: data.id,
        error:
          error instanceof Error ? error.message : '去背景处理失败，请重试',
      });
    });
};
