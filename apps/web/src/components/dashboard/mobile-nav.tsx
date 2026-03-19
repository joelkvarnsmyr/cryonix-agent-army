"use client";

import { useState } from 'react';
import Link from 'next/link';
import { Menu, ChevronRight } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@cryonix/ui';
import { NAV_GROUPS, isActive, isGroupActive } from './dashboard-layout';

type NavGroup = (typeof NAV_GROUPS)[number];

interface MobileNavProps {
  pathname: string;
}

export function MobileNav({ pathname }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="md:hidden flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted/30 transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5 text-foreground/70" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-72 bg-background/95 backdrop-blur-xl border-border/30 p-0"
      >
        <SheetHeader className="px-4 pt-4 pb-2 border-b border-border/20">
          <SheetTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
              <span className="text-primary font-mono text-xs font-bold">CX</span>
            </div>
            <div className="flex flex-col leading-none gap-0.5">
              <span className="font-semibold text-sm tracking-wide text-foreground/90">CRYONIX</span>
              <span className="text-[8px] font-mono text-muted-foreground/40 tracking-widest">NEXUS v2</span>
            </div>
          </SheetTitle>
          <SheetDescription className="sr-only">Navigate between trading instances</SheetDescription>
        </SheetHeader>

        <nav className="flex flex-col py-2 overflow-y-auto max-h-[calc(100vh-80px)]">
          {NAV_GROUPS.map((group) => {
            const active = isGroupActive(group, pathname);
            const Icon = group.items[0].icon;

            return (
              <div key={group.id} className="px-2">
                {/* Agent group header */}
                <Link
                  href={group.items[0].href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                    active
                      ? `bg-muted/30 ${group.accent}`
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/15'
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 ${active ? group.dot : 'bg-muted-foreground/30'}`} />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-medium">{group.items[0].label}</span>
                  <span className="text-[9px] font-mono opacity-40 ml-auto">{group.items[0].desc}</span>
                </Link>

                {/* Sub-pages (expanded when active) */}
                {active && 'subPages' in group && (group as NavGroup & { subPages: { href: string; label: string }[] }).subPages.length > 0 && (
                  <div className="ml-7 mt-0.5 mb-1 flex flex-col gap-0.5">
                    {(group as NavGroup & { subPages: { href: string; label: string }[] }).subPages.map((sp) => {
                      const subActive = isActive(sp.href, pathname);
                      return (
                        <Link
                          key={sp.href}
                          href={sp.href}
                          onClick={() => setOpen(false)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono transition-all ${
                            subActive
                              ? `${group.accent} bg-background/60 border border-border/30`
                              : 'text-muted-foreground/60 hover:text-foreground/70 hover:bg-muted/15'
                          }`}
                        >
                          <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                          {sp.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
