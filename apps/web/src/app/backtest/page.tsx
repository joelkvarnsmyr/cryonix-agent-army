import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { BacktestDashboard } from '@/components/dashboard/backtest-dashboard';
import { RiskDashboard } from '@/components/dashboard/risk-dashboard';

export default function BacktestPage() {
  return (
    <DashboardLayout>
      <div className="grid grid-cols-12 gap-4 h-full">
        {/* Left - Risk Dashboard */}
        <div className="col-span-12 lg:col-span-4 space-y-4 overflow-y-auto">
          <RiskDashboard />
        </div>

        {/* Main Area - Backtest Dashboard */}
        <div className="col-span-12 lg:col-span-8 space-y-4">
          <BacktestDashboard />
        </div>
      </div>
    </DashboardLayout>
  );
}
