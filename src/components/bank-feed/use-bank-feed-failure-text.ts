'use client'

import { useTranslations } from 'next-intl'

/**
 * The sentence for a refused or failed bank consent in the reader's language,
 * from the bank feed's own texts (messages bankFeed.*, word for word the
 * table in lib/bank-feed/failure-text.ts): the text for its code, then the
 * generic line, then the caller's fallback. The poll's failure_text is not
 * read: it is the Swedish of the same table (service.ts), so an English
 * reader got Swedish. Its own file so it reads one translation namespace, as
 * the message-key check expects (src/i18n/__tests__/message-keys.test.ts).
 */
export function useBankFeedFailureText(failure: { code: string | null } | null, fallback: string): string {
  const t = useTranslations('bankFeed')
  const code = failure?.code?.trim().toUpperCase()
  if (code && t.has(`failure.${code}`)) return t(`failure.${code}`)
  return t.has('failure_generic') ? t('failure_generic') : fallback
}
