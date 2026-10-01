'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Camera, Settings, ScrollText, Activity, Tv2, UserSquare2, HammerIcon, FlaskConical,
} from 'lucide-react';
// import { Workflow } from 'lucide-react'; // re-add alongside the Automation nav item below when re-enabling
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Camera;
  exact?: boolean;   // match the path exactly instead of as a prefix
}

// Main area: camera source + live streaming + port forward — usable with no
// detection pipeline running at all.
const MAIN_ITEMS: NavItem[] = [
  { href: '/stream', label: 'Stream', icon: Tv2 },
  { href: '/devices', label: 'Devices', icon: Camera },
  // Node-RED integration temporarily disabled (server.js: NODERED_ENABLED) —
  // see nodered/DEV_NOTES.md (gitignored). Re-add once re-enabled:
  // { href: '/automation', label: 'Automation', icon: Workflow },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/settings', label: 'Settings', icon: Settings },
];

// Detection area: the python-counting / Triton pipeline (counting, APD,
// fire/smoke, face, intrusion), its models and its settings.
const DETECTION_ITEMS: NavItem[] = [
  { href: '/detection', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/detection/devices', label: 'Devices', icon: Camera },
  { href: '/faces', label: 'Face Enrollment', icon: UserSquare2 },
  { href: '/inference', label: 'Build & Inference', icon: HammerIcon },
  { href: '/model-test', label: 'Model Test', icon: FlaskConical },
  { href: '/detection/settings', label: 'Settings', icon: Settings },
];

function NavLinks({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <>
      {items.map(item => {
        const Icon = item.icon;
        const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [appName, setAppName] = useState('EPiWalk');

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { if (d.settings?.appName) setAppName(d.settings.appName); })
      .catch(() => {});
  }, []);

  return (
    <aside className="flex flex-col h-full w-60 border-r border-border bg-background">
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm tracking-wide">{appName}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">Camera, Stream & Detection</p>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
        <NavLinks items={MAIN_ITEMS} pathname={pathname} />
        <p className="px-3 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Detection
        </p>
        <NavLinks items={DETECTION_ITEMS} pathname={pathname} />
      </nav>

      <div className="px-5 py-3 border-t border-border">
        <p className="text-xs text-muted-foreground">v3-dashboard</p>
      </div>
    </aside>
  );
}
