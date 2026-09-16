import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { HardwareMode } from './types';
import { readSettings } from './settings';

const execAsync = promisify(exec);

export const PYTHON_COUNTING_DIR = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');
// When running inside Docker, PYTHON_COUNTING_DIR is a container-internal path (/python-counting).
// The Docker daemon needs the actual HOST path to resolve relative volume mounts (.:/app).
// HOST_PYTHON_COUNTING_DIR must be set to the host filesystem path of python-counting/.
export const HOST_PYTHON_COUNTING_DIR = process.env.HOST_PYTHON_COUNTING_DIR || PYTHON_COUNTING_DIR;
export const COMPOSE_FILE = path.join(PYTHON_COUNTING_DIR, 'docker-compose.yml');

/** Sanity-checks the host-mount setup before a build spawns `docker` commands
 *  that bind-mount HOST_PYTHON_COUNTING_DIR into a sibling container (via the
 *  host's Docker daemon, reached through the mounted docker.sock). Docker
 *  silently creates an empty directory for a bind-mount source that doesn't
 *  exist on the host, so a misconfigured/missing HOST_PYTHON_COUNTING_DIR
 *  doesn't fail until the *sibling* container starts — surfacing as a cryptic
 *  "file not found" for a script that IS there, just not on the mounted side.
 *  Returns an actionable error string, or null if the setup looks correct. */
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
      `HOST_PYTHON_COUNTING_DIR is not set. The dashboard container can read its own python-counting/ ` +
      `files fine, but the commands below run via the HOST's Docker daemon (through the mounted ` +
      `docker.sock), which needs the HOST filesystem path of python-counting/ to resolve -v mounts for ` +
      `triton-model-builder / yolo-export. Without it, Docker silently bind-mounts an empty directory ` +
      `and the build fails with "file not found" for scripts that do exist. ` +
      `Fix: set HOST_PYTHON_COUNTING_DIR=<absolute host path to python-counting/> in dashboard/.env, ` +
      `then recreate the dashboard container (docker compose up -d --force-recreate dashboard).`
    );
  }
  return null;
}

interface ComposeService {
  image?: string;
  container_name?: string;
  restart?: string;
  runtime?: string;
  command?: string;
  entrypoint?: string[];
  profiles?: string[];
  ports?: string[];
  depends_on?: string[];
  env_file?: string[];
  volumes?: string[];
  devices?: string[];
  extra_hosts?: string[];
  networks?: string[];
  shm_size?: string;
  environment?: string[];
  deploy?: unknown;
}

export const TRITON_SERVICE_NAME = 'triton';
export const TRITON_BUILDER_SERVICE_NAME = 'triton-model-builder';
export const TRITON_CONTAINER_NAME = 'triton-inference-server';
export const DEFAULT_TRITON_IMAGE_TAG = '24.08';

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readCompose(): ComposeFile {
  if (!fs.existsSync(COMPOSE_FILE)) {
    return {
      services: {},
      networks: { envisions: { driver: 'bridge', name: 'envisions' } },
    };
  }
  const content = fs.readFileSync(COMPOSE_FILE, 'utf-8');
  return (yaml.load(content) as ComposeFile) || { services: {} };
}

export function writeCompose(compose: ComposeFile): void {
  const content = yaml.dump(compose, { lineWidth: 120, quotingType: '"' });
  fs.writeFileSync(COMPOSE_FILE, content, 'utf-8');
}

export function getServiceName(deviceCode: string): string {
  return `services-python-${deviceCode.toLowerCase().replace(/_/g, '-')}`;
}

export function getContainerName(deviceCode: string): string {
  return `services-python-${deviceCode.toLowerCase().replace(/_/g, '-')}`;
}

export function listServices(): { serviceName: string; deviceCode: string; envFile: string }[] {
  const compose = readCompose();
  const results: { serviceName: string; deviceCode: string; envFile: string }[] = [];

  for (const [name, svc] of Object.entries(compose.services || {})) {
    const envFiles = svc.env_file || [];
    for (const ef of envFiles) {
      if (ef.startsWith('.env_')) {
        const code = ef.replace('.env_', '');
        results.push({ serviceName: name, deviceCode: code, envFile: ef });
        break;
      }
    }
  }

  return results;
}

// Camera containers are thin Triton clients since the Triton migration: CPU-only
// in every hardware mode. GPU access (runtime/devices) now lives on the triton
// service, which the hardware mode configures instead.
function buildServiceDefinition(deviceCode: string, _hardwareMode: HardwareMode): ComposeService {
  const containerName = getContainerName(deviceCode);
  return {
    image: 'python-counting-services-python-1:latest',
    container_name: containerName,
    restart: 'unless-stopped',
    env_file: [`.env_${deviceCode}`],
    extra_hosts: ['host.docker.internal:host-gateway'],
    networks: ['envisions'],
    depends_on: [TRITON_SERVICE_NAME],
    volumes: [`${HOST_PYTHON_COUNTING_DIR}:/app`],
    environment: [`TRITON_URL=${TRITON_SERVICE_NAME}:8001`],
  };
}

