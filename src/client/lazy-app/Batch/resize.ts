export interface BatchResizeOptions {
  enabled: boolean;
  mode: 'bounds' | 'percent';
  width: number;
  height: number;
  percent: number;
}

export const defaultBatchResizeOptions: BatchResizeOptions = {
  enabled: false,
  mode: 'bounds',
  width: 1920,
  height: 1080,
  percent: 50,
};

export function isValidBatchResize(options: BatchResizeOptions): boolean {
  if (!options.enabled) return true;
  if (options.mode === 'percent') {
    return (
      Number.isInteger(options.percent) &&
      options.percent >= 1 &&
      options.percent <= 100
    );
  }
  if (options.mode === 'bounds') {
    return [options.width, options.height].every(
      (dimension) =>
        Number.isInteger(dimension) && dimension >= 1 && dimension <= 32768,
    );
  }
  return false;
}

export function getBatchResizeDimensions(
  width: number,
  height: number,
  options: BatchResizeOptions,
): { width: number; height: number } {
  if (!options.enabled) return { width, height };
  if (!isValidBatchResize(options)) throw new Error('调整尺寸参数无效');

  const scale =
    options.mode === 'percent'
      ? options.percent / 100
      : Math.min(1, options.width / width, options.height / height);

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
