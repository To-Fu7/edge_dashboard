'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, LogOut, Mic, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PttCard } from '@/components/PttCard';

export function Navbar() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [appName, setAppName] = useState('EPiWalk');
  const [pttOpen, setPttOpen] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.username) setUsername(d.username); })
      .catch(() => {});
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { if (d.settings?.appName) setAppName(d.settings.appName); })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="h-12.25 shrink-0 border-b border-border flex items-center justify-between px-4">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-primary" />
        <span className="font-semibold text-sm">{appName}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setPttOpen(v => !v)}
          title="Push to Talk"
          className={[
            'w-8 h-8 rounded-full flex items-center justify-center transition-colors',
            pttOpen
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
          ].join(' ')}
        >
          <Mic className="w-4 h-4" />
        </button>

        <DropdownMenu>
        <DropdownMenuTrigger className="w-8 h-8 rounded-full bg-muted flex items-center justify-center hover:bg-accent transition-colors outline-none">
          <User className="w-4 h-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {username && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">
                  Signed in as
                  <span className="block font-semibold text-foreground truncate">{username}</span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive cursor-pointer">
            <LogOut className="w-4 h-4 mr-2" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>

      {pttOpen && <PttCard onClose={() => setPttOpen(false)} />}
    </header>
  );
}
