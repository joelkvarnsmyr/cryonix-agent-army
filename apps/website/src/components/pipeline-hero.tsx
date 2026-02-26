'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Send,
  MessageCircle,
  Activity,
  ScanLine,
  Brain,
  ShieldCheck,
  TrendingUp,
  Zap,
} from 'lucide-react';

const PIPELINE_NODES = [
  { key: 'scan', icon: ScanLine, color: 'cyan' },
  { key: 'pattern', icon: Activity, color: 'cyan' },
  { key: 'filter', icon: ShieldCheck, color: 'amber' },
  { key: 'ai', icon: Brain, color: 'violet' },
  { key: 'execute', icon: Zap, color: 'emerald' },
] as const;

function AnimatedCounter({ target, suffix = '', delay = 0 }: { target: number; suffix?: string; delay?: number }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const timeout = setTimeout(() => {
            const duration = 1800;
            const startTime = performance.now();
            const animate = (now: number) => {
              const elapsed = now - startTime;
              const progress = Math.min(elapsed / duration, 1);
              const eased = 1 - Math.pow(1 - progress, 3);
              setCount(Math.round(target * eased));
              if (progress < 1) requestAnimationFrame(animate);
            };
            requestAnimationFrame(animate);
          }, delay);
          return () => clearTimeout(timeout);
        }
      },
      { threshold: 0.3 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [target, delay]);

  return (
    <span ref={ref} className="font-mono tabular-nums">
      {count}
      {suffix}
    </span>
  );
}

function PipelinePulse() {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
      {/* Slow-moving scan lines */}
      <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent animate-[scan_8s_linear_infinite]" />
      <div className="absolute top-1/3 left-0 w-full h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent animate-[scan_12s_linear_infinite_2s]" />
      <div className="absolute top-2/3 left-0 w-full h-px bg-gradient-to-r from-transparent via-primary/15 to-transparent animate-[scan_10s_linear_infinite_4s]" />

      {/* Corner decorations */}
      <div className="absolute top-8 left-8 w-16 h-16 border-l border-t border-primary/15 rounded-tl-sm" />
      <div className="absolute top-8 right-8 w-16 h-16 border-r border-t border-primary/15 rounded-tr-sm" />
      <div className="absolute bottom-8 left-8 w-16 h-16 border-l border-b border-primary/15 rounded-bl-sm" />
      <div className="absolute bottom-8 right-8 w-16 h-16 border-r border-b border-primary/15 rounded-br-sm" />
    </div>
  );
}

export function PipelineHero() {
  const t = useTranslations();
  const [activeNode, setActiveNode] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveNode((prev) => (prev + 1) % PIPELINE_NODES.length);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative overflow-hidden py-20 md:py-28 lg:py-36">
      {/* Layered background */}
      <div className="absolute inset-0 dot-grid opacity-20" />
      <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.03] via-transparent to-transparent" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/[0.04] rounded-full blur-[150px]" />
      <PipelinePulse />

      <div className="container relative">
        <div className="max-w-4xl mx-auto text-center space-y-10">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-mono uppercase tracking-widest">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
            </span>
            {t('hero.badge')}
          </div>

          {/* Title */}
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1]">
            <span className="text-glow-cyan">{t('hero.title_line1')}</span>
            <br />
            <span className="text-muted-foreground">{t('hero.title_line2')}</span>
          </h1>

          {/* Subtitle */}
          <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            {t('hero.subtitle')}
          </p>

          {/* Animated pipeline strip */}
          <div className="flex items-center justify-center gap-1 sm:gap-2 md:gap-3 py-6">
            {PIPELINE_NODES.map((node, i) => {
              const Icon = node.icon;
              const isActive = i === activeNode;
              const isPast = i < activeNode;
              return (
                <div key={node.key} className="flex items-center gap-1 sm:gap-2 md:gap-3">
                  <div
                    className={`
                      relative flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-lg border transition-all duration-500
                      ${isActive
                        ? 'border-primary/60 bg-primary/10 shadow-[0_0_20px_hsl(191_100%_50%/0.2)] scale-110'
                        : isPast
                          ? 'border-primary/30 bg-primary/5'
                          : 'border-border/40 bg-card/30'
                      }
                    `}
                  >
                    <Icon
                      className={`h-4 w-4 sm:h-5 sm:w-5 transition-colors duration-500 ${
                        isActive ? 'text-primary' : isPast ? 'text-primary/60' : 'text-muted-foreground/40'
                      }`}
                    />
                    {isActive && (
                      <div className="absolute inset-0 rounded-lg border border-primary/40 animate-ping opacity-30" />
                    )}
                  </div>
                  {i < PIPELINE_NODES.length - 1 && (
                    <div className="relative w-6 sm:w-10 md:w-14 h-px">
                      <div className="absolute inset-0 bg-border/30" />
                      <div
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/60 to-primary/20 transition-all duration-700"
                        style={{ width: isPast || isActive ? '100%' : '0%' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pipeline labels */}
          <div className="flex items-center justify-center gap-3 sm:gap-6 md:gap-8 text-[10px] sm:text-xs font-mono text-muted-foreground/60 uppercase tracking-wider">
            {PIPELINE_NODES.map((node, i) => (
              <span
                key={node.key}
                className={`transition-colors duration-500 ${
                  i === activeNode ? 'text-primary' : i < activeNode ? 'text-muted-foreground/50' : ''
                }`}
              >
                {t(`hero.pipeline.${node.key}`)}
              </span>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
            <Link
              href="/signals"
              className="group inline-flex items-center gap-2 px-7 py-3.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-all shadow-[0_0_20px_hsl(191_100%_50%/0.15)] hover:shadow-[0_0_30px_hsl(191_100%_50%/0.25)]"
            >
              {t('hero.cta_signals')}
              <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <a
              href="https://t.me/cryonixsignals"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-7 py-3.5 rounded-lg border border-border hover:border-[#2AABEE]/40 text-foreground font-medium transition-all hover:bg-[#2AABEE]/5"
            >
              <Send className="h-4 w-4 text-[#2AABEE]" />
              {t('hero.cta_telegram')}
            </a>
            <a
              href="https://discord.gg/cryonix"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-7 py-3.5 rounded-lg border border-border hover:border-[#5865F2]/40 text-foreground font-medium transition-all hover:bg-[#5865F2]/5"
            >
              <MessageCircle className="h-4 w-4 text-[#5865F2]" />
              {t('hero.cta_discord')}
            </a>
          </div>
        </div>

        {/* Stats bar */}
        <div className="mt-16 md:mt-20 max-w-3xl mx-auto">
          <div className="glass-card rounded-2xl p-6 md:p-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
              {[
                { key: 'layers', value: 10, suffix: '' },
                { key: 'patterns', value: 8, suffix: '' },
                { key: 'filters', value: 12, suffix: '' },
                { key: 'uptime', value: 99, suffix: '%' },
              ].map((stat, i) => (
                <div key={stat.key} className="text-center space-y-1">
                  <div className="text-2xl md:text-3xl font-bold text-glow-cyan">
                    <AnimatedCounter target={stat.value} suffix={stat.suffix} delay={i * 200} />
                  </div>
                  <div className="text-[10px] md:text-xs font-mono text-muted-foreground uppercase tracking-wider">
                    {t(`hero.stats.${stat.key}`)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
