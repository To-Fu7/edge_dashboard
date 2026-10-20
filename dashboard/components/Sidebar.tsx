'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Camera, Settings, ScrollText, Activity, Tv2, UserSquare2, HammerIcon, FlaskConical,
  Workflow, ScanEye, ChevronRight, SlidersHorizontal, Network,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Camera;
  exact?: boolean;   // match the path exactly instead of as a prefix
}

interface NavGroup {
  label: string;
  icon: typeof Camera;
  items: NavItem[];
}

// Main area: camera source + live streaming — usable with no detection
// pipeline running at all.
const MAIN_ITEMS: NavItem[] = [
  { href: '/stream', label: 'Stream', icon: Tv2 },
  { href: '/devices', label: 'Devices', icon: Camera },
  { href: '/automation', label: 'Automation', icon: Workflow },
];

// Everything that drives python-counting / Triton (counting, APD, fire/smoke,
// face, intrusion), its models and its settings.
const DETECTION_GROUP: NavGroup = {
  label: 'Detection',
  icon: ScanEye,
  items: [
    { href: '/detection', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    { href: '/detection/devices', label: 'Devices', icon: Camera },
    { href: '/faces', label: 'Face Enrollment', icon: UserSquare2 },
    { href: '/inference', label: 'Build & Inference', icon: HammerIcon },
    { href: '/model-test', label: 'Model Test', icon: FlaskConical },
    { href: '/detection/settings', label: 'Settings', icon: Settings },
  ],
};

const SETTINGS_GROUP: NavGroup = {
  label: 'Settings',
  icon: Settings,
  items: [
    { href: '/settings', label: 'General', icon: SlidersHorizontal, exact: true },
    { href: '/settings/logs', label: 'Logs', icon: ScrollText },
    { href: '/settings/nginx', label: 'Nginx', icon: Network },
  ],
};

function isActive(item: NavItem, pathname: string) {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

function NavLink({ item, pathname, nested }: { item: NavItem; pathname: string; nested?: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        'flex items-center gap-3 py-2 rounded-md text-sm transition-colors',
        nested ? 'pl-9 pr-3' : 'px-3',
        isActive(item, pathname)
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {item.label}
    </Link>
  );
}

function NavDropdown({ group, pathname }: { group: NavGroup; pathname: string }) {
  const containsActive = group.items.some(item => isActive(item, pathname));
  const [open, setOpen] = useState(containsActive);

  // Navigating into the group from elsewhere (a link, the browser back button)
  // should reveal where you are — adjust state during render rather than in an
  // effect (https://react.dev/learn/you-might-not-need-an-effect).
  const [prevContainsActive, setPrevContainsActive] = useState(containsActive);
  if (containsActive !== prevContainsActive) {
    setPrevContainsActive(containsActive);
    if (containsActive) setOpen(true);
  }

  const Icon = group.icon;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
          containsActive && !open
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronRight className={cn('w-4 h-4 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {group.items.map(item => (
            <NavLink key={item.href} item={item} pathname={pathname} nested />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname() ?? '';
  const [appName, setAppName] = useState('Edge');

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
        {MAIN_ITEMS.map(item => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
        <NavDropdown group={DETECTION_GROUP} pathname={pathname} />
        <NavDropdown group={SETTINGS_GROUP} pathname={pathname} />
      </nav>

      <div className="px-5 py-3 border-t border-border">
        <p className="text-xs text-muted-foreground">v3-dashboard</p>
      </div>
    </aside>
  );
}
