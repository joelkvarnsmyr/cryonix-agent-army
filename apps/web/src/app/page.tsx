import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { PortfolioSummary } from '@/components/dashboard/portfolio-summary';
// import { OrchestratorStatus } from '@/components/dashboard/orchestrator-status'; // Deprecated for TankMonitor
import { TankMonitor } from '@/components/dashboard/tank-monitor';
import { RiskGateApproval } from '@/components/dashboard/risk-gate-approval';
import { AISignals } from '@/components/dashboard/ai-signals';
import { ActivePositions } from '@/components/dashboard/active-positions';
import { TradingChart } from '@/components/dashboard/trading-chart';
import { QuickTrade } from '@/components/dashboard/quick-trade';
import { ValueStats } from '@/components/dashboard/value-stats';


export default function HomePage() {
  return (
    <DashboardLayout>
      <div className="grid grid-cols-12 gap-4 h-full">
        {/* Left Sidebar - Status & Signals */}
        <div className="col-span-12 lg:col-span-3 space-y-4 overflow-y-auto">
          <ValueStats />
          <TankMonitor /> {/* Replaces OrchestratorStatus */}
          <PortfolioSummary />
          <AISignals />
        </div>

        {/* Main Area - Risk Gate & Chart */}
        <div className="col-span-12 lg:col-span-6 space-y-4">
          <RiskGateApproval />
          <TradingChart symbol="BTCUSDT" />
        </div>

        {/* Right Sidebar - Execution */}
        <div className="col-span-12 lg:col-span-3 space-y-4 overflow-y-auto">
          <QuickTrade /> {/* Warning: This executes immediately, bypassing Risk Gate for now */}
          <ActivePositions />
        </div>
      </div>
    </DashboardLayout>
  );
}
