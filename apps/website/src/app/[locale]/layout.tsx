import type { Metadata } from 'next';
import { Outfit, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/../i18n/routing';
import { Header } from '@/components/header';
import { Footer } from '@/components/footer';
import '../globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://cryonix.ai';

  return {
    metadataBase: new URL(BASE_URL),
    title: {
      template: `%s | Cryonix`,
      default: t('title'),
    },
    description: t('description'),
    keywords: ['crypto signals', 'AI trading', 'bitcoin signals', 'trading bot', 'automated trading', 'crypto analysis', 'Grok AI', 'Claude AI', 'MCP server'],
    authors: [{ name: 'Cryonix Team' }],
    creator: 'Cryonix',
    publisher: 'Cryonix',
    formatDetection: {
      email: false,
      address: false,
      telephone: false,
    },
    alternates: {
      canonical: locale === 'en' ? '/' : `/${locale}`,
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, l === 'en' ? '/' : `/${l}`])
      ),
    },
    openGraph: {
      title: t('title'),
      description: t('description'),
      url: BASE_URL,
      siteName: 'Cryonix',
      images: [
        {
          url: '/og-image.jpg', // We should make sure this exists
          width: 1200,
          height: 630,
          alt: 'Cryonix - Autonomous Trading Signals',
        },
      ],
      locale: locale,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: t('title'),
      description: t('description'),
      creator: '@cryonix_ai',
      images: ['/og-image.jpg'],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as any)) {
    notFound();
  }

  const messages = await getMessages();

  return (
    <html lang={locale} className="dark">
      <body
        className={`${outfit.variable} ${jetbrainsMono.variable} font-sans min-h-screen flex flex-col`}
      >
        <NextIntlClientProvider messages={messages}>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
