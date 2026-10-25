// Помощники для проверки сжатия PDF в браузере: шумные картинки и вызов compressPdf.

/** Шумные JPEG разного размера в браузере: [{ b64, w, h }] (детерминированный «шум», чтобы размеры не плавали). */
export function noisyJpegs(page, specs) {
  return page.evaluate(async specs => {
    const out = [];
    for (const [i, { w, h, q = 0.92, noise = 255, smooth = false }] of specs.entries()) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const d = ctx.createImageData(w, h);
      let s = 12345 + i * 777;
      for (let p = 0; p < d.data.length; p += 4) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        const x = (p / 4) % w, y = Math.floor(p / 4 / w);
        const base = smooth ? [x * 255 / w, y * 255 / h, (x + y) * 255 / (w + h)] : [128, 128, 128];
        d.data[p] = base[0] + ((s & 255) - 128) * noise / 255;
        d.data[p + 1] = base[1] + (((s >>> 8) & 255) - 128) * noise / 255;
        d.data[p + 2] = base[2] + (((s >>> 16) & 255) - 128) * noise / 255;
        d.data[p + 3] = 255;
      }
      ctx.putImageData(d, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      const u = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let k = 0; k < u.length; k += 8192) bin += String.fromCharCode(...u.subarray(k, k + 8192));
      out.push({ b64: btoa(bin), w, h });
    }
    return out;
  }, specs);
}

/** Запускает compressPdf в браузере; возвращает результат и байты. onProgress собирается в stages. */
export async function compressInBrowser(page, bytes, target) {
  const r = await page.evaluate(async ([b64, target]) => {
    const { compressPdf } = await import('./pdftools.js');
    const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const stages = [];
    const t0 = performance.now();
    const res = await compressPdf(u, target, { onProgress: p => stages.push(p) });
    const out = new Uint8Array(await res.blob.arrayBuffer());
    let bin = '';
    for (let k = 0; k < out.length; k += 8192) bin += String.fromCharCode(...out.subarray(k, k + 8192));
    return { fits: res.fits, level: res.level, original: res.original, pages: res.pages, size: res.blob.size, b64: btoa(bin), stages, ms: performance.now() - t0 };
  }, [Buffer.from(bytes).toString('base64'), target]);
  return { ...r, bytes: new Uint8Array(Buffer.from(r.b64, 'base64')) };
}
