import { IframeEditor } from '@/components/nodered/IframeEditor';

type Props = { params: Promise<{ flowId: string[] }> };

// Fetch the flow label server-side so the breadcrumb shows the real name,
// not just the raw ID. Falls back gracefully if NR is unreachable.
async function getFlowLabel(flowId: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${process.env.NODERED_URL ?? 'http://edge-nodered:1880'}/flows`,
      { cache: 'no-store' }
    );
    if (!res.ok) return undefined;
    const flows: { id: string; label?: string; type: string }[] = await res.json();
    return flows.find(f => f.id === flowId && f.type === 'tab')?.label;
  } catch {
    return undefined;
  }
}

export default async function FlowEditorPage({ params }: Props) {
  const { flowId: flowIdParts } = await params;
  // URL encodes '.' as '~' to avoid Next.js treating the segment as a static file
  const flowId = flowIdParts.join('/').replace(/~/g, '.');
  const label = await getFlowLabel(flowId);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <IframeEditor flowId={flowId} flowLabel={label} />
    </div>
  );
}
