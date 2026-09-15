export interface NrFlow {
  id: string;
  label: string;
  disabled: boolean;
  nodes: { id: string; type: string; [key: string]: unknown }[];
}

export function parseNrFlowArray(raw: { id: string; type: string; label?: string; disabled?: boolean; z?: string; [key: string]: unknown }[]): NrFlow[] {
  const tabs = raw.filter(n => n.type === 'tab');
  const nodes = raw.filter(n => n.type !== 'tab');
  return tabs.map(tab => ({
    id: tab.id,
    label: tab.label ?? tab.id,
    disabled: tab.disabled ?? false,
    nodes: nodes.filter(n => n.z === tab.id),
  }));
}

const NR_BASE = process.env.NODERED_URL || 'http://edge-nodered:1880';

async function nrFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${NR_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
  });
}

// ── Flows ────────────────────────────────────────────────────────────────────

export async function getFlows() {
  const res = await nrFetch('/flows');
  if (!res.ok) throw new Error(`getFlows: ${res.status}`);
  return res.json();
}

export async function setFlows(flows: unknown[]) {
  const res = await nrFetch('/flows', {
    method: 'POST',
    body: JSON.stringify(flows),
    headers: { 'Node-RED-Deployment-Type': 'full' },
  });
  if (!res.ok) throw new Error(`setFlows: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function deployFlows() {
  const flows = await getFlows();
  return setFlows(flows);
}

// ── Individual flow (tab) ────────────────────────────────────────────────────

export async function getFlow(id: string) {
  const res = await nrFetch(`/flow/${id}`);
  if (!res.ok) throw new Error(`getFlow: ${res.status}`);
  return res.json();
}

export async function updateFlow(id: string, flow: unknown) {
  const res = await nrFetch(`/flow/${id}`, {
    method: 'PUT',
    body: JSON.stringify(flow),
  });
  if (!res.ok) throw new Error(`updateFlow: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function createFlow(flow: unknown) {
  const res = await nrFetch('/flow', {
    method: 'POST',
    body: JSON.stringify(flow),
  });
  if (!res.ok) throw new Error(`createFlow: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function deleteFlow(id: string) {
  const res = await nrFetch(`/flow/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteFlow: ${res.status}`);
}

// ── Nodes ────────────────────────────────────────────────────────────────────

export async function getNodes() {
  const res = await nrFetch('/nodes');
  if (!res.ok) throw new Error(`getNodes: ${res.status}`);
  return res.json();
}

export async function installNode(module: string) {
  const res = await nrFetch('/nodes', {
    method: 'POST',
    body: JSON.stringify({ module }),
  });
  if (!res.ok) throw new Error(`installNode: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function uninstallNode(module: string) {
  const res = await nrFetch(`/nodes/${encodeURIComponent(module)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`uninstallNode: ${res.status}`);
}

// ── Inject ───────────────────────────────────────────────────────────────────

export async function injectNode(nodeId: string) {
  const res = await nrFetch(`/inject/${nodeId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`injectNode: ${res.status}`);
}

export const NR_URL = NR_BASE;
