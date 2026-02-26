import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TrendingUp, BarChart2, Zap, Brain, ChevronRight, Info } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.bollinger_squeeze' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function BollingerSqueezeGuide() {
  const t = await getTranslations('guides.bollinger_squeeze');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/images/guides/bollinger-squeeze-ai.jpg",
    "author": {
      "@type": "Organization",
      "name": "Cryonix"
    },
    "publisher": {
      "@type": "Organization",
      "name": "Cryonix"
    },
    "datePublished": "2026-02-26T00:00:00.000Z"
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": navT('home'),
        "item": "https://cryonix.ai/"
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": navT('guides'),
        "item": "https://cryonix.ai/guides"
      },
      {
        "@type": "ListItem",
        "position": 3,
        "name": "Bollinger Squeeze AI",
        "item": "https://cryonix.ai/guides/bollinger-squeeze-ai"
      }
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <article className="py-12 md:py-20 max-w-4xl mx-auto px-4">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-8">
          <Link href="/" className="hover:text-primary transition-colors">{navT('home')}</Link>
          <ChevronRight className="h-4 w-4" />
          <Link href="/guides" className="hover:text-primary transition-colors">{navT('guides')}</Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Bollinger Squeeze AI</span>
        </nav>

        <header className="space-y-8 mb-12">
          <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
            <img 
              src="/images/guides/bollinger-squeeze-ai.jpg" 
              alt={t('title')}
              className="object-cover w-full h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>

          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-500 text-xs font-bold uppercase tracking-wider">
              <BarChart2 className="h-3 w-3" /> Technical Strategy
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-glow-cyan leading-tight">
              {t('title')}
            </h1>
            <p className="text-xl text-muted-foreground font-light leading-relaxed">
              {t('subtitle')}
            </p>
          </div>
        </header>

        <div className="prose prose-invert max-w-none">
          <p className="text-lg leading-relaxed mb-8">{t('intro')}</p>

          <h2 className="text-2xl font-bold mt-12 mb-6">What is a Bollinger Squeeze?</h2>
          <p>The Squeeze occurs when volatility falls to low levels and the Bollinger Bands contract. This often precedes a major price breakout. The longer the squeeze, the more explosive the resulting move is expected to be.</p>
          
          <div className="my-12 p-8 rounded-2xl bg-black/40 border border-border/40 font-mono text-sm">
            <div className="flex justify-between mb-4 border-b border-border/20 pb-2">
              <span className="text-muted-foreground">Indicator</span>
              <span className="text-muted-foreground">State</span>
            </div>
            <div className="flex justify-between py-2">
              <span>BB Bandwidth</span>
              <span className="text-yellow-500">&lt; 0.05 (Squeezing)</span>
            </div>
            <div className="flex justify-between py-2">
              <span>Volume</span>
              <span className="text-blue-400">Decreasing</span>
            </div>
            <div className="flex justify-between py-2">
              <span>Trend</span>
              <span className="text-primary">Consolidating</span>
            </div>
          </div>

          <h2 className="text-2xl font-bold mt-16 mb-6 flex items-center gap-2">
            <Brain className="text-primary h-6 w-6" />
            The AI Enhancement
          </h2>
          <p>A traditional Squeeze doesn't tell you the <strong>direction</strong> of the breakout. This is where Cryonix comes in. Our engine analyzes Sentiment Divergence, Whale Accumulation, and Multi-Timeframe Correlation to predict the breakout vector with high accuracy.</p>

          <div className="bg-primary/10 border border-primary/20 rounded-2xl p-8 my-16 flex flex-col items-center text-center">
            <TrendingUp className="h-12 w-12 text-primary mb-4" />
            <h2 className="text-2xl font-bold mb-4">Never Miss a Breakout Again</h2>
            <p className="mb-8 text-muted-foreground max-w-md">Our scanners monitor 45+ pairs 24/7 for the perfect squeeze. Let the AI do the waiting for you.</p>
            <Link 
              href="/signals" 
              className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-3 rounded-xl font-bold transition-all shadow-[0_0_20px_rgba(var(--primary-rgb),0.3)]"
            >
              View Live Scans
            </Link>
          </div>
        </div>
        
        <RecommendedReading currentSlug="bollinger-squeeze-ai" />

        <footer className="mt-20 pt-8 border-t border-border/40 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 mb-2">
            <Info className="h-4 w-4" />
            <span>Note: Bollinger Squeeze is a high-reward strategy but carries breakout risk. Always use Stop Loss.</span>
          </div>
        </footer>
      </article>
    </>
  );
}
