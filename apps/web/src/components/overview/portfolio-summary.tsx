"use client";

interface PortfolioSummaryProps {
  totalValue: number;
  dailyPnl: number;
  blendedWinRate: number;
  instancesOnline: number;
  instancesTotal: number;
}

export function PortfolioSummary({
  totalValue,
  dailyPnl,
  blendedWinRate,
  instancesOnline,
  instancesTotal,
}: PortfolioSummaryProps) {
  const pnlColor = dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400';
  const pnlPrefix = dailyPnl >= 0 ? '+' : '';

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {/* Total Portfolio */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Total Portfolio
        </p>
        <p className="text-2xl font-bold font-mono tabular-nums text-foreground">
          ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>

      {/* Daily P&L */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Daily P&L
        </p>
        <p className={`text-2xl font-bold font-mono tabular-nums ${pnlColor}`}>
          {pnlPrefix}${Math.abs(dailyPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>

      {/* Blended Win Rate */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Win Rate
        </p>
        <p className="text-2xl font-bold font-mono tabular-nums text-foreground">
          {blendedWinRate.toFixed(1)}%
        </p>
      </div>

      {/* Instances Online */}
      <div className="glass-card rounded-xl p-4 border border-border/20">
        <p className="text-[10px] font-mono text-muted-foreground/60 tracking-widest uppercase mb-1">
          Instances
        </p>
        <p className="text-2xl font-bold font-mono tabular-nums text-foreground">
          <span className="text-emerald-400">{instancesOnline}</span>
          <span className="text-muted-foreground/40">/{instancesTotal}</span>
        </p>
      </div>
    </div>
  );
}
