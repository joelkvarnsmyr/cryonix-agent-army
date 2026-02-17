import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PortfolioCard } from '@/components/dashboard/portfolio-card';
import { PositionsCard } from '@/components/dashboard/positions-card';
import { SignalPipeline } from '@/components/dashboard/signal-pipeline';
import { AgentFlow } from '@/components/dashboard/agent-flow';
import { HealthGrid } from '@/components/dashboard/health-grid';
import { ConfigCard } from '@/components/dashboard/config-card';
import { TradeActivity } from '@/components/dashboard/trade-activity';
import { ProcessViewer } from '@/components/dashboard/process-viewer';
import { PriceChart } from '@/components/dashboard/price-chart';
import { EquityCurve } from '@/components/dashboard/equity-curve';
import { PnlChart } from '@/components/dashboard/pnl-chart';
import { PatternPerformance } from '@/components/dashboard/pattern-performance';
import { AiImpactChart } from '@/components/dashboard/ai-impact-chart';
import { SystemVitals } from '@/components/dashboard/system-vitals';
import { EvolutionPanel } from '@/components/dashboard/evolution-panel';
import { StaggerContainer, FadeUpItem } from '@/components/dashboard/motion-wrappers';

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
                <EquityCurve />
                <PatternPerformance />
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

        {/* Row 4: Analytics — PnL + AI Impact side by side */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-2.5 3xl:gap-1.5">
            <div className="col-span-12 lg:col-span-6 min-w-0">
              <PnlChart />
            </div>
            <div className="col-span-12 lg:col-span-6 min-w-0">
              <AiImpactChart />
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
