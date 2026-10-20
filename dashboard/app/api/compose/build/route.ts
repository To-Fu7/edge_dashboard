import { PYTHON_COUNTING_DIR } from '@/lib/compose';
import { DEVICE_IMAGE } from '@/lib/device-runtime';
import { streamSteps, streamResponse } from '@/lib/buildStream';

export const dynamic = 'force-dynamic';

// Builds the thin Triton-client camera image (python-counting/dockerfile).
// Streams output live — the build can take minutes and existing camera
// containers must be recreated afterwards to pick up the new image (per-device
// action on the Devices page).
export async function POST() {
  const stream = streamSteps([
    {
      label: `Build camera image (${DEVICE_IMAGE})`,
      command: {
        cmd: 'docker',
        args: ['build', '-t', DEVICE_IMAGE, '-f', 'dockerfile', '.'],
        cwd: PYTHON_COUNTING_DIR,
      },
    },
  ]);

  return streamResponse(stream);
}
