"use client";

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Activity, BarChart3, Shield, Settings, LogOut } from 'lucide-react';
import { Button } from '@cryonix/ui';

interface DashboardLayoutProps {
  children: ReactNode;
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const pathname = usePathname();

  const navItems = [
    { href: '/', label: 'Trading', icon: Activity },
    { href: '/backtest', label: 'Backtest & Risk', icon: BarChart3 },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Top Navigation */}
      <nav className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <Activity className="h-6 w-6 text-primary" />
              <h1 className="text-xl font-bold">Cryonix AI Trading</h1>
            </div>

            {/* Navigation Links */}
            <div className="flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link key={item.href} href={item.href}>
                    <Button
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="sm"
                      className="gap-2"
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Button>
                  </Link>
                );
              })}
            </div>

            <div className="flex items-center gap-2 ml-4">
              <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm text-muted-foreground">All Agents Active</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon">
              <Settings className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon">
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="p-4 h-[calc(100vh-60px)]">
        {children}
      </main>
    </div>
  );
}
