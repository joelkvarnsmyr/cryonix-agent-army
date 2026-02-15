"use client";

import { ReactNode, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Activity, BarChart3, Settings, Wifi, WifiOff } from 'lucide-react';
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

function LiveClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('sv-SE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC',
      }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums tracking-wider">
      {time}
    </span>
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
  const env = process.env.NEXT_PUBLIC_APP_URL?.includes('localhost') ? 'DEV' : 'PROD';

  return (
    <div className="min-h-screen bg-background noise-overlay">
      {/* Ambient gradient mesh */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/[0.015] rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/3 w-[400px] h-[400px] bg-violet-500/[0.01] rounded-full blur-[130px]" />
        <div className="absolute top-1/2 right-0 w-[300px] h-[300px] bg-emerald-500/[0.008] rounded-full blur-[100px]" />
      </div>

      {/* Dot grid background */}
      <div className="fixed inset-0 pointer-events-none z-0 dot-grid opacity-40" />

      {/* Top Bar */}
      <nav className="relative z-10 border-b border-border/40 bg-card/30 backdrop-blur-xl">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-4">
            {/* Logo */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
                  <span className="text-primary font-mono text-xs font-bold">CX</span>
                </div>
                <div className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary animate-pulse-dot" />
              </div>
              <div className="flex flex-col">
                <span className="font-semibold text-sm tracking-wide text-foreground/90 leading-none">CRYONIX</span>
                <span className="text-[8px] font-mono text-muted-foreground/40 tracking-widest">NEXUS v2</span>
              </div>
            </div>

            {/* Nav tabs */}
            <div className="flex items-center gap-0.5 bg-muted/30 rounded-lg p-0.5">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link key={item.href} href={item.href}>
                    <button
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        isActive
                          ? 'bg-background/80 text-foreground shadow-sm border border-border/30'
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

          {/* Right: Status + Clock */}
          <div className="flex items-center gap-3">
            {/* Service health pills */}
            <div className="hidden md:flex items-center gap-2.5">
              {services.map((svc) => (
                <div key={svc.name} className="flex items-center gap-1.5">
                  <StatusDot status={svc.status} />
                  <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider">
                    {svc.name.replace(' Tank', '').replace('Python ', '')}
                  </span>
                  {svc.latency !== undefined && (
                    <span className="text-[9px] font-mono text-muted-foreground/30">
                      {svc.latency}ms
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Separator */}
            <div className="h-4 w-px bg-border/20" />

            {/* WS Status */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/20">
              {isConnected
                ? <Wifi className="h-3 w-3 text-emerald-400" />
                : <WifiOff className="h-3 w-3 text-red-400" />
              }
              <span className="text-[9px] font-mono text-muted-foreground/60">
                {isConnected ? 'LIVE' : 'OFF'}
              </span>
            </div>

            {/* Clock */}
            <LiveClock />

            {/* Settings */}
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="relative z-10 p-3 h-[calc(100vh-45px)] overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
