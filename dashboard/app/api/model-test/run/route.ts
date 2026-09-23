import { HOST_PYTHON_COUNTING_DIR, PYTHON_COUNTING_DIR, imageExists, checkHostMountConfig } from '@/lib/compose';
import { streamSteps } from '@/lib/buildStream';
import { CAMERA_IMAGE, RUNNER_NAME, STREAM_PORT } from '@/lib/modelTest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// Only a bare filename, no path separators — this becomes a docker run arg
// and a container-internal /app/test-videos/<name> path.
const SAFE_VIDEO_NAME = /^[a-zA-Z0-9._-]+\.(mp4|avi|mkv)$/;
const SAFE_MODEL_NAME = /^[a-zA-Z0-9._-]+$/;

export async function POST(request: Request) {
  const mountError = checkHostMountConfig();
  if (mountError) return new Response(`error: ${mountError}`, { status: 400 });

  let body: {
    video?: string;
    model?: string;
    conf?: number;
    resolution?: string; // "W,H"
    crop?: string;       // "x1,y1,x2,y2"
  } = {};
  try {
    body = await request.json();
  } catch { /* no body */ }

  const { video, model } = body;
  if (!video || !SAFE_VIDEO_NAME.test(video)) {
    return new Response('error: "video" must be a bare filename from test-videos/ (e.g. lobby.mp4)', { status: 400 });
  }
  if (!model || !SAFE_MODEL_NAME.test(model)) {
    return new Response('error: "model" (Triton model repository name) is required', { status: 400 });
  }
  if (!fs.existsSync(path.join(PYTHON_COUNTING_DIR, 'test-videos', video))) {
    return new Response(`error: test-videos/${video} not found on the dashboard's own filesystem`, { status: 400 });
  }

  const hasImage = await imageExists(CAMERA_IMAGE);
  if (!hasImage) {
    return new Response(
      `error: camera image ${CAMERA_IMAGE} doesn't exist yet — build it first from the Build & Inference page (/inference).`,
      { status: 400 },
    );
  }

  const conf = body.conf && Number.isFinite(body.conf) ? body.conf : 0.3;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = `modeltest_${stamp}.mp4`;

  // Best-effort: clear a leftover container from a previous run that crashed
  // or was killed without --rm cleaning up (e.g. dashboard restarted mid-test)
  // — `docker run --name` fails outright on a name collision otherwise.
  try { execSync(`docker rm -f ${RUNNER_NAME}`, { stdio: 'ignore' }); } catch { /* nothing to remove */ }

  const args = [
    'run', '--rm',
    '--name', RUNNER_NAME,
    '--network', 'envisions',
    '-v', `${HOST_PYTHON_COUNTING_DIR}:/app`,
    '-w', '/app',
    CAMERA_IMAGE,
    'python3', 'tools/record_camera_test.py',
    '--rtsp', `/app/test-videos/${video}`,
    '--triton-url', 'triton:8001',
    '--model', model,
    '--conf', String(conf),
    '--tag', 'modeltest',
    '--out', `/app/recordings/${outputFile}`,
    '--stream-port', String(STREAM_PORT),
  ];
  if (body.resolution) args.push('--resolution', body.resolution);
  if (body.crop) args.push('--crop', body.crop);

  const stream = streamSteps([
    {
      label: `Test ${model} on ${video}`,
      command: { cmd: 'docker', args, cwd: PYTHON_COUNTING_DIR },
    },
  ]);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Output-File': outputFile,
    },
  });
}