export function tritonImageForMode(hardwareMode: HardwareMode, imageTag: string = DEFAULT_TRITON_IMAGE_TAG): string {
  const suffix = hardwareMode === 'jetson' ? '-py3-igpu' : '-py3';
  return `nvcr.io/nvidia/tritonserver:${imageTag}${suffix}`;
}

export function buildTritonServiceDefinition(
  hardwareMode: HardwareMode,
  imageTag: string = DEFAULT_TRITON_IMAGE_TAG
): ComposeService {
  const base: ComposeService = {
    image: tritonImageForMode(hardwareMode, imageTag),
    container_name: TRITON_CONTAINER_NAME,
    restart: 'unless-stopped',
    command: 'tritonserver --model-repository=/models --strict-model-config=false',
    shm_size: '1gb',
    ports: ['8000:8000', '8001:8001', '8002:8002'],
    volumes: [`${HOST_PYTHON_COUNTING_DIR}/models:/models`],
    networks: ['envisions'],
  };

  // cpu mode: standard image, onnxruntime-CPU models only — no GPU runtime
  if (hardwareMode === 'cpu') return base;

  return {
    ...base,
    runtime: 'nvidia',
    environment: [
      'NVIDIA_VISIBLE_DEVICES=all',
      'NVIDIA_DRIVER_CAPABILITIES=all',
    ],
  };
}

export function buildModelBuilderServiceDefinition(
  hardwareMode: HardwareMode,
  imageTag: string = DEFAULT_TRITON_IMAGE_TAG
): ComposeService {
  const base: ComposeService = {
    image: tritonImageForMode(hardwareMode, imageTag),
    container_name: TRITON_BUILDER_SERVICE_NAME,
    profiles: ['build'],
    entrypoint: ['/bin/bash', '/tools/build_engine.sh'],
    volumes: [
      `${HOST_PYTHON_COUNTING_DIR}/models:/models`,
      `${HOST_PYTHON_COUNTING_DIR}/tools:/tools:ro`,
    ],
  };

  if (hardwareMode === 'cpu') {
    return { ...base, environment: ['TRT_BACKEND=onnx'] };
  }

  return {
    ...base,
    runtime: 'nvidia',
    environment: [
      'NVIDIA_VISIBLE_DEVICES=all',
      'NVIDIA_DRIVER_CAPABILITIES=all',
    ],
  };
}

function ensureTritonServices(compose: ComposeFile, hardwareMode: HardwareMode, imageTag?: string): void {
  compose.services = compose.services || {};
  compose.services[TRITON_SERVICE_NAME] = buildTritonServiceDefinition(hardwareMode, imageTag);
  compose.services[TRITON_BUILDER_SERVICE_NAME] = buildModelBuilderServiceDefinition(hardwareMode, imageTag);
}

/** Patches just the volume mounts of the existing triton / triton-model-builder
 *  compose entries to use the resolved HOST_PYTHON_COUNTING_DIR, leaving image/
 *  runtime/environment untouched. A freshly-cloned repo's committed
 *  docker-compose.yml ships relative "./tools"/"./models" mounts — the `docker`
 *  CLI (running inside the dashboard container) resolves those against the
 *  container's own /python-counting path, not the host path the sibling HOST
 *  dockerd actually needs to bind-mount from. Deliberately does NOT regenerate
 *  the whole service (that's ensureTritonServices, used by addService /
 *  applyHardwareModeToAll from Settings) — doing so here would silently swap
 *  the image to whatever hardwareMode defaults to (jetson) if settings.json
 *  doesn't exist yet, which would be wrong on a plain x86/server GPU box that
 *  never touched the hardware-mode picker. If a service is missing entirely,
 *  it's created from current settings as a bootstrap (only path this can hit
 *  is a docker-compose.yml with no triton services at all yet). */
