import { PYTHON_COUNTING_DIR, HOST_PYTHON_COUNTING_DIR } from '@/lib/compose';
import { streamSteps, streamResponse } from '@/lib/buildStream';

export const dynamic = 'force-dynamic';

// Only a bare filename (letters/digits/._-), no path separators — this is
// interpolated into a docker run arg and a container-internal /work path.
const SAFE_WEIGHTS_NAME = /^[a-zA-Z0-9._-]+\.pt$/;

export async function POST(request: Request) {
  let body: { weights?: string; imgsz?: number } = {};
  try {
    body = await request.json();
  } catch { /* no body */ }

  const weights = body.weights;
  const imgsz = body.imgsz && Number.isFinite(body.imgsz) ? Math.trunc(body.imgsz) : 640;

  if (!weights || !SAFE_WEIGHTS_NAME.test(weights)) {
    return new Response('error: "weights" must be a bare .pt filename (e.g. yolo26m.pt)', { status: 400 });
  }

  const stream = streamSteps([
    {
      label: 'Build ONNX export image',
      command: {
        cmd: 'docker',
        args: ['build', '-f', 'tools/Dockerfile.export', '-t', 'yolo-export', 'tools/'],
        cwd: PYTHON_COUNTING_DIR,
      },
    },
    {
      label: `Export ${weights} -> ONNX (imgsz=${imgsz})`,
      command: {
        cmd: 'docker',
        args: [
          'run', '--rm',
          '-v', `${HOST_PYTHON_COUNTING_DIR}:/work`,
          'yolo-export',
          '--weights', `/work/${weights}`,
          '--imgsz', String(imgsz),
          '--out-dir', '/work/models',
        ],
        cwd: PYTHON_COUNTING_DIR,
      },
    },
  ]);

  return streamResponse(stream);
}
