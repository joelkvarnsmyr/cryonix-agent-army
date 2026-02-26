import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ShieldX, AlertCircle, TrendingDown, ChevronRight, BarChart, Info, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guides.drawdown_truth' });

  return {
    title: t('title'),
    description: t('subtitle'),
  };
}

export default async function DrawdownTruthGuide() {
  const t = await getTranslations('guides.drawdown_truth');
  const navT = await getTranslations('nav');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": t('title'),
    "description": t('subtitle'),
    "image": "https://cryonix.ai/images/guides/the-drawdown-truth.jpg",
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
        "name": "The Drawdown Truth",
        "item": "https://cryonix.ai/guides/the-drawdown-truth"
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
        <span className="text-foreground font-medium text-glow-cyan text-xs uppercase tracking-widest">Risk Analysis</span>
      </nav>

      <header className="space-y-8 mb-16">
        <div className="aspect-video w-full rounded-3xl overflow-hidden border border-border/40 relative">
          <img 
            src="/images/guides/the-drawdown-truth.jpg" 
            alt={t('title')}
            className="object-cover w-full h-full"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
        </div>

        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-bold uppercase tracking-wider">
            <AlertCircle className="h-3 w-3" /> Reality Check
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

        <h2 className="text-3xl font-bold mt-16 mb-8 flex items-center gap-3">
          <TrendingDown className="text-red-500 h-8 w-8" />
          What VIP Groups Hide From You
        </h2>
        <p>In the world of leveraged futures trading, drawdowns (consecutive losses from peak to bottom) are inevitable. Yet, most signal groups like <em>Binance Killers</em> or <em>CryptoNinjas</em> focus exclusively on "wins" and "Monthly ROI" to sell memberships. Here is the reality of what happens behind the scenes:</p>
        
        <div className="grid md:grid-cols-2 gap-6 my-12">
          <div className="glass-card p-6 rounded-2xl border-border/40 bg-white/5">
            <h3 className="text-lg font-bold mb-4">Selective Reporting</h3>
            <p className="text-sm text-muted-foreground">Groups often post screenshots of "Partial Take Profits" as wins, even if the trade later hits a Stop Loss at breakeven. They hide the streaks of 5–10 losses that happen during choppy markets.</p>
          </div>
          <div className="glass-card p-6 rounded-2xl border-border/40 bg-white/5">
            <h3 className="text-lg font-bold mb-4">The Leverage Trap</h3>
            <p className="text-sm text-muted-foreground">Recommending 10x–20x leverage means a single "wick" or flash crash can wipe out 50–100% of a position. In 2025–2026, volatility is so high that leverage is practically a suicide mission for retail accounts.</p>
          </div>
        </div>

        <h2 className="text-3xl font-bold mt-20 mb-8">Can You Really Lose 70%?</h2>
        <p>Yes, absolutely. And it happens more often than they admit. Trustpilot reviews for major signal providers are filled with stories of users losing <strong>$5,000 in two weeks</strong> or seeing <strong>80% account drawdowns</strong> despite "94% accuracy" claims.</p>
        
        <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-8 my-12">
          <h3 className="text-xl font-bold text-red-400 mb-4">The Math of a Wipeout</h3>
          <p className="text-sm mb-4">If you use 5–10% account risk per trade (standard VIP advice) and hit a streak of 10 losses (common in crypto bear phases):</p>
          <div className="flex items-center gap-4 text-2xl font-mono font-bold text-red-500">
            <span>10 Losses</span>
            <span>×</span>
            <span>5% Risk</span>
            <span>=</span>
            <span>50% Drawdown</span>
          </div>
          <p className="text-xs text-muted-foreground mt-4 italic">*Note: This doesn't even account for slippage and exchange fees, which can add another 5–10% to the damage.*</p>
        </div>

        <h2 className="text-3xl font-bold mt-20 mb-8 flex items-center gap-3">
          <ShieldCheck className="text-green-500 h-8 w-8" />
          The Cryonix Defense: Built for Survival
        </h2>
        <p>Cryonix was built because we were tired of seeing traders get wiped out. Our system is architected differently to ensure you never face a 70% drawdown.</p>

        <div className="space-y-8 my-16">
          <div className="flex gap-6 items-start">
            <div className="h-12 w-12 rounded-xl bg-primary/20 flex items-center justify-center text-primary shrink-0 border border-primary/20">
              <ShieldX className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold mb-2">Spot-Only Mode by Default</h3>
              <p className="text-muted-foreground">We trade the underlying asset, not leveraged futures. There is <strong>zero liquidation risk</strong>. Even in a crash, your position value might dip, but your coins are still there.</p>
            </div>
          </div>

          <div className="flex gap-6 items-start">
            <div className="h-12 w-12 rounded-xl bg-primary/20 flex items-center justify-center text-primary shrink-0 border border-primary/20">
              <BarChart className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold mb-2">Strict 1.5% Risk Management</h3>
              <p className="text-muted-foreground">Our algorithms are hard-coded to never risk more than 1.5% of the allocated capital per trade. We prioritize small, compounding wins over "moon shots" that risk the house.</p>
            </div>
          </div>

          <div className="flex gap-6 items-start">
            <div className="h-12 w-12 rounded-xl bg-primary/20 flex items-center justify-center text-primary shrink-0 border border-primary/20">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold mb-2">Real-Time Loss Reporting</h3>
              <p className="text-muted-foreground">Check our performance page. You will see every loss, every breakeven, and every failed breakout. We don't edit messages. We don't delete history.</p>
            </div>
          </div>
        </div>

        <div className="bg-primary/10 border border-primary/20 rounded-3xl p-10 text-center">
          <h2 className="text-2xl font-bold mb-4">Stop Gambling. Start Trading.</h2>
          <p className="mb-8 text-muted-foreground max-w-2xl mx-auto">Trading with 20x leverage is a race to zero. Trading with AI-validated spot signals is a path to sustainable growth.</p>
          <Link 
            href="https://t.me/cryonixsignals" 
            className="inline-block bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-3 rounded-xl font-bold transition-all shadow-[0_0_20px_rgba(var(--primary-rgb),0.3)]"
          >
            Join the Free Channel
          </Link>
        </div>
      </div>
      
      <footer className="mt-20 pt-8 border-t border-border/40 text-sm text-muted-foreground flex items-center gap-2">
        <Info className="h-4 w-4" />
        <span>Financial Disclosure: Trading involves risk. Use only capital you can afford to lose.</span>
      </footer>
    </article>
    </>
  );
}
