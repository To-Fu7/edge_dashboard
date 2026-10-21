// Camera container lifecycle through the Docker API (no docker-compose).
//
// One container per device: name device-<code>, labelled with the device UUID
// so a renamed device can still find (and replace) its old container. The
// container only gets connection details; its configuration is read from the
// database by python-counting/bootstrap.py at start.
import { getDocker, mapDockerState } from './docker';
import { deviceDbEnv } from './db';
import { containerNameFor } from './device-config';
import { HOST_PYTHON_COUNTING_DIR, TRITON_SERVICE_NAME } from './compose';
import type { ContainerStatus } from './types';
import type { DeviceRow } from './devices';

export const DEVICE_IMAGE = process.env.EDGE_DEVICE_IMAGE || 'edge-device:latest';
const NETWORK = 'envisions';
const LABEL_ROLE = 'edge.role';
const LABEL_ID = 'edge.device.id';
// Bump when the container definition below changes: containers with an older
// spec are recreated on the next start/reconcile so they pick up the change.
//   2 — /dev/shm shared with Triton (system shared memory for frames)
const LABEL_SPEC = 'edge.device.spec';
const CONTAINER_SPEC = '2';

type Device = Pick<DeviceRow, 'id' | 'code' | 'name' | 'enabled'>;

interface ListedContainer { Id: string; Names: string[]; State: string; Labels: Record<string, string> }

async function containersByDevice(): Promise<Map<string, ListedContainer>> {
  const list = await getDocker().listContainers({ all: true, filters: { label: [`${LABEL_ROLE}=device`] } }) as ListedContainer[];
  return new Map(list.map(c => [c.Labels[LABEL_ID], c]));
}

function isNotFound(e: unknown): boolean {
  return (e as { statusCode?: number }).statusCode === 404;
}

export async function deviceImageExists(): Promise<boolean> {
  try {
    await getDocker().getImage(DEVICE_IMAGE).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Create the container if it doesn't exist, or recreate it when it exists
 *  under an old name (renamed device) or from an older container spec. */
export async function ensureContainer(device: Device): Promise<string> {
  const name = containerNameFor(device.code);
  const existing = (await containersByDevice()).get(device.id);
  if (existing) {
    const sameName = existing.Names.some(n => n.replace(/^\//, '') === name);
    if (sameName && existing.Labels[LABEL_SPEC] === CONTAINER_SPEC) return name;
    await getDocker().getContainer(existing.Id).remove({ force: true });
  }
  if (!(await deviceImageExists())) {
    throw new Error(`Camera image ${DEVICE_IMAGE} is not built. Build it from Detection → Dashboard or run setup/install.sh --only images.`);
  }
  const env = {
    ...deviceDbEnv(),
    EDGE_DEVICE_ID: device.id,
    TRITON_URL: `${TRITON_SERVICE_NAME}:8001`,
    TZ: process.env.TZ || 'Asia/Jakarta',
  };
  await getDocker().createContainer({
    name,
    Image: DEVICE_IMAGE,
    Cmd: ['python', 'bootstrap.py'],
    WorkingDir: '/app',
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { [LABEL_ROLE]: 'device', [LABEL_ID]: device.id, [LABEL_SPEC]: CONTAINER_SPEC },
    HostConfig: {
      // /dev/shm is the host's, as in the Triton container: frames go to Triton
      // through system shared memory instead of inside the gRPC request.
      Binds: [`${HOST_PYTHON_COUNTING_DIR}:/app`, '/dev/shm:/dev/shm'],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: NETWORK,
      ExtraHosts: ['host.docker.internal:host-gateway'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
    },
  });
  return name;
}

export async function startDevice(device: Device): Promise<void> {
  const name = await ensureContainer(device);
  const c = getDocker().getContainer(name);
  const info = await c.inspect();
  if (!info.State.Running) await c.start();
}

export async function stopDevice(device: Device): Promise<void> {
  const existing = (await containersByDevice()).get(device.id);
  if (!existing || existing.State !== 'running') return;
  await getDocker().getContainer(existing.Id).stop({ t: 15 });
}

export async function restartDevice(device: Device): Promise<void> {
  const name = await ensureContainer(device);
  const c = getDocker().getContainer(name);
  const info = await c.inspect();
  if (info.State.Running) await c.restart({ t: 15 });
  else await c.start();
}

export async function removeDeviceContainer(deviceId: string): Promise<void> {
  const existing = (await containersByDevice()).get(deviceId);
  if (!existing) return;
  try {
    await getDocker().getContainer(existing.Id).remove({ force: true });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

/** Container name + state per device id, from a single Docker API call. */
export async function deviceContainerStatuses(): Promise<Map<string, { name: string; status: ContainerStatus }>> {
  const byDevice = await containersByDevice();
  const out = new Map<string, { name: string; status: ContainerStatus }>();
  for (const [id, c] of byDevice) {
    out.set(id, { name: c.Names[0]?.replace(/^\//, '') ?? '', status: mapDockerState(c.State) });
  }
  return out;
}

/**
 * Make Docker match the database: every device has a container under its
 * current name, enabled devices are running, and containers whose device was
 * deleted are removed. Run at dashboard start; failures are logged per device.
 */
export async function reconcileDevices(devices: Device[]): Promise<void> {
  const byDevice = await containersByDevice();
  const ids = new Set(devices.map(d => d.id));
  for (const [id, c] of byDevice) {
    if (!ids.has(id)) {
      await getDocker().getContainer(c.Id).remove({ force: true }).catch(err =>
        console.error(`[reconcile] could not remove orphan container ${c.Names[0]}:`, err.message));
    }
  }
  for (const d of devices) {
    try {
      if (d.enabled) await startDevice(d);
      else await ensureContainer(d);
    } catch (err) {
      console.error(`[reconcile] ${d.code}: ${(err as Error).message}`);
    }
  }
}
