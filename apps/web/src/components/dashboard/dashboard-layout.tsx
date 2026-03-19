"use client";

import { ReactNode, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Activity, Settings, Wifi, WifiOff,
  TrendingUp, CircleDollarSign, ChevronRight, Target, Moon,
} from 'lucide-react';
import { Button } from '@cryonix/ui';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useWebSocket } from '@/hooks/use-websocket';
import { NotificationCenter } from '@/components/notification-center';
import { MobileNav } from '@/components/dashboard/mobile-nav';

interface DashboardLayoutProps {
  children: ReactNode;
}

// ─── Nav structure ────────────────────────────────────────────────────────────
// Main nav: one entry per instance. Sub-pages shown as tabs on the instance page.
export const NAV_GROUPS = [
  {
    id: 'cryonix',
    label: 'CRYONIX',
    accent: 'text-primary',
    dot: 'bg-primary',
    glow: 'shadow-[0_0_8px_hsl(var(--primary)/0.5)]',
    items: [
      { href: '/', label: 'Cryonix', icon: Activity, desc: 'Crypto trading' },
    ],
    subPages: [
      { href: '/',           label: 'Terminal' },
      { href: '/analytics',  label: 'Analytics' },
      { href: '/backtest',   label: 'Backtest' },
      { href: '/legacy',     label: 'Monitor' },
    ],
  },
  {
    id: 'vedic',
    label: 'VEDIC',
    accent: 'text-purple-400',
    dot: 'bg-purple-400',
    glow: 'shadow-[0_0_8px_rgba(192,132,252,0.5)]',
    items: [
      { href: '/vedic', label: 'Vedic', icon: Moon, desc: 'Astrology + BTD trader' },
    ],
  },
  {
    id: 'aktienix',
    label: 'AKTIENIX',
    accent: 'text-violet-400',
    dot: 'bg-violet-400',
    glow: 'shadow-[0_0_8px_rgba(167,139,250,0.5)]',
    items: [
      { href: '/aktienix', label: 'Aktienix', icon: TrendingUp, desc: 'US equity agent' },
    ],
  },
  {
    id: 'solanix',
    label: 'SOLANIX',
    accent: 'text-amber-400',
    dot: 'bg-amber-400',
    glow: 'shadow-[0_0_8px_rgba(251,191,36,0.5)]',
    items: [
      { href: '/solanix', label: 'Solanix', icon: CircleDollarSign, desc: 'DEX trading agent' },
    ],
  },
  {
    id: 'polynix',
    label: 'POLYNIX',
    accent: 'text-orange-400',
    dot: 'bg-orange-400',
    glow: 'shadow-[0_0_8px_rgba(251,146,60,0.5)]',
    items: [
      { href: '/polynix', label: 'Polynix', icon: Target, desc: 'Binary options agent' },
    ],
  },
  {
    id: 'copynix',
    label: 'COPYNIX',
    accent: 'text-cyan-400',
    dot: 'bg-cyan-400',
    glow: 'shadow-[0_0_8px_rgba(34,211,238,0.5)]',
    items: [
      { href: '/copynix', label: 'Copynix', icon: CircleDollarSign, desc: 'Copy-trading agent' },
    ],
  },
  {
    id: 'psinix',
    label: 'ΨNIX',
    accent: 'text-violet-400',
    dot: 'bg-violet-400',
    glow: 'shadow-[0_0_8px_rgba(139,92,246,0.5)]',
    items: [
      { href: '/psinix', label: 'Ψnix', icon: CircleDollarSign, desc: 'Phase convergence agent' },
    ],
  },
] as const;

