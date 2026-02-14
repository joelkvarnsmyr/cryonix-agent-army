import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PortfolioCard } from '@/components/dashboard/portfolio-card';
import { PositionsCard } from '@/components/dashboard/positions-card';
import { SignalPipeline } from '@/components/dashboard/signal-pipeline';
import { AgentFlow } from '@/components/dashboard/agent-flow';
import { MarketTicker } from '@/components/dashboard/market-ticker';
import { TradingChart } from '@/components/dashboard/trading-chart';
import { HealthGrid } from '@/components/dashboard/health-grid';
import { ConfigCard } from '@/components/dashboard/config-card';
import { TradeActivity } from '@/components/dashboard/trade-activity';

export default function HomePage() {
  return (
    <DashboardLayout>
      <div className="space-y-3 stagger-children">
        {/* Row 1: Market Ticker Strip */}
        <MarketTicker />

        {/* Row 2: Agent Flow - the hero visualization */}
        <AgentFlow />

        {/* Row 3: Main Bento Grid */}
        <div className="grid grid-cols-12 gap-3">
          {/* Left: Portfolio + Positions */}
          <div className="col-span-12 lg:col-span-3 space-y-3">
            <PortfolioCard />
            <PositionsCard />
          </div>

          {/* Center: Chart */}
          <div className="col-span-12 lg:col-span-6">
            <TradingChart />
          </div>

          {/* Right: Signals + Config + Activity */}
          <div className="col-span-12 lg:col-span-3 space-y-3">
            <SignalPipeline />
            <ConfigCard />
          </div>
        </div>

        {/* Row 4: Bottom strip */}
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 lg:col-span-6">
            <TradeActivity />
          </div>
          <div className="col-span-12 lg:col-span-6">
            <HealthGrid />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
