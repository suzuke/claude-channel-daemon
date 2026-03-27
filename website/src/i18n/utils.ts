import en from './en.json';
import zhTw from './zh-tw.json';

const translations = { en, 'zh-tw': zhTw } as const;
export type Locale = keyof typeof translations;

export function t(locale: Locale, key: string): string {
  const keys = key.split('.');
  let val: any = translations[locale];
  for (const k of keys) {
    val = val?.[k];
  }
  return val ?? key;
}

export function langSwitchHref(locale: Locale, base: string = '/'): string {
  return locale === 'en' ? `${base}zh-tw/` : base;
}
