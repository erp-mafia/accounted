export const SUPPORTED_LOCALES = ['sv', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'sv'

export const LOCALE_COOKIE = 'gnubok-locale'

/**
 * Every timestamp in the app is a Swedish business event, so it is formatted
 * in Swedish wall-clock time in both locales. Without this, formatting falls
 * back to the runtime time zone: UTC on the server, the visitor's own zone in
 * the browser, which renders a 14:05 send as 12:05 and disagrees across the
 * hydration boundary.
 */
export const APP_TIME_ZONE = 'Europe/Stockholm'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
