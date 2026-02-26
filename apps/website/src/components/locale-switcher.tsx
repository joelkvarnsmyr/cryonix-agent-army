'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { Globe } from 'lucide-react';
import { locales } from '@/../../i18n/routing';

const LOCALE_NAMES: Record<string, string> = {
  en: 'English', sv: 'Svenska', de: 'Deutsch', fr: 'Francais',
  es: 'Espanol', it: 'Italiano', pt: 'Portugues', nl: 'Nederlands',
  pl: 'Polski', cs: 'Cestina', ro: 'Romana', hu: 'Magyar',
  fi: 'Suomi', da: 'Dansk', no: 'Norsk', el: 'Ellinika',
  bg: 'Bulgarski', hr: 'Hrvatski', sk: 'Slovencina', sl: 'Slovenscina',
  lt: 'Lietuviu', lv: 'Latviesu', et: 'Eesti', ga: 'Gaeilge', mt: 'Malti',
};

export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newLocale = e.target.value;
    // Strip current locale prefix and prepend new one
    const pathWithoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '') || '/';
    const newPath = newLocale === 'en' ? pathWithoutLocale : `/${newLocale}${pathWithoutLocale}`;
    router.push(newPath);
  }

  return (
    <div className="relative inline-flex items-center gap-1">
      <Globe className="h-4 w-4 text-muted-foreground" />
      <select
        value={locale}
        onChange={onChange}
        className="appearance-none bg-transparent text-sm text-muted-foreground hover:text-foreground cursor-pointer pr-4 focus:outline-none"
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l] || l.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}
