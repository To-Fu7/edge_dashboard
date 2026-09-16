import { PYTHON_COUNTING_DIR, COMPOSE_FILE, TRITON_BUILDER_SERVICE_NAME, checkHostMountConfig, syncTritonServices } from '@/lib/compose';
import { streamSteps, streamResponse } from '@/lib/buildStream';

export const dynamic = 'force-dynamic';

// Static route — shadows app/api/triton/[action]/route.ts for this exact path
// so the (potentially minutes-long) TensorRT engine build can stream its log
// instead of the dynamic route's blocking exec + single JSON response.
export async function POST(request: Request) {
  const mountError = checkHostMountConfig();
  if (mountError) return new Response(`error: ${mountError}`, { status: 400 });

  // Rewrite the triton-model-builder compose entry with the current
  // HOST_PYTHON_COUNTING_DIR before running it — the checked-in
  // docker-compose.yml ships relative "./tools" mounts that only resolve
  // correctly inside this container's own filesystem, not on the HOST
  // dockerd actually running the sibling container.
  syncTritonServices();

  let force = false;
  try {
    const body = await request.json();
    force = Boolean(body?.force);
  } catch { /* no body */ }

  const stream = streamSteps([
    {
      label: force ? 'Build TensorRT engines (force rebuild)' : 'Build TensorRT engines',
      command: {
        cmd: 'docker',
        args: [
          'compose', '-f', COMPOSE_FILE,
          '--profile', 'build', 'run', '--rm',
          ...(force ? ['-e', 'FORCE_BUILD=1'] : []),
          TRITON_BUILDER_SERVICE_NAME,
        ],
        cwd: PYTHON_COUNTING_DIR,
      },
    },
  ]);

  return streamResponse(stream);
}
