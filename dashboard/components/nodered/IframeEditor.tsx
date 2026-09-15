'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, Maximize2, Minimize2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  flowId: string;
  flowLabel?: string;
}

export function IframeEditor({ flowId, flowLabel }: Props) {
  const [fullscreen, setFullscreen] = useState(false);

  const iframe = (
    <iframe
      src={`/nodered/#flow/${flowId}`}
      className="w-full h-full border-0"
      title={flowLabel ? `${flowLabel} — Node-RED` : 'Node-RED Flow Editor'}
      allow="clipboard-read; clipboard-write"
    />
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        <div className="flex items-center justify-between px-4 py-1.5 border-b border-border shrink-0 bg-background">
          <span className="text-sm font-medium truncate">{flowLabel ?? 'Flow Editor'}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 shrink-0"
            onClick={() => setFullscreen(false)}
          >
            <Minimize2 className="w-3 h-3" />
            Exit fullscreen
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">{iframe}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <Link
          href="/automation"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            'h-7 text-xs gap-1 text-muted-foreground'
          )}
        >
          <ChevronLeft className="w-3 h-3" />
          Workflow
        </Link>
        {flowLabel && (
          <>
            <span className="text-muted-foreground text-xs">/</span>
            <span className="text-xs font-medium truncate">{flowLabel}</span>
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1.5 ml-auto shrink-0"
          onClick={() => setFullscreen(true)}
        >
          <Maximize2 className="w-3 h-3" />
          Fullscreen
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">{iframe}</div>
    </div>
  );
}
