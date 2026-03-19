"use client";

const ACCENT_MAP: Record<string, string> = {
  cryonix: 'text-primary',
  vedic: 'text-purple-400',
  aktienix: 'text-violet-400',
  solanix: 'text-amber-400',
  polynix: 'text-orange-400',
  copynix: 'text-cyan-400',
  psinix: 'text-violet-400',
};

interface Trade {
  symbol: string;
  side: string;
  pnl: number;
  timestamp: string;
  instanceId: string;
  instanceLabel: string;
}

interface SignalActivityFeedProps {
  instances: Array<{
    id: string;
    label: string;
    recentTrades: Array<{
      symbol: string;
      side: string;
      pnl: number;
      timestamp: string;
    }>;
  }>;
}

function timeAgo(ts: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function SignalActivityFeed({ instances }: SignalActivityFeedProps) {
  // Merge all trades, sort by timestamp descending, take top 15
  const allTrades: Trade[] = instances
    .flatMap(inst =>
      inst.recentTrades.map(t => ({
        ...t,
        instanceId: inst.id,
        instanceLabel: inst.label,
      }))
    )
    .filter(t => t.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 15);

  return (
    <div className="glass-card rounded-xl p-4 border border-border/20">
      <h3 className="text-xs font-mono font-bold text-muted-foreground/70 tracking-widest uppercase mb-3">
        Recent Activity
      </h3>

      {allTrades.length === 0 ? (
        <p className="text-xs text-muted-foreground/40 font-mono">No recent trades</p>
      ) : (
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto scrollbar-none">
          {allTrades.map((trade, i) => (
            <div key={`${trade.instanceId}-${trade.timestamp}-${i}`} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/10 transition-colors">
              <span className={`text-[8px] font-mono font-bold tracking-wider ${ACCENT_MAP[trade.instanceId] ?? 'text-muted-foreground'}`}>
                {trade.instanceLabel.slice(0, 3)}
              </span>
              <span className={`text-[9px] font-mono font-medium px-1 py-0.5 rounded ${
                trade.side === 'SELL' ? 'bg-purple-500/10 text-purple-400' : 'bg-emerald-500/10 text-emerald-400'
              }`}>
                {trade.side}
              </span>
              <span className="text-xs font-mono font-medium text-foreground/80 flex-1">{trade.symbol}</span>
              {trade.pnl !== 0 && (
                <span className={`text-xs font-mono tabular-nums font-semibold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                </span>
              )}
              <span className="text-[9px] font-mono text-muted-foreground/35 tabular-nums w-6 text-right">
                {timeAgo(trade.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
