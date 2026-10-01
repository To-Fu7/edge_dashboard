import { proxyAnnotatedStream } from '@/lib/mjpegProxy';
import { RUNNER_NAME, STREAM_PORT } from '@/lib/modelTest';

export const dynamic = 'force-dynamic';

// Live MJPEG preview of a running Model Test — proxies the throwaway
// model-test-runner container's stream (started by /api/model-test/run) by
// container name on the shared "envisions" network, same mechanism the live
// camera view already uses for its own annotated stream.
export async function GET() {
  const stream = await proxyAnnotatedStream(RUNNER_NAME, STREAM_PORT);
  if (!stream) {
    return new Response('model-test-runner is not streaming (no test running yet, or still connecting to Triton)', { status: 503 });
  }
  return new Response(stream, {
    headers: {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
