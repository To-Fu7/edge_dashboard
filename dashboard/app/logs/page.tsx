import { redirect } from 'next/navigation';

// Logs moved under Settings; keep old links/bookmarks working.
export default function LogsRedirect() {
  redirect('/settings/logs');
}
