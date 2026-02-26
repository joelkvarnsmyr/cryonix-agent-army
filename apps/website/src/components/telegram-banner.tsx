import { useTranslations } from 'next-intl';
import { Send, MessageCircle, Users } from 'lucide-react';

export function TelegramBanner() {
  const t = useTranslations('telegram');

  return (
    <section className="py-16">
      <div className="container">
        <div className="relative glass-card-elevated rounded-2xl p-8 md:p-12 text-center overflow-hidden">
          {/* Dual-tone gradient background reflecting both platforms */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#2AABEE]/5 via-transparent to-[#5865F2]/5" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/[0.02] to-transparent" />

          <div className="relative space-y-6">
            <div className="inline-flex items-center gap-2 text-primary">
              <Users className="h-5 w-5" />
            </div>

            <h2 className="text-2xl md:text-3xl font-bold">{t('title')}</h2>
            <p className="text-muted-foreground max-w-lg mx-auto leading-relaxed">
              {t('description')}
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <a
                href="https://t.me/cryonixsignals"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join Cryonix Telegram channel for free trading signals"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[#2AABEE] text-white font-medium hover:bg-[#2AABEE]/85 transition-all shadow-[0_0_20px_#2AABEE20] hover:shadow-[0_0_25px_#2AABEE35]"
              >
                <Send className="h-4 w-4" />
                {t('join')}
              </a>
              <a
                href="https://discord.gg/cryonix"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join Cryonix Discord server for community discussion"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[#5865F2] text-white font-medium hover:bg-[#5865F2]/85 transition-all shadow-[0_0_20px_#5865F220] hover:shadow-[0_0_25px_#5865F235]"
              >
                <MessageCircle className="h-4 w-4" />
                {t('join_discord')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
