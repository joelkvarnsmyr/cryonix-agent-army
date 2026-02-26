'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  ScanLine,
  Layers,
  BarChart3,
  TrendingUp,
  Globe,
  Send,
  Twitter,
  Newspaper,
  Brain,
  Calculator,
  ChevronDown,
} from 'lucide-react';

const LAYER_ICONS = [
  ScanLine,     // QuantGuild
  Layers,       // Multi-Timeframe
  BarChart3,    // Smart Dip Hunter
  TrendingUp,   // GainerScanner
  Globe,        // CoinMarketCap
  Send,         // Telegram
  Twitter,      // X Sentiment
  Newspaper,    // News RSS
  Brain,        // GROK AI
  Calculator,   // EV Model
] as const;

function LayerCard({
  index,
  icon: Icon,
  isVisible,
}: {
  index: number;
  icon: typeof LAYER_ICONS[number];
  isVisible: boolean;
}) {
  const t = useTranslations('layers');
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`
        group relative transition-all duration-700
        ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}
      `}
      style={{ transitionDelay: `${index * 80}ms` }}
    >
      {/* Connector line */}
      {index > 0 && (
        <div className="absolute -top-4 left-6 w-px h-4 bg-gradient-to-b from-border/20 to-border/40" />
      )}

      <button
        onClick={() => setExpanded(!expanded)}
        className={`
          w-full text-left glass-card rounded-xl p-5 transition-all duration-300
          hover:border-primary/25
          ${expanded ? 'border-primary/30 bg-primary/[0.03]' : ''}
        `}
      >
        <div className="flex items-start gap-4">
          {/* Number + Icon */}
          <div className="flex-shrink-0 relative">
            <div className="absolute -top-1 -left-1 text-[10px] font-mono text-primary/50 tabular-nums">
              {String(index + 1).padStart(2, '0')}
            </div>
            <div
              className={`
                w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-300
                ${expanded ? 'bg-primary/15 text-primary' : 'bg-muted/40 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary/80'}
              `}
            >
              <Icon className="h-4.5 w-4.5" />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-sm md:text-base leading-tight">
                {t(`items.${index}.title`)}
              </h3>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform duration-300 ${
                  expanded ? 'rotate-180' : ''
                }`}
              />
            </div>
            <p className="text-xs md:text-sm text-muted-foreground mt-1 leading-relaxed">
              {t(`items.${index}.short`)}
            </p>

            {/* Expanded detail */}
            <div
              className={`overflow-hidden transition-all duration-400 ${
                expanded ? 'max-h-96 mt-3 opacity-100' : 'max-h-0 opacity-0'
              }`}
            >
              <div className="border-t border-border/30 pt-3 space-y-2">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t(`items.${index}.detail`)}
                </p>
                {/* Spec tags */}
                <div className="flex flex-wrap gap-1.5">
                  {(t.raw(`items.${index}.tags`) as string[]).map((tag: string) => (
                    <span
                      key={tag}
                      className="inline-flex px-2 py-0.5 rounded text-[10px] font-mono bg-primary/5 text-primary/70 border border-primary/10"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

export function IntelligenceLayers() {
  const t = useTranslations('layers');
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { threshold: 0.1 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="py-20 md:py-28 relative" ref={ref}>
      {/* Section background */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/[0.01] to-transparent" />

      <div className="container relative">
        {/* Section header */}
        <div className="max-w-2xl mb-12 md:mb-16">
          <div className="text-xs font-mono text-primary/60 uppercase tracking-widest mb-3">
            {t('label')}
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            {t('title')}
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            {t('subtitle')}
          </p>
        </div>

        {/* Two-column grid for layers */}
        <div className="grid md:grid-cols-2 gap-4">
          {LAYER_ICONS.map((Icon, i) => (
            <LayerCard key={i} index={i} icon={Icon} isVisible={visible} />
          ))}
        </div>
      </div>
    </section>
  );
}
