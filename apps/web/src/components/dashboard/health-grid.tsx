"use client";

import { Card, CardContent } from '@cryonix/ui';
import { Activity, Database, Server, Radio, RefreshCw } from 'lucide-react';
import { useSystemHealth } from '@/hooks/useSystemHealth';

const serviceIcons: Record<string, typeof Activity> = {
  'Redis': Database,
  'Postgres': Database,
  'Python Engine': Server,
  'MarketScout Tank': Radio,
};

export function HealthGrid() {
  const { health, loading, refresh } = useSystemHealth(30000);
  const services = health?.services || [];

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">System Health</span>
          </div>
          <button onClick={refresh} className="text-muted-foreground hover:text-foreground transition-colors">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Overall status */}
        {health && (
          <div className="flex items-center gap-2 mb-3">
            <span className={`h-2.5 w-2.5 rounded-full ${
              health.status === 'healthy' ? 'bg-emerald-400 animate-pulse-dot' :
              health.status === 'degraded' ? 'bg-amber-400' : 'bg-red-400'
            }`} />
            <span className="font-mono text-sm font-semibold">
              {health.summary.healthy}/{health.summary.total}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">
              {health.totalLatency}ms total
            </span>
          </div>
        )}

        {/* Service grid */}
        <div className="grid grid-cols-2 gap-2">
          {services.map((svc) => {
            const Icon = serviceIcons[svc.name] || Server;
            const statusColor = svc.status === 'healthy' ? 'border-emerald-500/20 bg-emerald-500/[0.03]' :
                                svc.status === 'degraded' ? 'border-amber-500/20 bg-amber-500/[0.03]' :
                                'border-red-500/20 bg-red-500/[0.03]';
            const dotColor = svc.status === 'healthy' ? 'bg-emerald-400' :
                            svc.status === 'degraded' ? 'bg-amber-400' : 'bg-red-400';
            return (
              <div key={svc.name} className={`rounded-lg border p-2.5 ${statusColor}`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3 text-muted-foreground/60" />
                    <span className="text-[10px] font-mono font-medium text-foreground/80">
                      {svc.name.replace(' Tank', '').replace('Python ', '')}
                    </span>
                  </div>
                  <span className={`h-1.5 w-1.5 rounded-full ${dotColor} ${svc.status === 'healthy' ? 'animate-pulse-dot' : ''}`} />
                </div>
                {svc.latency !== undefined && (
                  <span className="text-[9px] font-mono text-muted-foreground/50">{svc.latency}ms</span>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
