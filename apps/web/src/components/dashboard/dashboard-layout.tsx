"use client";

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Activity, BarChart3, Settings } from 'lucide-react';
import { Button } from '@cryonix/ui';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useWebSocket } from '@/hooks/use-websocket';

interface DashboardLayoutProps {
  children: ReactNode;
}

function StatusDot({ status }: { status: 'healthy' | 'degraded' | 'down' | 'unknown' }) {
  const colors = {
    healthy: 'bg-emerald-400',
    degraded: 'bg-amber-400',
    down: 'bg-red-400',
    unknown: 'bg-zinc-500',
  };
  return (
    <span className={`inline-block h-1.5 w-1.5 rounded-full ${colors[status]} ${status === 'healthy' ? 'animate-pulse-dot' : ''}`} />
  );
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const pathname = usePathname();
  const { health } = useSystemHealth(30000);
  const { isConnected } = useWebSocket();

  const navItems = [
    { href: '/', label: 'Terminal', icon: Activity },
    { href: '/backtest', label: 'Backtest', icon: BarChart3 },
  ];

  const services = health?.services || [];

  return (
    <div className="min-h-screen bg-background noise-overlay">
      {/* Ambient gradient */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/[0.02] rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-primary/[0.015] rounded-full blur-[120px]" />
      </div>

      {/* Top Bar */}
      <nav className="relative z-10 border-b border-border/50 bg-card/40 backdrop-blur-xl">
        <div className="flex items-center justify-between px-5 py-2.5">
          <div className="flex items-center gap-5">
            {/* Logo */}
            <div className="flex items-center gap-2.5">
              <div className="relative">
                <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
                  <span className="text-primary font-mono text-xs font-bold">CX</span>
                </div>
                <div className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary animate-pulse-dot" />
              </div>
              <span className="font-semibold text-sm tracking-wide text-foreground/90">CRYONIX</span>
            </div>

            {/* Nav */}
            <div className="flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link key={item.href} href={item.href}>
                    <button
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        isActive
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                    </button>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Status Indicators */}
          <div className="flex items-center gap-4">
            {/* Service Health Pills */}
            <div className="hidden md:flex items-center gap-3">
              {services.map((svc) => (
                <div key={svc.name} className="flex items-center gap-1.5">
                  <StatusDot status={svc.status} />
                  <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                    {svc.name.replace(' Tank', '').replace('Python ', '')}
                  </span>
                  {svc.latency && (
                    <span className="text-[10px] font-mono text-muted-foreground/60">
                      {svc.latency}ms
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* WS Status */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/30">
              <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
              <span className="text-[10px] font-mono text-muted-foreground">
                WS
              </span>
            </div>

            <Button variant="ghost" size="icon" className="h-7 w-7">
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="relative z-10 p-4 h-[calc(100vh-49px)] overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
