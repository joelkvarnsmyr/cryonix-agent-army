import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PortfolioCard } from '@/components/dashboard/portfolio-card';
import { PositionsCard } from '@/components/dashboard/positions-card';
import { SignalPipeline } from '@/components/dashboard/signal-pipeline';
import { AgentFlow } from '@/components/dashboard/agent-flow';
import { MarketTicker } from '@/components/dashboard/market-ticker';
import { HealthGrid } from '@/components/dashboard/health-grid';
import { ConfigCard } from '@/components/dashboard/config-card';
import { TradeActivity } from '@/components/dashboard/trade-activity';
import { ProcessViewer } from '@/components/dashboard/process-viewer';
import { PriceChart } from '@/components/dashboard/price-chart';
import { EquityCurve } from '@/components/dashboard/equity-curve';
import { PnlChart } from '@/components/dashboard/pnl-chart';
import { PatternPerformance } from '@/components/dashboard/pattern-performance';
import { AiImpactChart } from '@/components/dashboard/ai-impact-chart';
import { PortfolioDonut } from '@/components/dashboard/portfolio-donut';
import { StaggerContainer, FadeUpItem } from '@/components/dashboard/motion-wrappers';

export default function HomePage() {
  return (
    <DashboardLayout>
      <StaggerContainer className="space-y-3">
        {/* Row 1: Market Ticker Strip */}
        <FadeUpItem>
          <MarketTicker />
        </FadeUpItem>

        {/* Row 2: Agent Flow - the hero visualization */}
        <FadeUpItem>
          <AgentFlow />
        </FadeUpItem>

        {/* Row 3: Main Grid - Portfolio + Chart + Signals */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-3">
            {/* Left: Portfolio + Allocation */}
            <div className="col-span-12 lg:col-span-3 space-y-3">
              <PortfolioCard />
              <PortfolioDonut />
              <PositionsCard />
            </div>

            {/* Center: Price Chart with trade markers */}
            <div className="col-span-12 lg:col-span-6">
              <PriceChart />
            </div>

            {/* Right: Signals + Config */}
            <div className="col-span-12 lg:col-span-3 space-y-3">
              <SignalPipeline />
              <ConfigCard />
            </div>
          </div>
        </FadeUpItem>

        {/* Row 4: Analytics Grid - 4 charts */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 lg:col-span-3">
              <EquityCurve />
            </div>
            <div className="col-span-12 lg:col-span-3">
              <PnlChart />
            </div>
            <div className="col-span-12 lg:col-span-3">
              <PatternPerformance />
            </div>
            <div className="col-span-12 lg:col-span-3">
              <AiImpactChart />
            </div>
          </div>
        </FadeUpItem>

        {/* Row 5: Process Log + Activity */}
        <FadeUpItem>
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 lg:col-span-8">
              <ProcessViewer />
            </div>
            <div className="col-span-12 lg:col-span-4 space-y-3">
              <TradeActivity />
              <HealthGrid />
            </div>
          </div>
        </FadeUpItem>
      </StaggerContainer>
    </DashboardLayout>
  );
}
