// Triton + model builder via python-counting/docker-compose.yml.
//
// That compose file is static and tracked in git. Everything that differs per
// machine (Triton image for the hardware mode, GPU runtime, host path) lives in
// python-counting/.env, which this module writes — so `git pull` never
// conflicts with runtime state. Camera containers are not in compose at all:
// see device-runtime.ts.
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { GlobalSettings, HardwareMode } from './types';
import { readSettings } from './settings';

const execAsync = promisify(exec);

export const PYTHON_COUNTING_DIR = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');
// Inside Docker, PYTHON_COUNTING_DIR is the container's own mount (/python-counting);
// the host's dockerd needs the real host path for bind mounts.
export const HOST_PYTHON_COUNTING_DIR = process.env.HOST_PYTHON_COUNTING_DIR || PYTHON_COUNTING_DIR;
export const COMPOSE_FILE = path.join(PYTHON_COUNTING_DIR, 'docker-compose.yml');
const TRITON_ENV_FILE = path.join(PYTHON_COUNTING_DIR, '.env');

export const TRITON_SERVICE_NAME = 'triton';
export const TRITON_BUILDER_SERVICE_NAME = 'triton-model-builder';
export const TRITON_CONTAINER_NAME = 'triton-inference-server';
export const DEFAULT_TRITON_IMAGE_TAG = '24.08';

/** Sanity-checks the host-mount setup before a build spawns sibling containers
 *  that bind-mount HOST_PYTHON_COUNTING_DIR through the host's Docker daemon.
 *  Docker silently creates an empty directory for a missing bind source, so a
 *  wrong path only shows up later as "file not found" for files that exist. */
export function checkHostMountConfig(): string | null {
  if (!fs.existsSync(path.join(PYTHON_COUNTING_DIR, 'tools', 'build_engine.sh'))) {
    return (
      `The dashboard container can't see python-counting/tools/build_engine.sh at ` +
      `PYTHON_COUNTING_DIR=${PYTHON_COUNTING_DIR}. Check the "../python-counting:/python-counting" ` +
      `volume in dashboard/docker-compose.yml is actually mounted.`
    );
  }
  if (!process.env.HOST_PYTHON_COUNTING_DIR) {
    return (
      `HOST_PYTHON_COUNTING_DIR is not set, so containers started through the host's Docker daemon ` +
      `would bind-mount an empty directory. Set HOST_PYTHON_COUNTING_DIR=<absolute host path to ` +
      `python-counting/> in dashboard/.env, then: docker compose up -d --force-recreate dashboard`
    );
  }
  return null;
}

export function tritonImageForMode(hardwareMode: HardwareMode, imageTag: string = DEFAULT_TRITON_IMAGE_TAG): string {
  const suffix = hardwareMode === 'jetson' ? '-py3-igpu' : '-py3';
  return `nvcr.io/nvidia/tritonserver:${imageTag}${suffix}`;
}

export function tritonEnvFor(s: Pick<GlobalSettings, 'hardwareMode' | 'triton'>): Record<string, string> {
  return {
    TRITON_IMAGE: tritonImageForMode(s.hardwareMode, s.triton.imageTag),
    TRITON_RUNTIME: s.hardwareMode === 'cpu' ? 'runc' : 'nvidia',
    TRT_BACKEND: s.hardwareMode === 'cpu' ? 'onnx' : 'trt',
    HOST_PYTHON_COUNTING_DIR,
  };
}

/** Write the per-machine compose values into python-counting/.env, keeping any
 *  other keys someone added there (e.g. QUEUE_DELAY_US). */
export function writeTritonEnv(s: Pick<GlobalSettings, 'hardwareMode' | 'triton'>): void {
  const wanted = tritonEnvFor(s);
  const lines = fs.existsSync(TRITON_ENV_FILE) ? fs.readFileSync(TRITON_ENV_FILE, 'utf-8').split('\n') : [];
  const kept = lines.filter(l => l.trim() && !Object.keys(wanted).some(k => l.startsWith(`${k}=`)));
  const header = '# Written by the Edge dashboard (Settings → Hardware Mode / Triton). Not in git.';
  const body = [header, ...kept.filter(l => l !== header), ...Object.entries(wanted).map(([k, v]) => `${k}=${v}`)];
  fs.writeFileSync(TRITON_ENV_FILE, body.join('\n') + '\n', 'utf-8');
}

export async function syncTritonEnv(): Promise<void> {
  writeTritonEnv(await readSettings());
}

const COMPOSE_CMD = `docker compose -f "${COMPOSE_FILE}"`;

function failOnComposeError(stderr: string): void {
  if (stderr && /error/i.test(stderr) && !/pulling|creating|starting|created|started|recreate/i.test(stderr)) {
    throw new Error(stderr.trim());
  }
}

export async function composeUpTriton(): Promise<void> {
  await syncTritonEnv();
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d ${TRITON_SERVICE_NAME}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 300000 }, // image pull can take a while
  );
  failOnComposeError(stderr);
}

export async function composeStopTriton(): Promise<void> {
  await execAsync(`${COMPOSE_CMD} stop ${TRITON_SERVICE_NAME}`, { cwd: PYTHON_COUNTING_DIR, timeout: 60000 });
}

export async function composeRestartTriton(): Promise<void> {
  await composeStopTriton();
  await composeUpTriton();
}

export async function imageExists(imageName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker image inspect ${imageName} --format "{{.Id}}"`, { timeout: 10000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
