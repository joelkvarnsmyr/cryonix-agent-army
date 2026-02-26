import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import { StatCard } from '@/components/stat-card';
import { PatternTable } from '@/components/pattern-table';
import { TelegramBanner } from '@/components/telegram-banner';
import { fetchStats } from '@/lib/api';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'performance' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export const revalidate = 300;

export default async function PerformancePage() {
  const t = await getTranslations('performance');

  let stats = {
    totalTrades: 0,
    winRate: 0,
    avgHoldingTimeH: 0,
    patterns: [] as any[],
  };

  try {
    stats = await fetchStats();
  } catch {
    // API not available
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "name": "Cryonix Trading Performance Data",
    "description": "Real-time win rate, profit factor, and strategy statistics for Cryonix crypto signals.",
    "url": "https://cryonix.ai/performance",
    "creator": {
      "@type": "Organization",
      "name": "Cryonix"
    },
    "variableMeasured": [
      {
        "@type": "PropertyValue",
        "name": "Win Rate",
        "value": stats.winRate
      },
      {
        "@type": "PropertyValue",
        "name": "Total Trades",
        "value": stats.totalTrades
      }
    ]
  };

  if (stats.totalTrades === 0) {
    return (
      <div className="py-12 md:py-16">
        <div className="container space-y-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold">{t('title')}</h1>
            <p className="text-muted-foreground mt-2">{t('subtitle')}</p>
          </div>
          <div className="glass-card rounded-xl p-12 text-center">
            <p className="text-muted-foreground">{t('empty')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="py-12 md:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="container space-y-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-glow-cyan">{t('title')}</h1>
            <p className="text-muted-foreground mt-2">{t('subtitle')}</p>
          </div>
          
          <div className="glass-card px-6 py-4 rounded-2xl border-primary/20 bg-primary/5 max-w-sm">
            <h3 className="text-sm font-bold text-primary mb-1 flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              {t('level_banner.title')}
            </h3>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t('level_banner.desc')}
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <StatCard
            label={t('total_trades')}
            value={stats.totalTrades}
          />
          <StatCard
            label={t('win_rate')}
            value={stats.winRate}
            suffix="%"
          />
          <StatCard
            label={t('avg_hold')}
            value={stats.avgHoldingTimeH}
            suffix="h"
          />
        </div>

        <PatternTable patterns={stats.patterns} />

        <TelegramBanner />
      </div>
    </div>
  );
}
