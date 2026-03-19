"use client";

interface SystemHealthGridProps {
  instances: Array<{
    id: string;
    label: string;
    accent: string;
    status: 'online' | 'offline' | 'degraded';
    openPositions: number;
    totalTrades: number;
  }>;
}

export function SystemHealthGrid({ instances }: SystemHealthGridProps) {
  const online = instances.filter(i => i.status === 'online').length;

  return (
    <div className="glass-card rounded-xl p-4 border border-border/20">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono font-bold text-muted-foreground/70 tracking-widest uppercase">
          System Health
        </h3>
        <span className={`text-[9px] font-mono px-2 py-0.5 rounded ${
          online === instances.length ? 'bg-emerald-400/10 text-emerald-400' : 'bg-amber-400/10 text-amber-400'
        }`}>
          {online}/{instances.length} ONLINE
        </span>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {instances.map((inst) => (
          <div key={inst.id} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-muted/10">
            <span className={`h-2.5 w-2.5 rounded-full ${
              inst.status === 'online' ? 'bg-emerald-400 animate-pulse-dot' :
              inst.status === 'degraded' ? 'bg-amber-400' : 'bg-zinc-500'
            }`} />
            <span className="text-[8px] font-mono font-bold text-muted-foreground/60 tracking-wider">
              {inst.label.slice(0, 3)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
