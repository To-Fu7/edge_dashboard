import { redirect } from 'next/navigation';

// Old address: cameras have one page now, with the stream and detection tabs together.
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  redirect(`/devices/${encodeURIComponent(code)}`);
}
