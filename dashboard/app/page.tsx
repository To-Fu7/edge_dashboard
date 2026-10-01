import { redirect } from 'next/navigation';

// The main area opens on live streams; the detection dashboard lives at /detection.
export default function Home() {
  redirect('/stream');
}
