import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Brain, Cpu, Zap, BarChart3, ChevronRight, Layers, Workflow } from 'lucide-react';
import Link from 'next/link';
import { RecommendedReading } from '@/components/recommended-reading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.ai_brain' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function AiBrainGuide() {
  const t = await getTranslations('guides.ai_brain');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/images/guides/ai-orchestration-architecture.jpg",
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
        "name": "AI Orchestration",
        "item": "https://cryonix.ai/guides/ai-orchestration-architecture"
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
          <span className="text-foreground font-medium text-glow-cyan">AI Orchestration</span>
        </nav>

        <header className="space-y-8 mb-16">
          <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
            <img 
              src="/images/guides/ai-orchestration-architecture.jpg" 
              alt={t('title')}
              className="object-cover w-full h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>

          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold uppercase tracking-wider">
              <Layers className="h-3 w-3" /> Architecture Deep-Dive
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
              {t('title')}
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground font-light leading-relaxed">
              {t('subtitle')}
            </p>
          </div>
        </header>

        <div className="prose prose-invert max-w-none">
          <p className="text-lg leading-relaxed mb-12">{t('intro')}</p>

          <div className="grid md:grid-cols-2 gap-8 my-16">
            <div className="glass-card p-8 rounded-3xl border-orange-500/20 bg-orange-500/5 relative overflow-hidden group">
              <div className="absolute -right-4 -top-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Zap className="h-32 w-32" />
              </div>
              <h3 className="text-2xl font-bold mb-4 flex items-center gap-3 text-orange-400">
                <Zap className="h-6 w-6" /> Grok (xAI)
              </h3>
              <p className="font-bold text-sm mb-4 uppercase tracking-widest opacity-60">Role: Market Sentiment Specialist</p>
              <p className="text-muted-foreground mb-6">Grok is uniquely integrated with real-time data from X. We use it to gauge market sentiment and identify emerging narratives before they hit the charts.</p>
              <ul className="space-y-2 text-sm m-0 p-0 list-none">
                <li className="flex items-center gap-2">✅ Social Sentiment Analysis</li>
                <li className="flex items-center gap-2">✅ Real-time News Impact</li>
                <li className="flex items-center gap-2">✅ Trend Early-Detection</li>
              </ul>
            </div>

            <div className="glass-card p-8 rounded-3xl border-purple-500/20 bg-purple-500/5 relative overflow-hidden group">
              <div className="absolute -right-4 -top-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Brain className="h-32 w-32" />
              </div>
              <h3 className="text-2xl font-bold mb-4 flex items-center gap-3 text-purple-400">
                <Brain className="h-6 w-6" /> Claude (Anthropic)
              </h3>
              <p className="font-bold text-sm mb-4 uppercase tracking-widest opacity-60">Role: Strategic Risk Analyst</p>
              <p className="text-muted-foreground mb-6">Claude's superior reasoning makes it the perfect gatekeeper for risk. It evaluates technical setups against our core trading principles.</p>
              <ul className="space-y-2 text-sm m-0 p-0 list-none">
                <li className="flex items-center gap-2">✅ Complex Risk Assessment</li>
                <li className="flex items-center gap-2">✅ Strategy Evolution Engine</li>
                <li className="flex items-center gap-2">✅ Technical Logic Validation</li>
              </ul>
            </div>
          </div>

          <h2 className="text-3xl font-bold mt-20 mb-8 flex items-center gap-3">
            <Workflow className="text-primary h-8 w-8" />
            The Self-Improvement Loop
          </h2>
          <p className="text-lg text-muted-foreground mb-12">Cryonix isn't a static algorithm. It's a living system that improves itself every 120 minutes based on real-world outcomes.</p>

          <div className="space-y-12 mb-20">
            <div className="flex flex-col md:flex-row gap-8 items-start">
              <div className="h-12 w-12 rounded-2xl bg-primary/20 flex items-center justify-center text-primary shrink-0 border border-primary/20">
                <BarChart3 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-2xl font-bold mb-3">Calibration Pipeline</h3>
                <p className="text-muted-foreground">The system automatically measures which patterns work in the current market regime. If a 'Dip Buy' pattern starts failing, the engine autonomously lowers its confidence threshold or pauses it entirely.</p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row gap-8 items-start">
              <div className="h-12 w-12 rounded-2xl bg-primary/20 flex items-center justify-center text-primary shrink-0 border border-primary/20">
                <Cpu className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-2xl font-bold mb-3">Autonomous Parameter Mutation</h3>
                <p className="text-muted-foreground">Our Evolution Engine runs every 2 hours, testing subtle variations of technical indicators. If a slightly faster RSI or a tighter Bollinger Band would have performed better over the last 48h, the system mutates its own config.</p>
              </div>
            </div>
          </div>

          <div className="bg-primary/10 border border-primary/20 rounded-3xl p-10 text-center relative overflow-hidden">
            <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]" />
            <h2 className="text-3xl font-bold mb-4 relative z-10">Transparent AI Trading</h2>
            <p className="mb-8 text-muted-foreground max-w-2xl mx-auto relative z-10">We believe in radical transparency. Every trade is attributed to the specific AI model and config version that generated it.</p>
            <div className="flex flex-wrap gap-4 justify-center relative z-10">
              <Link 
                href="/performance" 
                className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-3 rounded-xl font-bold transition-all shadow-[0_0_20px_rgba(var(--primary-rgb),0.3)]"
              >
                View Model Performance
              </Link>
            </div>
          </div>
        </div>

        <RecommendedReading currentSlug="ai-orchestration-architecture" />
      </article>
    </>
  );
}
