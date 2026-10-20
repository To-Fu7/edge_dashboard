import { redirect } from 'next/navigation';

// Old address: cameras have one page now, with the stream and detection tabs together.
export default function Page() {
  redirect('/devices');
}
