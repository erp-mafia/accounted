'use client'

import { useTranslations } from 'next-intl'

/**
 * The sentence for a refused or failed bank consent, from the bank feed's own
 * texts (messages bankFeed.*, shipped with the routes): the bank's text first,
 * then the text for its code, then the generic line, then the caller's
 * fallback. Its own file so it reads one translation namespace, as the
 * message-key check expects (src/i18n/__tests__/message-keys.test.ts).
 */
export function useBankFeedFailureText(failure: { code: string | null; text: string | null } | null, fallback: string): string {
  const t = useTranslations('bankFeed')
  if (failure?.text) return failure.text
  const code = failure?.code
  if (code && t.has(`failure.${code}`)) return t(`failure.${code}`)
  return t.has('failure_generic') ? t('failure_generic') : fallback
}
