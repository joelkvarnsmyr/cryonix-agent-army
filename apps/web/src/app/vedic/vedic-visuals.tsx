'use client';

// ── SVG Visualizations for Vedic Astrology Dashboard ─────────────────
// Animated moon phases, planet positions, signal indicators

// ── Moon Phase SVG ───────────────────────────────────────────────────

/** Renders an animated SVG moon showing the current phase (0-100%). */
export function MoonPhaseSvg({ phase, paksha, size = 48 }: { phase: number; paksha: string; size?: number }) {
  // Phase 0% = new moon, 50% = first quarter, 100% = full moon
  const r = size / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;

  // Illumination: convert phase% to how much is lit
  // 0% = fully dark, 100% = fully lit
  const illum = phase / 100;

  // Calculate the terminator curve
  // When illum < 0.5, it's a waxing crescent (right side lit)
  // When illum > 0.5, it's a waning (left side lit)
  const curveX = r * Math.cos(Math.PI * illum);

  const isWaxing = paksha === 'Shukla';
  const fillColor = isWaxing ? '#fbbf24' : '#71717a'; // amber for Shukla, zinc for Krishna
  const glowColor = isWaxing ? 'rgba(251,191,36,0.3)' : 'rgba(113,113,122,0.2)';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <defs>
        <radialGradient id="moonGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={glowColor} />
          <stop offset="100%" stopColor="transparent" />
        </radialGradient>
        <filter id="moonBlur">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1" />
        </filter>
      </defs>

      {/* Glow */}
      <circle cx={cx} cy={cy} r={r + 4} fill="url(#moonGlow)">
        <animate attributeName="r" values={`${r + 3};${r + 6};${r + 3}`} dur="4s" repeatCount="indefinite" />
      </circle>

      {/* Dark base */}
      <circle cx={cx} cy={cy} r={r} fill="#18181b" stroke="#3f3f46" strokeWidth="0.5" />

      {/* Illuminated portion */}
      <path
        d={`M ${cx} ${cy - r}
            A ${r} ${r} 0 0 ${isWaxing ? 1 : 0} ${cx} ${cy + r}
            A ${Math.abs(curveX)} ${r} 0 0 ${illum < 0.5 ? (isWaxing ? 0 : 1) : (isWaxing ? 1 : 0)} ${cx} ${cy - r}
            Z`}
        fill={fillColor}
        opacity="0.85"
        filter="url(#moonBlur)"
      />

      {/* Phase text */}
      <text x={cx} y={size - 1} textAnchor="middle" fontSize="7" fontFamily="monospace" fill="#a1a1aa">
        {phase.toFixed(0)}%
      </text>
    </svg>
  );
}

// ── Planet Glyph SVG ─────────────────────────────────────────────────

const PLANET_SYMBOLS: Record<string, { symbol: string; color: string }> = {
  Sun: { symbol: '☉', color: '#fbbf24' },
  Moon: { symbol: '☾', color: '#e2e8f0' },
  Mars: { symbol: '♂', color: '#ef4444' },
  Mercury: { symbol: '☿', color: '#a78bfa' },
  Jupiter: { symbol: '♃', color: '#f59e0b' },
  Venus: { symbol: '♀', color: '#34d399' },
  Saturn: { symbol: '♄', color: '#6b7280' },
  Rahu: { symbol: '☊', color: '#818cf8' },
  Ketu: { symbol: '☋', color: '#f472b6' },
};

/** A single planet glyph with optional retrograde indicator. */
export function PlanetGlyph({ planet, retrograde, size = 28 }: { planet: string; retrograde?: boolean; size?: number }) {
  const info = PLANET_SYMBOLS[planet] ?? { symbol: '?', color: '#71717a' };
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" className="shrink-0">
      <circle cx="14" cy="14" r="12" fill="none" stroke={info.color} strokeWidth="0.5" opacity="0.3" />
      <text x="14" y="17" textAnchor="middle" fontSize="14" fill={info.color} fontFamily="serif">
        {info.symbol}
      </text>
      {retrograde && (
        <text x="23" y="8" textAnchor="middle" fontSize="7" fill="#ef4444" fontFamily="monospace" fontWeight="bold">
          R
        </text>
      )}
    </svg>
  );
}

