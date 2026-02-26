import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ArrowRight, Send, MessageCircle } from 'lucide-react';

export function HeroSection() {
  const t = useTranslations('hero');

  return (
    <section className="relative overflow-hidden py-24 md:py-32">
      {/* Background effects */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[120px]" />

      <div className="container relative">
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            {t('badge')}
          </div>

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-glow-cyan">
            {t('title')}
          </h1>

          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            {t('subtitle')}
          </p>

          {/* CTAs: primary action + community buttons grouped */}
          <div className="flex flex-col items-center gap-4">
            {/* Primary CTA */}
            <Link
              href="/signals"
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-all shadow-[0_0_20px_hsl(191_100%_50%/0.2)] hover:shadow-[0_0_30px_hsl(191_100%_50%/0.35)]"
            >
              {t('cta_signals')}
              <ArrowRight className="h-4 w-4" />
            </Link>

            {/* Community CTAs side by side */}
            <div className="flex flex-row items-center gap-3">
              <a
                href="https://t.me/cryonixsignals"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join Cryonix Telegram channel"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-[#2AABEE]/30 bg-[#2AABEE]/5 text-[#2AABEE] text-sm font-medium hover:bg-[#2AABEE]/10 hover:border-[#2AABEE]/50 transition-all"
              >
                <Send className="h-4 w-4" />
                {t('cta_telegram')}
              </a>
              <a
                href="https://discord.gg/cryonix"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join Cryonix Discord server"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-[#5865F2]/30 bg-[#5865F2]/5 text-[#5865F2] text-sm font-medium hover:bg-[#5865F2]/10 hover:border-[#5865F2]/50 transition-all"
              >
                <MessageCircle className="h-4 w-4" />
                {t('cta_discord')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