type NavGroup = (typeof NAV_GROUPS)[number];
type SubPage = { href: string; label: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function isActive(href: string, pathname: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/** Check if pathname belongs to a group (including sub-pages). */
export function isGroupActive(group: NavGroup, pathname: string) {
  if (group.items.some(item => isActive(item.href, pathname))) return true;
  if ('subPages' in group) {
    return (group as NavGroup & { subPages: SubPage[] }).subPages.some(sp => isActive(sp.href, pathname));
  }
  return false;
}

function getActiveContext(pathname: string) {
  for (const group of NAV_GROUPS) {
    // Check sub-pages first (more specific)
    if ('subPages' in group) {
      const subPages = (group as NavGroup & { subPages: SubPage[] }).subPages;
      for (const sp of subPages) {
        if (isActive(sp.href, pathname)) return { group, item: group.items[0], subPage: sp };
      }
    }
    for (const item of group.items) {
      if (isActive(item.href, pathname)) return { group, item };
    }
  }
  return null;
}

/** Get sub-pages for the active group, if any. */
function getSubPages(group: NavGroup): SubPage[] {
  if ('subPages' in group) {
    return (group as NavGroup & { subPages: SubPage[] }).subPages;
  }
  return [];
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatusDot({ status }: { status: 'healthy' | 'degraded' | 'down' | 'unknown' }) {
  const colors = {
    healthy: 'bg-emerald-400',
    degraded: 'bg-amber-400',
    down: 'bg-red-400',
    unknown: 'bg-zinc-500',
  };
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${colors[status]} ${
        status === 'healthy' ? 'animate-pulse-dot' : ''
      }`}
    />
  );
}

function LiveClock() {
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }),
      );
      setDate(
        now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).toUpperCase(),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex flex-col items-end leading-none gap-0.5">
      <span className="font-mono text-[10px] tabular-nums tracking-wider text-foreground/70">{time}</span>
      <span className="font-mono text-[8px] tracking-widest text-muted-foreground/40 uppercase">{date} UTC</span>
    </div>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────
function DashboardFooter({
  pathname,
  healthyCount,
  totalServices,
}: {
  pathname: string;
  healthyCount: number;
  totalServices: number;
}) {
  const allHealthy = totalServices > 0 && healthyCount === totalServices;

  return (
    <footer className="relative z-10 shrink-0 border-t border-border/30 bg-card/20 backdrop-blur-xl">
      <div className="flex items-center justify-between px-4 py-2 gap-4">

        {/* Left: brand */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="h-5 w-5 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
            <span className="text-primary font-mono text-[8px] font-bold">CX</span>
          </div>
          <span className="hidden sm:block text-[9px] font-mono text-muted-foreground/35 tracking-widest uppercase">
            Autonomous AI Trading
          </span>
        </div>

        {/* Center: quick-link grid — compact dots on mobile, full labels on lg+ */}
        <nav className="flex items-center gap-2 sm:gap-3 flex-wrap justify-center">
          {/* Mobile: compact agent dots */}
          <div className="flex lg:hidden items-center gap-1.5">
            {NAV_GROUPS.map((group) => {
              const active = group.items.some(item => isActive(item.href, pathname));
              return (
                <Link key={group.id} href={group.items[0].href} title={group.items[0].label}>
                  <span className={`inline-block h-2 w-2 rounded-full transition-all ${
                    active ? `${group.dot} scale-125` : 'bg-muted-foreground/25 hover:bg-muted-foreground/45'
                  }`} />
                </Link>
              );
            })}
          </div>

          {/* Desktop: full labels */}
          <div className="hidden lg:flex items-center gap-3">
            {NAV_GROUPS.map((group, gi) => (
              <div key={group.id} className="flex items-center gap-2">
                {gi > 0 && <span className="text-border/30 text-[10px]">|</span>}
                <span className={`text-[8px] font-mono font-bold tracking-widest opacity-40 ${group.accent}`}>
                  {group.label}
                </span>
                {group.items.map((item) => {
                  const active = isActive(item.href, pathname);
                  return (
                    <Link key={item.href} href={item.href} title={item.desc}>
                      <span className={`text-[9px] font-mono transition-colors ${
                        active ? group.accent : 'text-muted-foreground/45 hover:text-foreground/65'
                      }`}>
                        {item.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>

        {/* Right: services + version */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden md:flex items-center gap-1.5">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                allHealthy ? 'bg-emerald-400 animate-pulse-dot' : totalServices === 0 ? 'bg-zinc-500' : 'bg-amber-400'
              }`}
            />
            <span className="text-[9px] font-mono text-muted-foreground/45">
              {totalServices > 0 ? `${healthyCount}/${totalServices} services` : 'connecting…'}
            </span>
          </div>
          <span className="text-[9px] font-mono text-muted-foreground/25 tracking-widest">NEXUS v2</span>
        </div>

      </div>
    </footer>
  );
}

// ─── Main Layout ──────────────────────────────────────────────────────────────
export function DashboardLayout({ children }: DashboardLayoutProps) {
  const pathname = usePathname();
  const { health } = useSystemHealth(30000);
  const { isConnected } = useWebSocket();

  const services = health?.services ?? [];
  const healthyCount = services.filter((s) => s.status === 'healthy').length;
  const ctx = getActiveContext(pathname);

  return (
    <div className="h-screen bg-background noise-overlay flex flex-col overflow-hidden">

      {/* Ambient gradient mesh */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/[0.015] rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/3 w-[400px] h-[400px] bg-violet-500/[0.01] rounded-full blur-[130px]" />
        <div className="absolute top-1/2 right-0 w-[300px] h-[300px] bg-emerald-500/[0.008] rounded-full blur-[100px]" />
      </div>

      {/* Dot grid */}
      <div className="fixed inset-0 pointer-events-none z-0 dot-grid opacity-40" />

      {/* ── Top Nav ─────────────────────────────────────────────────────────── */}
      <nav className="relative z-10 shrink-0 border-b border-border/40 bg-card/30 backdrop-blur-xl">

        {/* Main row */}
        <div className="flex items-center justify-between px-4 h-11 gap-3">

          {/* Left: Logo + nav groups */}
          <div className="flex items-center gap-3 min-w-0">

            {/* Mobile hamburger */}
            <MobileNav pathname={pathname} />

            {/* Logo */}
            <Link href="/" className="flex items-center gap-2 group shrink-0">
              <div className="relative">
                <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 group-hover:border-primary/40 transition-colors">
                  <span className="text-primary font-mono text-xs font-bold">CX</span>
                </div>
                <div className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary animate-pulse-dot" />
              </div>
              <div className="hidden sm:flex flex-col leading-none gap-0.5">
                <span className="font-semibold text-sm tracking-wide text-foreground/90">CRYONIX</span>
                <span className="text-[8px] font-mono text-muted-foreground/40 tracking-widest">NEXUS v2</span>
              </div>
            </Link>

            {/* Divider — hidden on mobile */}
            <div className="hidden md:block h-5 w-px bg-border/30 shrink-0" />

            {/* Instance buttons — hidden on mobile, shown on md+ */}
            <div className="hidden md:flex items-center gap-1 overflow-x-auto scrollbar-none">
              {NAV_GROUPS.map((group) => {
                const Icon = group.items[0].icon;
                const active = isGroupActive(group, pathname);
                return (
                  <Link
                    key={group.id}
                    href={group.items[0].href}
                    title={group.items[0].desc}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      active
                        ? `bg-background/80 ${group.accent} shadow-sm border border-border/40`
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${active ? group.dot : 'bg-muted-foreground/30'}`} />
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="hidden sm:inline">{group.items[0].label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Right: status + controls */}
          <div className="flex items-center gap-2 shrink-0">

            {/* Service health pills */}
            <div className="hidden lg:flex items-center gap-2.5">
              {services.map((svc) => (
                <div key={svc.name} className="flex items-center gap-1.5">
                  <StatusDot status={svc.status} />
                  <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider">
                    {svc.name.replace(' Tank', '').replace('Python ', '')}
                  </span>
                  {svc.latency !== undefined && (
                    <span className="text-[9px] font-mono text-muted-foreground/30">{svc.latency}ms</span>
                  )}
                </div>
              ))}
            </div>

            {/* Divider */}
            <div className="h-4 w-px bg-border/20" />

            {/* Cmd+K */}
            <button
              onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/20 hover:bg-muted/40 transition-colors"
              aria-label="Open command palette"
            >
              <span className="text-[9px] font-mono text-muted-foreground/60">⌘K</span>
            </button>

            {/* WS status */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/20">
              {isConnected
                ? <Wifi className="h-3 w-3 text-emerald-400" />
                : <WifiOff className="h-3 w-3 text-red-400" />
              }
              <span className="hidden sm:inline text-[9px] font-mono text-muted-foreground/60">
                {isConnected ? 'LIVE' : 'OFF'}
              </span>
            </div>

            {/* Clock */}
            <div className="hidden sm:block">
              <LiveClock />
            </div>

            {/* Notifications */}
            <NotificationCenter />

            {/* Settings */}
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Settings">
              <Settings className="h-3.5 w-3.5" />
            </Button>

          </div>
        </div>

        {/* Sub-page tabs (shown when active group has sub-pages) */}
        {ctx && (() => {
          const subPages = getSubPages(ctx.group);
          if (subPages.length === 0) {
            // No sub-pages: simple breadcrumb
            return (
              <div className="border-t border-border/20 px-4 py-1 flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${ctx.group.dot}`} />
                <span className={`text-[9px] font-mono font-semibold tracking-widest uppercase opacity-55 ${ctx.group.accent}`}>
                  {ctx.group.label}
                </span>
                <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />
                <span className="text-[9px] font-mono text-muted-foreground/65 font-medium">{ctx.item.desc}</span>
              </div>
            );
          }
          // Sub-pages: render as tab bar
          return (
            <div className="border-t border-border/20 px-4 py-0.5 flex items-center gap-0.5">
              {subPages.map((sp) => {
                const active = isActive(sp.href, pathname);
                return (
                  <Link
                    key={sp.href}
                    href={sp.href}
                    className={`px-3 py-1 text-[10px] font-mono font-medium rounded-md transition-all ${
                      active
                        ? `${ctx.group.accent} bg-background/60 border border-border/30`
                        : 'text-muted-foreground/50 hover:text-foreground/70 hover:bg-muted/20'
                    }`}
                  >
                    {sp.label}
                  </Link>
                );
              })}
            </div>
          );
        })()}
      </nav>

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <main className="relative z-10 flex-1 overflow-y-auto p-2 sm:p-3">
        {children}
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <DashboardFooter
        pathname={pathname}
        healthyCount={healthyCount}
        totalServices={services.length}
      />

    </div>
  );
}
