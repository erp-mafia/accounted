'use client'

import { useLocale } from 'next-intl'
import { formatDateLong as formatDateLongRaw } from '@/lib/utils'

/**
 * Client-side hook returning locale-aware formatters.
 *
 * Currency stays SEK with sv-SE conventions (1 234,56 kr) regardless of UI
 * language: that's the Swedish accounting standard, not a UI string.
 * formatDate (ISO yyyy-MM-dd) is locale-independent and exported directly
 * from lib/utils.
 */
export function useFormat() {
  const locale = useLocale()
  return {
    locale,
    formatDateLong: (date: Date | string) => formatDateLongRaw(date, locale),
  }
}