export function syncTritonServices(): void {
  const compose = readCompose();
  compose.services = compose.services || {};

  if (!compose.services[TRITON_SERVICE_NAME] || !compose.services[TRITON_BUILDER_SERVICE_NAME]) {
    const settings = readSettings();
    ensureTritonServices(compose, settings.hardwareMode, settings.triton.imageTag);
  } else {
    compose.services[TRITON_SERVICE_NAME].volumes = [`${HOST_PYTHON_COUNTING_DIR}/models:/models`];
    compose.services[TRITON_BUILDER_SERVICE_NAME].volumes = [
      `${HOST_PYTHON_COUNTING_DIR}/models:/models`,
      `${HOST_PYTHON_COUNTING_DIR}/tools:/tools:ro`,
    ];
  }

  // Without an explicit `name:`, Compose prefixes the network with the project
  // name (e.g. "python-counting_envisions"), which never matches the dashboard
  // compose file's own "envisions" network — the two projects end up on
  // different bridge networks and can't resolve each other's container names
  // at all, however correctly everything else is configured.
  compose.networks = compose.networks || {};
  compose.networks.envisions = { ...(compose.networks.envisions as object), driver: 'bridge', name: 'envisions' };
  writeCompose(compose);
}

export function addService(deviceCode: string, hardwareMode: HardwareMode = 'jetson', tritonImageTag?: string): void {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);

  compose.services = compose.services || {};
  compose.services[serviceName] = buildServiceDefinition(deviceCode, hardwareMode);
  ensureTritonServices(compose, hardwareMode, tritonImageTag);

  // See syncTritonServices() — must be an explicit name or Compose prefixes
  // it per-project, splitting the dashboard and python-counting containers
  // onto two different networks that can't resolve each other.
  compose.networks = compose.networks || {};
  compose.networks.envisions = { ...(compose.networks.envisions as object), driver: 'bridge', name: 'envisions' };

  writeCompose(compose);
}

export function applyHardwareModeToAll(hardwareMode: HardwareMode, tritonImageTag?: string): void {
  const compose = readCompose();
  if (!compose.services) return;

  for (const [serviceName, svc] of Object.entries(compose.services)) {
    const envFiles = svc.env_file || [];
    const envFile = envFiles.find(ef => ef.startsWith('.env_'));
    if (!envFile) continue;
    const deviceCode = envFile.replace('.env_', '');
    compose.services[serviceName] = buildServiceDefinition(deviceCode, hardwareMode);
  }
  ensureTritonServices(compose, hardwareMode, tritonImageTag);

  // See syncTritonServices() — must be an explicit name or Compose prefixes
  // it per-project, splitting the dashboard and python-counting containers
  // onto two different networks that can't resolve each other.
  compose.networks = compose.networks || {};
  compose.networks.envisions = { ...(compose.networks.envisions as object), driver: 'bridge', name: 'envisions' };

  writeCompose(compose);
}

export function removeService(deviceCode: string): void {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);

  if (compose.services) {
    delete compose.services[serviceName];
  }

  writeCompose(compose);
}

export function serviceExists(deviceCode: string): boolean {
  const compose = readCompose();
  const serviceName = getServiceName(deviceCode);
  return !!compose.services?.[serviceName];
}

const COMPOSE_CMD = `docker compose -f "${COMPOSE_FILE}"`;

export async function composeUp(deviceCode: string): Promise<void> {
  const serviceName = getServiceName(deviceCode);
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d --force-recreate --no-deps ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 60000 }
  );
  if (stderr && !/pulling|creating|starting|created|started/i.test(stderr)) {
    if (/error/i.test(stderr)) throw new Error(stderr.trim());
  }
}

export async function composeStop(deviceCode: string): Promise<void> {
  const serviceName = getServiceName(deviceCode);
  await execAsync(
    `${COMPOSE_CMD} stop ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 30000 }
  );
}

export async function composeRestart(deviceCode: string): Promise<void> {
  const serviceName = getServiceName(deviceCode);
  await execAsync(
    `${COMPOSE_CMD} stop ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 30000 }
  );
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d --force-recreate --no-deps ${serviceName}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 60000 }
  );
  if (stderr && /error/i.test(stderr) && !/pulling|creating|starting|created|started/i.test(stderr)) {
    throw new Error(stderr.trim());
  }
}

export async function composeUpAll(): Promise<void> {
  await execAsync(
    `${COMPOSE_CMD} up -d`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 120000 }
  );
}

export async function composeUpTriton(): Promise<void> {
  syncTritonServices();
  const { stderr } = await execAsync(
    `${COMPOSE_CMD} up -d --no-deps ${TRITON_SERVICE_NAME}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 300000 } // image pull can take a while
  );
  if (stderr && /error/i.test(stderr) && !/pulling|creating|starting|created|started/i.test(stderr)) {
    throw new Error(stderr.trim());
  }
}

export async function composeStopTriton(): Promise<void> {
  await execAsync(
    `${COMPOSE_CMD} stop ${TRITON_SERVICE_NAME}`,
    { cwd: PYTHON_COUNTING_DIR, timeout: 60000 }
  );
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
