"use client";

import dynamic from 'next/dynamic';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PortfolioCard } from '@/components/dashboard/portfolio-card';
import { PositionsCard } from '@/components/dashboard/positions-card';
import { SignalPipeline } from '@/components/dashboard/signal-pipeline';
import { AgentFlow } from '@/components/dashboard/agent-flow';
import { HealthGrid } from '@/components/dashboard/health-grid';
import { ConfigCard } from '@/components/dashboard/config-card';
import { TradeActivity } from '@/components/dashboard/trade-activity';
import { ProcessViewer } from '@/components/dashboard/process-viewer';
import { SystemVitals } from '@/components/dashboard/system-vitals';
import { CostsCard } from '@/components/dashboard/costs-card';
import { StaggerContainer, FadeUpItem } from '@/components/dashboard/motion-wrappers';

// Lazy load heavy chart components
const PriceChart = dynamic(() => import('@/components/dashboard/price-chart').then(mod => mod.PriceChart), {
  loading: () => <div className="h-[300px] w-full bg-muted/5 animate-pulse rounded-xl" />,
  ssr: false
});
const EquityCurve = dynamic(() => import('@/components/dashboard/equity-curve').then(mod => mod.EquityCurve), {
  loading: () => <div className="h-[160px] w-full bg-muted/5 animate-pulse rounded-xl" />,
  ssr: false
});
const PnlChart = dynamic(() => import('@/components/dashboard/pnl-chart').then(mod => mod.PnlChart), {
  loading: () => <div className="h-[160px] w-full bg-muted/5 animate-pulse rounded-xl" />,
  ssr: false
});
const PatternPerformance = dynamic(() => import('@/components/dashboard/pattern-performance').then(mod => mod.PatternPerformance), {
  loading: () => <div className="h-[160px] w-full bg-muted/5 animate-pulse rounded-xl" />,
  ssr: false
});
const AiImpactChart = dynamic(() => import('@/components/dashboard/ai-impact-chart').then(mod => mod.AiImpactChart), {
  loading: () => <div className="h-[160px] w-full bg-muted/5 animate-pulse rounded-xl" />,
  ssr: false
});
const EvolutionPanel = dynamic(() => import('@/components/dashboard/evolution-panel').then(mod => mod.EvolutionPanel), {
  loading: () => <div className="h-[200px] w-full bg-muted/5 animate-pulse rounded-xl" />,
  ssr: false
});

export default function HomePage() {
  return (
    <DashboardLayout>
      <StaggerContainer className="space-y-2 3xl:space-y-1.5">
        {/* Row 1: System Vitals — always visible */}
        <FadeUpItem>
          <SystemVitals />
        </FadeUpItem>

        {/* Row 2: System Architecture — hidden on ultrawide to reclaim vertical space */}
        <FadeUpItem className="3xl:hidden">
          <AgentFlow />
        </FadeUpItem>

        {/* Row 3: Main Grid — 3-col standard, wider center on ultrawide */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-2.5 3xl:gap-1.5">
            {/* Left Column: Portfolio + Evolution */}
            <div className="col-span-12 lg:col-span-3 3xl:col-span-2 space-y-2.5 3xl:space-y-1.5">
              <PortfolioCard />
              <EvolutionPanel />
            </div>

            {/* Center Column: Price Chart + sub-analytics */}
            <div className="col-span-12 lg:col-span-6 3xl:col-span-7 space-y-2.5 3xl:space-y-1.5 min-w-0">
              <PriceChart />
              <div className="grid grid-cols-2 gap-2.5 3xl:gap-1.5 min-w-0">
                <div className="min-w-0 isolate overflow-hidden"><EquityCurve /></div>
                <div className="min-w-0 isolate overflow-hidden"><PatternPerformance /></div>
              </div>
            </div>

            {/* Right Column: Signal Pipeline + Positions + Config */}
            <div className="col-span-12 lg:col-span-3 space-y-2.5 3xl:space-y-1.5">
              <SignalPipeline />
              <PositionsCard />
              <ConfigCard />
            </div>
          </div>
        </FadeUpItem>

        {/* Row 4: Analytics — PnL + AI Impact + AI Costs */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-2.5 3xl:gap-1.5">
            <div className="col-span-12 lg:col-span-5 min-w-0">
              <PnlChart />
            </div>
            <div className="col-span-12 lg:col-span-4 min-w-0">
              <AiImpactChart />
            </div>
            <div className="col-span-12 lg:col-span-3 min-w-0">
              <CostsCard />
            </div>
          </div>
        </FadeUpItem>

        {/* Row 5: Process Log + Activity + Health */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-2.5 3xl:gap-1.5">
            <div className="col-span-12 lg:col-span-8">
              <ProcessViewer />
            </div>
            <div className="col-span-12 lg:col-span-4 space-y-2.5 3xl:space-y-1.5">
              <TradeActivity />
              <HealthGrid />
            </div>
          </div>
        </FadeUpItem>
      </StaggerContainer>
    </DashboardLayout>
  );
}
