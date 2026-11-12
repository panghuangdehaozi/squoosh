export const backgroundRemovalPath = '/background-removal/v1/';
export const backgroundRemovalCache = 'background-removal-v1';

export const backgroundRemovalAssets = [
  'worker.js',
  'u2netp.onnx',
  'ort.wasm.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
].map((name) => backgroundRemovalPath + name);
