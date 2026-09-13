/* Model weights only. Chunked CacheStorage avoids large single-Response put failures. */
(function (root) {
  'use strict';
  function createModelCache(storage, baseURL, chunkBytes = 8 * 1024 * 1024) {
    const bucket = 'transformers-voxscribe-chunks-v1';
    const url = request => typeof request === 'string' ? request : request.url;
    const part = (id, index) => new URL('./__model_cache__/' + id + '/' + index, baseURL).href;
    async function manifest(cache, key) {
      const response = await cache.match(key);
      if (!response) return null;
      try { return await response.json(); } catch (_) { return null; }
    }
    return {
      async match(request) {
        const key = url(request), cache = await storage.open(bucket);
        const info = await manifest(cache, key);
        if (!info || info.version !== 1) return (await storage.open('transformers-cache')).match(key);
        if (!Number.isInteger(info.count) || info.count < 1 || info.count > 4096 || !Number.isFinite(info.size)) return undefined;
        // Resolve all references before exposing the stream; never return a partial model.
        const responses = [];
        for (let i = 0; i < info.count; i++) {
          const response = await cache.match(part(info.id, i));
          if (!response) return undefined;
          responses.push(response);
        }
        let index = 0;
        return new Response(new ReadableStream({
          async pull(controller) {
            try {
              if (index === responses.length) { controller.close(); return; }
              controller.enqueue(new Uint8Array(await responses[index++].arrayBuffer()));
            } catch (e) { controller.error(e); }
          }
        }), { headers: { 'content-type': info.type, 'content-length': String(info.size) } });
      },
      async put(request, response) {
        const key = url(request), cache = await storage.open(bucket), previous = await manifest(cache, key);
        const id = root.crypto.randomUUID();
        const reader = response.body.getReader();
        let count = 0, size = 0, pending = new Uint8Array(chunkBytes), used = 0;
        async function flush() {
          const bytes = pending.slice(0, used);
          await cache.put(part(id, count), new Response(bytes));
          count++; size += used; used = 0;
        }
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < value.length;) {
              const length = Math.min(chunkBytes - used, value.length - offset);
              pending.set(value.subarray(offset, offset + length), used); used += length; offset += length;
              if (used === chunkBytes) await flush();
            }
          }
          if (used || !count) await flush();
          // Publish only after all parts exist. Drop remote compression/range headers.
          await cache.put(key, new Response(JSON.stringify({ version: 1, id, count, size,
            type: response.headers.get('content-type') || 'application/octet-stream' }), { headers: { 'content-type': 'application/json' } }));
        } catch (e) {
          await reader.cancel().catch(() => {});
          for (let i = 0; i <= count; i++) await cache.delete(part(id, i)).catch(() => {});
          throw e;
        } finally { reader.releaseLock(); }
        if (previous?.version === 1) {
          for (let i = 0; i < previous.count; i++) await cache.delete(part(previous.id, i)).catch(() => {});
        }
      }
    };
  }
  root.createVoxModelCache = createModelCache;
  if (typeof module !== 'undefined' && module.exports) module.exports = createModelCache;
})(globalThis);
