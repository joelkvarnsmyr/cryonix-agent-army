"use client";

function fmt(price: number) {
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(3);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

interface PositionTpSlBarProps {
  entry: number;
  current: number;
  /** Explicit SL price — takes priority over slPct */
  slPrice?: number;
  /** Explicit TP price — takes priority over tpPct */
  tpPrice?: number;
  /** SL as percentage below entry (e.g. 4 = 4%) — used as fallback */
  slPct?: number;
  /** TP as percentage above entry (e.g. 8 = 8%) — used as fallback */
  tpPct?: number;
}

export function PositionTpSlBar({
  entry,
  current,
  slPrice,
  tpPrice,
  slPct = 4,
  tpPct = 8,
}: PositionTpSlBarProps) {
  const sl = slPrice ?? entry * (1 - slPct / 100);
  const tp = tpPrice ?? entry * (1 + tpPct / 100);
  const range = tp - sl;
  if (range <= 0 || entry <= 0) return null;

  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const entryPct  = clamp(((entry   - sl) / range) * 100);
  const currentPct = clamp(((current - sl) / range) * 100);
  const isProfitable = current >= entry;

  // Progress toward TP from entry (0–100%)
  const progressToTp = clamp(((current - entry) / (tp - entry)) * 100);
  // Progress toward SL from entry (0–100%)
  const progressToSl = clamp(((entry - current) / (entry - sl)) * 100);

  return (
    <div className="mt-2.5 space-y-1">

      {/* Bar */}
      <div className="relative h-1.5 rounded-full bg-white/[0.05] overflow-visible">

        {/* SL zone — red fill from left up to entry */}
        <div
          className="absolute inset-y-0 left-0 rounded-l-full bg-red-500/15"
          style={{ width: `${entryPct}%` }}
        />

        {/* TP zone — green fill from entry to right */}
        <div
          className="absolute inset-y-0 rounded-r-full bg-emerald-500/15"
          style={{ left: `${entryPct}%`, right: 0 }}
        />

        {/* Active fill between entry and current */}
        {isProfitable ? (
          <div
            className="absolute inset-y-0 bg-emerald-500/40 transition-all"
            style={{ left: `${entryPct}%`, width: `${(progressToTp / 100) * (100 - entryPct)}%` }}
          />
        ) : (
          <div
            className="absolute inset-y-0 bg-red-500/40 transition-all"
            style={{ right: `${100 - entryPct}%`, width: `${(progressToSl / 100) * entryPct}%` }}
          />
        )}

        {/* Entry marker — thin white tick */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-white/25"
          style={{ left: `${entryPct}%` }}
        />

        {/* Current price dot */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border transition-all ${
            isProfitable
              ? 'bg-emerald-400 border-emerald-300/40 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
              : 'bg-red-400 border-red-300/40 shadow-[0_0_6px_rgba(248,113,113,0.6)]'
          }`}
          style={{ left: `calc(${currentPct}% - 5px)` }}
        />
      </div>

      {/* Labels */}
      <div className="flex justify-between items-center">
        <span className="text-[9px] font-mono text-red-400/60">SL ${fmt(sl)}</span>
        <span className={`text-[9px] font-mono ${isProfitable ? 'text-emerald-400/70' : 'text-muted-foreground/40'}`}>
          {isProfitable ? `+${progressToTp.toFixed(0)}% to TP` : `-${progressToSl.toFixed(0)}% to SL`}
        </span>
        <span className="text-[9px] font-mono text-emerald-400/60">TP ${fmt(tp)}</span>
      </div>

    </div>
  );
}
