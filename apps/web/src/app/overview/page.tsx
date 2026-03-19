"use client";

import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { useOverview } from '@/hooks/useOverview';
import { PortfolioSummary } from '@/components/overview/portfolio-summary';
import { InstanceCard } from '@/components/overview/instance-card';
import { SystemHealthGrid } from '@/components/overview/system-health-grid';
import { SignalActivityFeed } from '@/components/overview/signal-activity-feed';

export default function OverviewPage() {
  const { data, loading, error } = useOverview(30000);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-4">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold font-mono tracking-wide text-foreground/90">
              NEXUS OVERVIEW
            </h1>
            <p className="text-[10px] font-mono text-muted-foreground/45 tracking-widest uppercase">
              All trading instances • Real-time aggregation
            </p>
          </div>
          {data && (
            <span className="text-[9px] font-mono text-muted-foreground/30">
              Updated {new Date(data.timestamp).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} UTC
            </span>
          )}
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <span className="text-xs font-mono text-muted-foreground/50">Loading all instances...</span>
            </div>
          </div>
        ) : error && !data ? (
          <div className="glass-card rounded-xl p-8 border border-red-500/20 text-center">
            <p className="text-sm font-mono text-red-400">Failed to load overview: {error}</p>
          </div>
        ) : data ? (
          <>
            {/* Top summary row */}
            <PortfolioSummary
              totalValue={data.totalPortfolioValue}
              dailyPnl={data.totalDailyPnl}
              blendedWinRate={data.blendedWinRate}
              instancesOnline={data.instancesOnline}
              instancesTotal={data.instancesTotal}
            />

            {/* Instance cards grid */}
            <div>
              <h2 className="text-[10px] font-mono font-bold text-muted-foreground/50 tracking-widest uppercase mb-2">
                Trading Instances
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {data.instances.map((inst) => (
                  <InstanceCard key={inst.id} {...inst} />
                ))}
              </div>
            </div>

            {/* Bottom row: health + activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="lg:col-span-1 space-y-3">
                <SystemHealthGrid instances={data.instances} />
              </div>
              <div className="lg:col-span-2">
                <SignalActivityFeed instances={data.instances} />
              </div>
            </div>
          </>
        ) : null}

      </div>
    </DashboardLayout>
  );
}
