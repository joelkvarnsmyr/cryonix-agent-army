import { defineRouting } from 'next-intl/routing';

export const locales = [
  'en', 'sv', 'de', 'fr', 'es', 'it', 'pt', 'nl',
  'pl', 'cs', 'ro', 'hu', 'fi', 'da', 'no', 'el',
  'bg', 'hr', 'sk', 'sl', 'lt', 'lv', 'et', 'ga', 'mt',
] as const;

export type Locale = (typeof locales)[number];

export const routing = defineRouting({
  locales,
  defaultLocale: 'en',
  localePrefix: 'as-needed',
});
