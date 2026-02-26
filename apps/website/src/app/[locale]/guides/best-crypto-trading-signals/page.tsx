import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ChevronRight, CheckCircle2, AlertTriangle, Zap, TrendingUp, Info } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.best_signals' });

  return {
    title: t('title'),
    description: t('subtitle'),
    openGraph: {
      title: t('title'),
      description: t('subtitle'),
      type: 'article',
      publishedTime: '2026-02-25T00:00:00.000Z',
    },
  };
}

export default async function BestSignalsGuide() {
  const t = await getTranslations('guides.best_signals');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/og-image.jpg", // Placeholder
    "author": {
      "@type": "Organization",
      "name": "Cryonix"
    },
    "publisher": {
      "@type": "Organization",
      "name": "Cryonix",
      "logo": {
        "@type": "ImageObject",
        "url": "https://cryonix.ai/logo.png"
      }
    },
    "datePublished": "2026-02-25T00:00:00.000Z",
    "dateModified": "2026-02-25T00:00:00.000Z",
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": "https://cryonix.ai/guides/best-crypto-trading-signals"
    }
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
        "item": "https://cryonix.ai/guides/best-crypto-trading-signals"
      }
    ]
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "What are the best crypto signals on Telegram?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "The best crypto signals combine technical analysis with AI validation to reduce false positives. Cryonix provides free, real-time signals on Telegram with documented performance."
        }
      },
      {
        "@type": "Question",
        "name": "Are free crypto signals reliable?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Many free signals are 'pump and dump' schemes. However, transparent AI-driven platforms like Cryonix offer high-quality signals for free to build community trust."
        }
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <article className="py-12 md:py-20 max-w-4xl mx-auto px-4">
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-8">
          <Link href="/" className="hover:text-primary transition-colors">{navT('home')}</Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">{navT('guides')}</span>
        </nav>

        {/* Header */}
        <header className="space-y-8 mb-12">
          <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
            <img 
              src="/images/guides/best-crypto-trading-signals.jpg" 
              alt={t('title')}
              className="object-cover w-full h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>
          
          <div className="space-y-6">
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-glow-cyan leading-tight">
              {t('title')}
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground font-light leading-relaxed">
              {t('subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-4 pt-4 border-t border-border/40">
            <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium">By Cryonix Team</p>
              <p className="text-xs text-muted-foreground">Updated: Feb 25, 2026 • 8 min read</p>
            </div>
          </div>
        </header>

        {/* Intro */}
        <section className="prose prose-invert max-w-none">
          <p className="text-lg leading-relaxed mb-8">
            {t('intro')}
          </p>

          <div className="glass-card rounded-2xl p-6 md:p-8 my-12 border-primary/20 bg-primary/5">
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <TrendingUp className="text-primary h-6 w-6" />
              {t('why_ai')}
            </h2>
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h3 className="font-semibold text-primary flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> 
                  No Human Emotion
                </h3>
                <p className="text-sm text-muted-foreground">AI ignores FOMO and fear, sticking strictly to proven technical patterns.</p>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-primary flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> 
                  24/7 Market Scanning
                </h3>
                <p className="text-sm text-muted-foreground">Scans 45+ pairs every 10 seconds. Human traders need sleep; AI doesn't.</p>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-primary flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> 
                  Backtested Accuracy
                </h3>
                <p className="text-sm text-muted-foreground">Every strategy is validated against years of historical data before going live.</p>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-primary flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> 
                  Instant Execution
                </h3>
                <p className="text-sm text-muted-foreground">Signals are pushed to Telegram within milliseconds of detection.</p>
              </div>
            </div>
          </div>

          <h2 className="text-3xl font-bold mt-16 mb-6">{t('top_list')}</h2>
          <div className="space-y-8">
            {/* Rank 1: Cryonix */}
            <div className="glass-card rounded-xl overflow-hidden border-primary/50 relative">
              <div className="absolute top-0 right-0 bg-primary text-primary-foreground px-4 py-1 text-sm font-bold rounded-bl-xl">
                #1 Top Pick
              </div>
              <div className="p-6 md:p-8">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div>
                    <h3 className="text-2xl font-bold mb-2">Cryonix Signals</h3>
                    <div className="flex items-center gap-4 text-sm mb-4">
                      <span className="bg-green-500/10 text-green-500 px-2 py-0.5 rounded border border-green-500/20">Free</span>
                      <span className="text-muted-foreground">Strategy: AI + Multi-Pattern</span>
                    </div>
                  </div>
                  <Link 
                    href="https://t.me/cryonixsignals" 
                    className="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-3 rounded-lg font-bold text-center transition-all shadow-[0_0_20px_rgba(var(--primary-rgb),0.3)]"
                  >
                    Join Free Channel
                  </Link>
                </div>
                <div className="mt-6 pt-6 border-t border-border/40">
                  <p className="mb-4">Cryonix leads the market in 2026 by removing human bias entirely. Using a sophisticated stack of 8 technical patterns validated by a central AI brain, it offers institutional-grade signals for retail traders.</p>
                  <ul className="space-y-2">
                    <li className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                      <span>Verifiable 70%+ win rate on most pairs</span>
                    </li>
                    <li className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                      <span>Includes Stop Loss and Take Profit levels</span>
                    </li>
                    <li className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                      <span>Real-time performance dashboard</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Rank 2-5 placeholders or other names */}
            <div className="grid gap-4">
               {[
                 { name: "CryptoElite VIP", type: "Paid", focus: "Swing Trading" },
                 { name: "Fat Pig Signals", type: "Paid/Free", focus: "Altcoins" },
                 { name: "Binance Killers", type: "Paid", focus: "Futures" }
               ].map((item, i) => (
                 <div key={i} className="glass-card p-6 rounded-xl border-border/40 flex items-center justify-between">
                   <div>
                     <h4 className="font-bold">{i + 2}. {item.name}</h4>
                     <p className="text-xs text-muted-foreground">{item.type} • Focus: {item.focus}</p>
                   </div>
                   <div className="flex items-center gap-1 text-yellow-500">
                     {"★".repeat(5-i)}
                   </div>
                 </div>
               ))}
            </div>
          </div>

          <h2 className="text-3xl font-bold mt-20 mb-6">{t('how_to_choose')}</h2>
          <div className="space-y-6 mb-12">
            <p>Choosing a signal provider is the most critical decision in your trading journey. Avoid any group that:</p>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 flex gap-3">
                <AlertTriangle className="text-red-500 h-5 w-5 shrink-0" />
                <p className="text-sm">Promises 100% win rates (it's impossible)</p>
              </div>
              <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 flex gap-3">
                <AlertTriangle className="text-red-500 h-5 w-5 shrink-0" />
                <p className="text-sm">Has no verifiable performance history</p>
              </div>
              <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 flex gap-3">
                <AlertTriangle className="text-red-500 h-5 w-5 shrink-0" />
                <p className="text-sm">Does not provide SL/TP levels</p>
              </div>
              <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 flex gap-3">
                <AlertTriangle className="text-red-500 h-5 w-5 shrink-0" />
                <p className="text-sm">Asks for your private keys (SCAM!)</p>
              </div>
            </div>
          </div>

          <div className="bg-primary/10 border border-primary/20 rounded-2xl p-8 my-16 text-center">
            <h2 className="text-2xl font-bold mb-4">Start Trading with AI Today</h2>
            <p className="mb-8 text-muted-foreground">Join 10,000+ traders getting real-time signals powered by Cryonix.</p>
            <Link 
              href="https://t.me/cryonixsignals" 
              className="inline-block bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-4 rounded-full font-bold transition-all transform hover:scale-105"
            >
              Join Free Telegram Channel
            </Link>
          </div>

          <h2 className="text-3xl font-bold mt-20 mb-8">{t('faq')}</h2>
          <div className="space-y-6">
            <div className="border-b border-border/40 pb-6">
              <h3 className="text-lg font-bold mb-2">How much do these signals cost?</h3>
              <p className="text-muted-foreground">Cryonix signals are currently 100% free. We believe in building a strong community of traders who benefit from our technology before introducing premium tiers.</p>
            </div>
            <div className="border-b border-border/40 pb-6">
              <h3 className="text-lg font-bold mb-2">Which exchange should I use?</h3>
              <p className="text-muted-foreground">Our signals are compatible with all major exchanges like Binance, Bybit, OKX, and Coinbase. We recommend exchanges with high liquidity for the best execution.</p>
            </div>
            <div className="border-b border-border/40 pb-6">
              <h3 className="text-lg font-bold mb-2">Do I need a bot to trade these signals?</h3>
              <p className="text-muted-foreground">No, you can trade them manually via Telegram. However, we are working on API integrations for automated execution in the near future.</p>
            </div>
          </div>
        </section>

        <RecommendedReading currentSlug="best-crypto-trading-signals" />

        {/* Article Footer */}
        <footer className="mt-20 pt-8 border-t border-border/40 flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="h-4 w-4" />
            <span>Financial Disclaimer: Not financial advice.</span>
          </div>
          <div className="flex gap-4">
             {/* Social share icons could go here */}
          </div>
        </footer>
      </article>
    </>
  );
}
