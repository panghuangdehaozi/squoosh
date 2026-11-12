import { simd } from 'wasm-feature-detect';
import webpDataUrl from 'data-url:./tiny.webp';
import avifDataUrl from 'data-url:./tiny.avif';

// Give TypeScript the correct global.
declare var self: ServiceWorkerGlobalScope;

function subtractSets<T extends any>(set1: Set<T>, set2: Set<T>): Set<T> {
  const result = new Set(set1);
  for (const item of set2) result.delete(item);
  return result;
}

// Initial app stuff
import * as initialApp from 'entry-data:client/initial-app';
import swUrl from 'service-worker:sw';
import * as compress from 'entry-data:client/lazy-app/Compress';
import * as batch from 'entry-data:client/lazy-app/Batch';
import * as swBridge from 'entry-data:client/lazy-app/sw-bridge';
import * as blobAnim from 'entry-data:shared/prerendered-app/Intro/blob-anim';

// The processors and codecs
// Simple stuff everyone gets:
import * as featuresWorker from 'entry-data:../features-worker';

// Decoders (some are feature detected)
import * as avifDec from 'entry-data:codecs/avif/dec/avif_dec';
import * as webpDec from 'entry-data:codecs/webp/dec/webp_dec';

// OXI
import * as oxiMt from 'entry-data:codecs/oxipng/pkg-parallel/squoosh_oxipng';
import * as oxi from 'entry-data:codecs/oxipng/pkg/squoosh_oxipng';

// WebP
import * as webpEncSimd from 'entry-data:codecs/webp/enc/webp_enc_simd';
import * as webpEnc from 'entry-data:codecs/webp/enc/webp_enc';

let initialJs = new Set([
  compress.main,
  ...compress.deps,
  batch.main,
  ...batch.deps,
  swBridge.main,
  ...swBridge.deps,
  blobAnim.main,
  ...blobAnim.deps,
]);
initialJs = subtractSets(
  initialJs,
  new Set([
    initialApp.main,
    ...initialApp.deps.filter((item) =>
      // Exclude JS deps that have been inlined:
      item.endsWith('.js'),
    ),
    // Exclude features Worker itself - it's referenced from the main app,
    // but is meant to be cached lazily.
    featuresWorker.main,
    // Also exclude Service Worker itself (we're inside right now).
    swUrl,
  ]),
);

export const initial = ['/', ...initialJs];

export const theRest = (async () => {
  const [supportsSimd, supportsWebP, supportsAvif] = await Promise.all([
    simd(),
    ...[webpDataUrl, avifDataUrl].map(async (dataUrl) => {
      if (!self.createImageBitmap) return false;
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      return createImageBitmap(blob).then(
        () => true,
        () => false,
      );
    }),
  ]);

  const items: string[] = [];

  function addWithDeps(entry: typeof import('entry-data:*')) {
    items.push(entry.main, ...entry.deps);
  }

  addWithDeps(featuresWorker);

  if (!supportsAvif) addWithDeps(avifDec);
  if (!supportsWebP) addWithDeps(webpDec);

  // OXI
  // Dedicated workers can use nested workers even when the service worker cannot.
  // Cache both PNG paths so transparent exports also work offline.
  addWithDeps(oxiMt);
  addWithDeps(oxi);

  // WebP
  if (supportsSimd) {
    addWithDeps(webpEncSimd);
  } else {
    addWithDeps(webpEnc);
  }

  return [...new Set(items)];
})();
