import {
  blobToImg,
  blobToText,
  builtinDecode,
  sniffMimeType,
  canDecodeImageType,
  abortable,
  assertSignal,
  drawableToProcessingImageData,
} from './index';
import type { ImageMimeTypes, ProcessingImageData } from './index';
import { encoderMap } from '../feature-meta';
import type { EncoderState } from '../feature-meta';
import type WorkerBridge from '../worker-bridge';
import { defaultOptions as defaultResizeOptions } from 'features/processors/resize/shared/meta';
import type { WorkerResizeOptions } from 'features/processors/resize/shared/meta';
import {
  defaultBatchResizeOptions,
  getBatchResizeDimensions,
  isValidBatchResize,
} from '../Batch/resize';
import type { BatchResizeOptions } from '../Batch/resize';
import { removeBackground } from '../background-removal';
import { ensureTransparentEncoder } from '../background-removal/formats';

export async function decodeImage(
  signal: AbortSignal,
  blob: Blob,
  workerBridge: WorkerBridge,
): Promise<ProcessingImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));

  try {
    if (!canDecode) {
      let data: ImageData | undefined;

      if (mimeType === 'image/avif') {
        data = await workerBridge.avifDecode(signal, blob);
      }
      if (mimeType === 'image/webp') {
        data = await workerBridge.webpDecode(signal, blob);
      }
      if (mimeType === 'image/jxl') {
        data = await workerBridge.jxlDecode(signal, blob);
      }
      if (mimeType === 'image/webp2') {
        data = await workerBridge.wp2Decode(signal, blob);
      }
      if (mimeType === 'image/qoi') {
        data = await workerBridge.qoiDecode(signal, blob);
      }

      if (data) {
        return {
          data,
          sourceWidth: data.width,
          sourceHeight: data.height,
          downscaled: false,
        };
      }
    }
    // Otherwise fall through and try built-in decoding for a laugh.
    return await builtinDecode(signal, blob);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (isImageMemoryError(err)) throw err;
    console.log(err);
    throw Error('无法解码图片');
  }
}

function isImageMemoryError(err: unknown): boolean {
  const details =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /DataCloneError|out of memory|cannot be cloned/i.test(details);
}

export function imageErrorMessage(prefix: string, err: unknown): string {
  if (isImageMemoryError(err)) {
    return '图片处理所需内存仍超出浏览器限制，请关闭其他页面后重试，或使用更小分辨率的图片。';
  }

  return `${prefix}：${err}`;
}

export async function compressImage(
  signal: AbortSignal,
  image: ImageData,
  encodeData: EncoderState,
  sourceFilename: string,
  workerBridge: WorkerBridge,
): Promise<File> {
  assertSignal(signal);

  const encoder = encoderMap[encodeData.type];
  const compressedData = await encoder.encode(
    signal,
    workerBridge,
    image,
    // The type of encodeData.options is enforced via the previous line
    encodeData.options as any,
  );

  // This type ensures the image mimetype is consistent with our mimetype sniffer
  const type: ImageMimeTypes = encoder.meta.mimeType;

  return new File(
    [compressedData],
    `${sourceFilename.replace(/\.[^.]*$/, '') || sourceFilename}.${
      encoder.meta.extension
    }`,
    { type },
  );
}

export async function processSvg(
  signal: AbortSignal,
  blob: Blob,
): Promise<HTMLImageElement> {
  assertSignal(signal);
  // Firefox throws if you try to draw an SVG to canvas that doesn't have width/height.
  // In Chrome it loads, but drawImage behaves weirdly.
  // This function sets width/height if it isn't already set.
  const parser = new DOMParser();
  const text = await abortable(signal, blobToText(blob));
  const document = parser.parseFromString(text, 'image/svg+xml');
  const svg = document.documentElement!;

  if (svg.hasAttribute('width') && svg.hasAttribute('height')) {
    return blobToImg(blob);
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw Error('SVG 必须包含 width/height 或 viewBox');

  const viewboxParts = viewBox.split(/\s+/);
  svg.setAttribute('width', viewboxParts[2]);
  svg.setAttribute('height', viewboxParts[3]);

  const serializer = new XMLSerializer();
  const newSource = serializer.serializeToString(document);
  return abortable(
    signal,
    blobToImg(new Blob([newSource], { type: 'image/svg+xml' })),
  );
}

export async function compressFile(
  signal: AbortSignal,
  file: File,
  encoderState: EncoderState,
  bridge: WorkerBridge,
  resizeOptions: BatchResizeOptions = defaultBatchResizeOptions,
  backgroundRemoval: boolean = false,
  onProgress?: (phase: 'loading' | 'processing') => void,
): Promise<{ file: File; warning?: string; width: number; height: number }> {
  assertSignal(signal);
  if (!isValidBatchResize(resizeOptions)) {
    throw new Error('调整尺寸参数无效');
  }
  const decoded = file.type.startsWith('image/svg+xml')
    ? drawableToProcessingImageData(await processSvg(signal, file))
    : await decodeImage(signal, file, bridge);
  let image = decoded.data;

  if (resizeOptions.enabled) {
    const target = getBatchResizeDimensions(
      decoded.sourceWidth,
      decoded.sourceHeight,
      resizeOptions,
    );
    const scale = Math.min(
      1,
      image.width / target.width,
      image.height / target.height,
    );
    const width = Math.max(1, Math.floor(target.width * scale));
    const height = Math.max(1, Math.floor(target.height * scale));

    if (width !== image.width || height !== image.height) {
      image = await bridge.resize(signal, image, {
        ...(defaultResizeOptions as WorkerResizeOptions),
        width,
        height,
        method: 'lanczos3',
        fitMethod: 'stretch',
      });
    }
  }

  if (backgroundRemoval) {
    image = await removeBackground(signal, image, onProgress);
  }

  const output = await compressImage(
    signal,
    image,
    backgroundRemoval ? ensureTransparentEncoder(encoderState) : encoderState,
    file.name,
    bridge,
  );
  assertSignal(signal);

  return {
    file: output,
    width: image.width,
    height: image.height,
    warning: decoded.downscaled
      ? `图片分辨率过大，已从 ${decoded.sourceWidth}×${decoded.sourceHeight} 自动缩小到 ${decoded.data.width}×${decoded.data.height}，以避免内存不足。`
      : undefined,
  };
}
