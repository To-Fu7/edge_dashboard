import { TRITON_CONTAINER_NAME } from '@/lib/compose';
import { getContainerLogStream, demuxDockerStream } from '@/lib/docker';

export const dynamic = 'force-dynamic';

// Live-tails the Triton container's logs (stdout+stderr) straight into the
// dashboard, equivalent to `docker logs -f triton-inference-server` without
// needing SSH. The docker log stream only stops when destroy()'d — tied here
// to the request's AbortSignal, which fires when the browser closes the
// connection (tab closed, "Stop" clicked, panel unmounted).
export async function GET(request: Request) {
  const tail = Number(new URL(request.url).searchParams.get('tail')) || 200;

  let dockerStream: NodeJS.ReadableStream;
  try {
    dockerStream = await getContainerLogStream(TRITON_CONTAINER_NAME, tail);
  } catch (e) {
    return new Response(`error: could not open logs for ${TRITON_CONTAINER_NAME}: ${e}`, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if ('destroy' in dockerStream && typeof dockerStream.destroy === 'function') {
          dockerStream.destroy();
        }
        try { controller.close(); } catch { /* already closed */ }
      };

      demuxDockerStream(dockerStream, (text) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ }
      });
      dockerStream.on('end', close);
      dockerStream.on('error', close);
      request.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
