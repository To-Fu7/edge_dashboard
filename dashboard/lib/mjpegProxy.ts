// Proxies a container's raw multipart/x-mixed-replace MJPEG endpoint straight
// through to the browser as a Node ReadableStream. Shared by the live camera
// view (/api/stream/[code]) and the Model Test live preview
// (/api/model-test/stream) — same protocol, same "wait for the first frame,
// then just pipe" approach, so a viewer that hasn't produced a frame yet
// (still connecting to Triton, or waiting for optimization_profile warm-up)
// times out cleanly instead of hanging the request forever.
import { request as httpRequest } from 'node:http';

export function proxyAnnotatedStream(host: string, port: number, path = '/'): Promise<ReadableStream | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val: ReadableStream | null) => { if (!settled) { settled = true; resolve(val); } };

    const req = httpRequest({ host, port, path, method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); settle(null); return; }

      res.pause();

      // Wait up to 10s for the first frame — if the source hasn't encoded one
      // yet, the caller should fall back to something else (or just report
      // "not ready" rather than hang the browser's <img> tag indefinitely).
      const firstByteTimer = setTimeout(() => { res.destroy(); settle(null); }, 10000);

      res.once('data', (firstChunk: Buffer) => {
        clearTimeout(firstByteTimer);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(firstChunk);
            res.on('data', (chunk: Buffer) => {
              try { controller.enqueue(chunk); } catch { res.destroy(); }
            });
            res.on('end', () => { try { controller.close(); } catch { /* already closed */ } });
            res.on('error', () => { try { controller.close(); } catch { /* already closed */ } });
            res.resume();
          },
          cancel() { res.destroy(); },
        });
        settle(stream);
      });

      res.on('error', () => settle(null));
      res.resume();
    });

    req.setTimeout(3000, () => { req.destroy(); settle(null); });
    req.on('error', () => settle(null));
    req.end();
  });
}