// ── Retrograde Planets Row ───────────────────────────────────────────

export function RetrogradePlanetsRow({ retrogrades }: { retrogrades: string[] }) {
  if (!retrogrades.length) return null;
  return (
    <div className="flex items-center gap-1">
      {retrogrades.map(p => (
        <PlanetGlyph key={p} planet={p} retrograde size={24} />
      ))}
      <span className="text-[10px] font-mono text-red-400/70 ml-1">retrograde</span>
    </div>
  );
}

// ── Zodiac Ring SVG ──────────────────────────────────────────────────

const ZODIAC_SIGNS = [
  { name: 'Aries', symbol: '♈', color: '#ef4444' },
  { name: 'Taurus', symbol: '♉', color: '#34d399' },
  { name: 'Gemini', symbol: '♊', color: '#fbbf24' },
  { name: 'Cancer', symbol: '♋', color: '#e2e8f0' },
  { name: 'Leo', symbol: '♌', color: '#f59e0b' },
  { name: 'Virgo', symbol: '♍', color: '#a78bfa' },
  { name: 'Libra', symbol: '♎', color: '#34d399' },
  { name: 'Scorpio', symbol: '♏', color: '#ef4444' },
  { name: 'Sagittarius', symbol: '♐', color: '#f59e0b' },
  { name: 'Capricorn', symbol: '♑', color: '#6b7280' },
  { name: 'Aquarius', symbol: '♒', color: '#818cf8' },
  { name: 'Pisces', symbol: '♓', color: '#f472b6' },
];

/** Shows the Lagna (Ascendant) sign highlighted in a zodiac ring. */
export function LagnaRingSvg({ lagnaSign, size = 100 }: { lagnaSign: string; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 14;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={r + 8} fill="none" stroke="#3f3f46" strokeWidth="0.5" />
      <circle cx={cx} cy={cy} r={r - 4} fill="none" stroke="#27272a" strokeWidth="0.5" />

      {/* Zodiac signs */}
      {ZODIAC_SIGNS.map((z, i) => {
        const angle = (i * 30 - 90) * (Math.PI / 180);
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        const isLagna = z.name === lagnaSign;

        return (
          <g key={z.name}>
            {isLagna && (
              <circle cx={x} cy={y} r="9" fill={`${z.color}20`} stroke={z.color} strokeWidth="1">
                <animate attributeName="r" values="9;11;9" dur="3s" repeatCount="indefinite" />
              </circle>
            )}
            <text
              x={x}
              y={y + 4}
              textAnchor="middle"
              fontSize={isLagna ? '12' : '9'}
              fill={isLagna ? z.color : '#52525b'}
              fontFamily="serif"
              fontWeight={isLagna ? 'bold' : 'normal'}
            >
              {z.symbol}
            </text>
          </g>
        );
      })}

      {/* Center label */}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="6" fill="#a1a1aa" fontFamily="monospace">
        LAGNA
      </text>
      <text x={cx} y={cy + 6} textAnchor="middle" fontSize="8" fill="#8b5cf6" fontFamily="monospace" fontWeight="bold">
        {lagnaSign}
      </text>
    </svg>
  );
}

// ── Signal Indicator ─────────────────────────────────────────────────

export function VedicSignalBadge({ score, label }: { score: number; label: string }) {
  const color = score >= 40 ? '#10b981' : score >= 15 ? '#6ee7b7' : score >= -15 ? '#6b7280' : score >= -40 ? '#f87171' : '#dc2626';
  const bg = score >= 15 ? 'bg-emerald-500/10 border-emerald-500/30' : score <= -15 ? 'bg-red-500/10 border-red-500/30' : 'bg-zinc-500/10 border-zinc-500/30';

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${bg}`}>
      <svg width="12" height="12" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="4" fill={color} opacity="0.3">
          <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="6" cy="6" r="2" fill={color} />
      </svg>
      <span className="text-[10px] font-mono font-semibold" style={{ color }}>
        {score > 0 ? '+' : ''}{score}
      </span>
      <span className="text-[10px] font-mono text-zinc-400">
        {label.replace('_', ' ')}
      </span>
    </div>
  );
}

// ── Dasha Indicator ──────────────────────────────────────────────────

const DASHA_COLORS: Record<string, string> = {
  Jupiter: '#f59e0b',
  Venus: '#34d399',
  Mercury: '#a78bfa',
  Rahu: '#818cf8',
  Mars: '#ef4444',
  Sun: '#fbbf24',
  Moon: '#e2e8f0',
  Saturn: '#6b7280',
  Ketu: '#f472b6',
};

export function DashaBadge({ lord, bias }: { lord: string; bias: number }) {
  const color = DASHA_COLORS[lord] ?? '#71717a';
  const info = PLANET_SYMBOLS[lord];

  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-violet-500/20 bg-violet-500/5">
      {info && (
        <span style={{ color }} className="text-sm font-serif">{info.symbol}</span>
      )}
      <span className="text-[10px] font-mono" style={{ color }}>{lord}</span>
      <span className={`text-[10px] font-mono ${bias > 0 ? 'text-emerald-400' : bias < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
        {bias > 0 ? '+' : ''}{bias.toFixed(1)}
      </span>
    </div>
  );
}

