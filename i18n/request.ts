import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './config'

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value
  const locale: Locale = isLocale(fromCookie) ? fromCookie : DEFAULT_LOCALE

  const messages = (await import(`../messages/${locale}.json`)).default

  return { locale, messages }
})
