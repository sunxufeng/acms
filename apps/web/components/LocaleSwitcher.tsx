'use client';

import { useLocale } from 'next-intl';

const LOCALES = [
  { code: 'zh', label: '中' },
  { code: 'en', label: 'EN' },
] as const;

export default function LocaleSwitcher() {
  const locale = useLocale();

  function switchTo(next: string) {
    if (next === locale) return;
    // Persist choice, then reload so server components re-render in the new locale.
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  }

  return (
    <div className="locale-switcher" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <button
          key={l.code}
          type="button"
          className={`locale-opt${locale === l.code ? ' active' : ''}`}
          onClick={() => switchTo(l.code)}
          aria-pressed={locale === l.code}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