// ── Nakshatra Visualization ──────────────────────────────────────────

const NAKSHATRA_BIAS_COLOR: Record<string, string> = {
  bullish: '#10b981',
  neutral: '#6b7280',
  bearish: '#ef4444',
  volatile: '#f59e0b',
};

export function NakshatraBadge({ name, bias }: { name: string; bias?: string }) {
  const color = NAKSHATRA_BIAS_COLOR[bias ?? 'neutral'] ?? '#6b7280';

  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-700/40 bg-zinc-800/30">
      <svg width="10" height="10" viewBox="0 0 10 10">
        <polygon points="5,0 6.5,3.5 10,4 7.5,6.5 8,10 5,8 2,10 2.5,6.5 0,4 3.5,3.5" fill={color} opacity="0.7">
          <animateTransform attributeName="transform" type="rotate" from="0 5 5" to="360 5 5" dur="20s" repeatCount="indefinite" />
        </polygon>
      </svg>
      <span className="text-[10px] font-mono text-zinc-300">{name}</span>
    </div>
  );
}

// ── Current State Panel (combines all visuals) ───────────────────────

interface CurrentStateProps {
  score: number;
  label: string;
  moonPhase: number;
  paksha: string;
  nakshatra: string;
  lagnaSign: string;
  dashaLord: string;
  dashaBias: number;
  retrogrades: string[];
  mercuryRx: boolean;
  muhurta: string;
  tithi: string;
  tithiNumber: number;
}

export function CurrentStatePanel(props: CurrentStateProps) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-4">
      <div className="text-xs font-mono text-zinc-400 mb-3">Current Vedic State</div>

      <div className="flex flex-wrap items-start gap-4">
        {/* Moon phase */}
        <div className="flex flex-col items-center gap-1">
          <MoonPhaseSvg phase={props.moonPhase} paksha={props.paksha} size={56} />
          <span className="text-[10px] font-mono text-zinc-500">{props.paksha}</span>
          <span className="text-[10px] font-mono text-zinc-400">T#{props.tithiNumber} {props.tithi}</span>
        </div>

        {/* Lagna ring */}
        {props.lagnaSign && (
          <LagnaRingSvg lagnaSign={props.lagnaSign} size={90} />
        )}

        {/* Signals & badges */}
        <div className="flex flex-col gap-2 min-w-0">
          <VedicSignalBadge score={props.score} label={props.label} />
          <DashaBadge lord={props.dashaLord} bias={props.dashaBias} />
          <NakshatraBadge name={props.nakshatra} />

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-zinc-500">Muhurta:</span>
            <span className={`text-[10px] font-mono ${
              props.muhurta.includes('auspicious') ? 'text-emerald-400' :
              props.muhurta.includes('inauspicious') ? 'text-red-400' : 'text-zinc-300'
            }`}>
              {props.muhurta}
            </span>
          </div>

          {props.mercuryRx && (
            <div className="flex items-center gap-1.5">
              <PlanetGlyph planet="Mercury" retrograde size={20} />
              <span className="text-[10px] font-mono text-red-400 animate-pulse">MERCURY RETROGRADE</span>
            </div>
          )}

          {props.retrogrades.length > 0 && (
            <RetrogradePlanetsRow retrogrades={props.retrogrades} />
          )}
        </div>
      </div>
    </div>
  );
}
