import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PipelineHero } from '@/components/pipeline-hero';
import { IntelligenceLayers } from '@/components/intelligence-layers';
import { VsComparison } from '@/components/vs-comparison';
import { WhyFree } from '@/components/why-free';
import { RiskArchitecture } from '@/components/risk-architecture';
import { ClosedSignalCard } from '@/components/signal-card';
import { TelegramBanner } from '@/components/telegram-banner';
import { fetchSignals, fetchStats } from '@/lib/api';

export const revalidate = 60;

export default async function HomePage() {
  const t = await getTranslations();

  let closed: any[] = [];
  let winRate = 0;
  let totalTrades = 0;

  try {
    const [signals, stats] = await Promise.all([fetchSignals(), fetchStats()]);
    closed = signals.closed.slice(0, 3);
    winRate = stats.winRate;
    totalTrades = stats.totalTrades;
  } catch {
    // API not available yet — render empty state
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Cryonix",
    "operatingSystem": "Web",
    "applicationCategory": "FinanceApplication",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    },
    "description": t('hero.subtitle'),
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": "4.9",
      "reviewCount": "1240"
    }
  };

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Cryonix",
    "url": "https://cryonix.ai",
    "logo": "https://cryonix.ai/logo.png",
    "sameAs": [
      "https://twitter.com/cryonix_ai",
      "https://t.me/cryonixsignals"
    ]
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
      />

      {/* 1. Hero with animated pipeline */}
      <PipelineHero />

      {/* 2. Intelligence layers deep-dive */}
      <IntelligenceLayers />

      {/* 3. Risk architecture */}
      <RiskArchitecture />

      {/* 4. Cryonix vs VIP groups comparison */}
      <VsComparison />

      {/* 5. Why free */}
      <WhyFree />

      {/* 6. Signal preview */}
      {closed.length > 0 && (
        <section className="py-16">
          <div className="container">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold">{t('preview.title')}</h2>
              <Link
                href="/signals"
                className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
              >
                {t('preview.view_all')} <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="grid md:grid-cols-3 gap-4">
              {closed.map((s, i) => (
                <ClosedSignalCard key={i} signal={s} />
              ))}
            </div>
            {totalTrades > 0 && (
              <div className="mt-8 flex items-center justify-center gap-8 text-sm text-muted-foreground">
                <span>
                  <span className="font-mono font-bold text-foreground">{totalTrades}</span> trades
                </span>
                <span>
                  <span className="font-mono font-bold text-success">{winRate}%</span> win rate
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 7. CTA */}
      <TelegramBanner />
    </>
  );
}
