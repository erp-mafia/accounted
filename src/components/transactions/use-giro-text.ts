'use client'

import { useTranslations } from 'next-intl'
import { giroSentence, giroShortLabel, type GiroCounterparty } from '@/lib/transactions/giro-counterparty'

/**
 * The words for a giro reading (lib/transactions/giro-counterparty, crm#1204):
 * a short label beside the row's text and the drawer's sentence.
 */
export function useGiroText() {
  const t = useTranslations('tx_inbox_card')
  return {
    short: (reading: GiroCounterparty): string => {
      const label = giroShortLabel(reading)
      return typeof label === 'string' ? label : t(label.key, label.values)
    },
    sentence: (reading: GiroCounterparty): string => {
      const message = giroSentence(reading)
      return t(message.key, message.values)
    },
  }
}
