'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Menu, X, Send, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { LocaleSwitcher } from './locale-switcher';

export function Header() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = [
    { href: '/', label: t('home') },
    { href: '/signals', label: t('signals') },
    { href: '/performance', label: t('performance') },
    { href: '/guides', label: t('guides') },
  ];

  // Strip locale prefix for active check
  const pathWithoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '') || '/';

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-bold text-lg">
          <Activity className="h-5 w-5 text-primary" />
          <span className="text-glow-cyan">Cryonix</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-6">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm transition-colors hover:text-primary ${
                pathWithoutLocale === link.href
                  ? 'text-primary font-medium'
                  : 'text-muted-foreground'
              }`}
            >
              {link.label}
            </Link>
          ))}

          {/* Divider between page links and community links */}
          <div className="h-4 w-px bg-border/60" aria-hidden="true" />

          {/* Community icon links */}
          <div className="flex items-center gap-3">
            <a
              href="https://t.me/cryonixsignals"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Join Cryonix Telegram channel"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#2AABEE] hover:text-[#2AABEE]/80 transition-colors"
            >
              <Send className="h-4 w-4" />
              <span className="hidden lg:inline">Telegram</span>
            </a>
            <a
              href="https://discord.gg/cryonix"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Join Cryonix Discord server"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5865F2] hover:text-[#5865F2]/80 transition-colors"
            >
              <MessageCircle className="h-4 w-4" />
              <span className="hidden lg:inline">Discord</span>
            </a>
          </div>

          <LocaleSwitcher />
        </nav>

        {/* Mobile menu button */}
        <button
          onClick={() => setOpen(!open)}
          className="md:hidden p-2 text-muted-foreground hover:text-foreground"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile nav */}
      {open && (
        <nav className="md:hidden border-t border-border/40 bg-background/95 backdrop-blur-xl p-4 space-y-3">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`block text-sm py-1 ${
                pathWithoutLocale === link.href
                  ? 'text-primary font-medium'
                  : 'text-muted-foreground'
              }`}
            >
              {link.label}
            </Link>
          ))}

          {/* Community links with brand colors */}
          <div className="pt-2 border-t border-border/30 flex items-center gap-4">
            <a
              href="https://t.me/cryonixsignals"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Join Cryonix Telegram channel"
              className="inline-flex items-center gap-2 text-sm py-1 font-medium text-[#2AABEE]"
            >
              <Send className="h-4 w-4" />
              Telegram
            </a>
            <a
              href="https://discord.gg/cryonix"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Join Cryonix Discord server"
              className="inline-flex items-center gap-2 text-sm py-1 font-medium text-[#5865F2]"
            >
              <MessageCircle className="h-4 w-4" />
              Discord
            </a>
          </div>

          <div className="pt-2">
            <LocaleSwitcher />
          </div>
        </nav>
      )}
    </header>
  );
}
