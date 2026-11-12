import { Zip, ZipPassThrough } from 'fflate';

const chunkSize = 1024 * 1024;
const zip32Limit = 0xffffffff;

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('已取消打包', 'AbortError');
}

function uniqueName(filename: string, usedNames: Set<string>): string {
  const safeName =
    filename
      .normalize('NFC')
      .replace(/[\\/\u0000-\u001f:*?"<>|]/g, '_')
      .replace(/[. ]+$/g, '') || 'image';
  const dot = safeName.lastIndexOf('.');
  const base = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : '';
  let name = safeName;
  let suffix = 2;

  while (usedNames.has(name.toLowerCase())) {
    name = `${base} (${suffix++})${extension}`;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

export async function createZip(
  files: File[],
  signal: AbortSignal,
): Promise<Blob> {
  checkAbort(signal);
  if (!files.length) throw new Error('没有可下载的图片');
  if (files.length >= 0xffff) throw new Error('图片数量过多，请分批下载');

  const usedNames = new Set<string>();
  const encoder = new TextEncoder();
  let archiveSize = 22;
  const entries = files.map((file) => {
    const name = uniqueName(file.name, usedNames);
    const nameSize = encoder.encode(name).length;
    if (nameSize > 0xffff) throw new Error('图片文件名过长');

    // Local header, data descriptor and central header, plus both filenames.
    archiveSize += file.size + 92 + nameSize * 2;
    if (file.size >= zip32Limit || archiveSize >= zip32Limit) {
      throw new Error('压缩包超过 4 GB，请分批下载');
    }
    return { file, name };
  });

  const parts: Blob[] = [];
  const zip = new Zip((error, data) => {
    if (error) throw error;
    parts.push(new Blob([data]));
  });

  try {
    for (const { file, name } of entries) {
      checkAbort(signal);
      const entry = new ZipPassThrough(name);
      zip.add(entry);

      for (let offset = 0; offset < file.size; offset += chunkSize) {
        checkAbort(signal);
        const data = await file.slice(offset, offset + chunkSize).arrayBuffer();
        checkAbort(signal);
        entry.push(new Uint8Array(data));
      }
      entry.push(new Uint8Array(0), true);
      // Allow the page to render and handle cancellation between files.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    checkAbort(signal);
    zip.end();
    return new Blob(parts, { type: 'application/zip' });
  } finally {
    zip.terminate();
    parts.length = 0;
  }
}
