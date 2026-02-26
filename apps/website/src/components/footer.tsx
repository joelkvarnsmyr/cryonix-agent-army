import { useTranslations } from 'next-intl';
import { Activity, Twitter, Send, MessageCircle } from 'lucide-react';
import Link from 'next/link';

export function Footer() {
  const t = useTranslations();

  return (
    <footer className="border-t border-border/40 py-16 mt-20 bg-black/20">
      <div className="container">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-12 mb-16">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1 space-y-6">
            <div className="flex items-center gap-2 font-bold text-xl text-glow-cyan">
              <Activity className="h-6 w-6 text-primary" />
              <span>Cryonix</span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Autonomous crypto trading signals powered by specialized AI models and radical transparency.
            </p>
            <div className="flex items-center gap-3">
              <a
                href="https://twitter.com/cryonix_ai"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Follow Cryonix on Twitter"
                className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
              >
                <Twitter className="h-5 w-5" />
              </a>
              <a
                href="https://t.me/cryonixsignals"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join Cryonix Telegram channel"
                className="p-2 rounded-lg text-muted-foreground hover:text-[#2AABEE] hover:bg-[#2AABEE]/10 transition-all"
              >
                <Send className="h-5 w-5" />
              </a>
              <a
                href="https://discord.gg/cryonix"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join Cryonix Discord server"
                className="p-2 rounded-lg text-muted-foreground hover:text-[#5865F2] hover:bg-[#5865F2]/10 transition-all"
              >
                <MessageCircle className="h-5 w-5" />
              </a>
            </div>
          </div>

          {/* Platform */}
          <div>
            <h4 className="font-bold mb-6 text-sm uppercase tracking-widest text-primary">Platform</h4>
            <ul className="space-y-4 text-sm">
              <li><Link href="/signals" className="text-muted-foreground hover:text-foreground transition-colors">Live Signals</Link></li>
              <li><Link href="/performance" className="text-muted-foreground hover:text-foreground transition-colors">Historical Stats</Link></li>
              <li><Link href="/guides" className="text-muted-foreground hover:text-foreground transition-colors">Expert Guides</Link></li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="font-bold mb-6 text-sm uppercase tracking-widest text-primary">Resources</h4>
            <ul className="space-y-4 text-sm">
              <li><Link href="/guides" className="text-muted-foreground hover:text-foreground transition-colors">Expert Guides</Link></li>
              <li><Link href="/guides/mcp-server-setup" className="text-muted-foreground hover:text-foreground transition-colors">MCP Setup</Link></li>
              <li><Link href="/guides/open-claw-setup" className="text-muted-foreground hover:text-foreground transition-colors">Open Claw Guide</Link></li>
            </ul>
          </div>

          {/* Community */}
          <div>
            <h4 className="font-bold mb-6 text-sm uppercase tracking-widest text-primary">Community</h4>
            <ul className="space-y-4 text-sm">
              <li>
                <a
                  href="https://t.me/cryonixsignals"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-muted-foreground hover:text-[#2AABEE] transition-colors"
                >
                  <Send className="h-3.5 w-3.5" />
                  Telegram Channel
                </a>
              </li>
              <li>
                <a
                  href="https://discord.gg/cryonix"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-muted-foreground hover:text-[#5865F2] transition-colors"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  Discord Server
                </a>
              </li>
              <li>
                <a
                  href="https://twitter.com/cryonix_ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Twitter className="h-3.5 w-3.5" />
                  Twitter / X
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-border/20 flex flex-col md:flex-row justify-between gap-6 items-start md:items-center">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground/60 max-w-2xl italic">
              {t('footer.disclaimer')}
            </p>
            <p className="text-[10px] text-muted-foreground/40 font-mono">
              &copy; {new Date().getFullYear()} Cryonix. {t('footer.powered')}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
