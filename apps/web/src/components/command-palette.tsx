'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@cryonix/ui';
import { Activity, BarChart3, LineChart, FlaskConical, RefreshCw, ExternalLink } from 'lucide-react';

const pages = [
  { name: 'Terminal', href: '/', icon: Activity, shortcut: '1' },
  { name: 'Legacy Dashboard', href: '/legacy', icon: BarChart3, shortcut: '2' },
  { name: 'Analytics', href: '/analytics', icon: LineChart, shortcut: '3' },
  { name: 'Backtest', href: '/backtest', icon: FlaskConical, shortcut: '4' },
];

const actions = [
  { name: 'Refresh page', action: 'refresh', icon: RefreshCw },
  { name: 'Open Binance', action: 'binance', icon: ExternalLink },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {pages.map((page) => {
            const Icon = page.icon;
            return (
              <CommandItem
                key={page.href}
                onSelect={() => runCommand(() => router.push(page.href))}
              >
                <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                {page.name}
                <CommandShortcut>⌘{page.shortcut}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <CommandItem
                key={action.action}
                onSelect={() =>
                  runCommand(() => {
                    if (action.action === 'refresh') window.location.reload();
                    if (action.action === 'binance') window.open('https://www.binance.com/en/trade', '_blank');
                  })
                }
              >
                <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                {action.name}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
