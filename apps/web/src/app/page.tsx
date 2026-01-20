import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PortfolioSummary } from '@/components/dashboard/portfolio-summary';
import { AISignals } from '@/components/dashboard/ai-signals';
import { ActivePositions } from '@/components/dashboard/active-positions';
import { TradingChart } from '@/components/dashboard/trading-chart';
import { QuickTrade } from '@/components/dashboard/quick-trade';

export default function HomePage() {
  return (
    <DashboardLayout>
      <div className="grid grid-cols-12 gap-4 h-full">
        {/* Left Sidebar - Signals & Chat */}
        <div className="col-span-12 lg:col-span-3 space-y-4 overflow-y-auto">
          <PortfolioSummary />
          <AISignals />
        </div>

        {/* Main Area - Chart */}
        <div className="col-span-12 lg:col-span-6 space-y-4">
          <TradingChart symbol="BTCUSDT" />
        </div>

        {/* Right Sidebar - Quick Trade & Positions */}
        <div className="col-span-12 lg:col-span-3 space-y-4 overflow-y-auto">
          <QuickTrade />
          <ActivePositions />
        </div>
      </div>
    </DashboardLayout>
  );
}
