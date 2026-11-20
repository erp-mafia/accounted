'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import type { InvoiceReminderLadder } from '@/lib/reminders/invoice-ladder'
import { errorLocale, fetchInvoiceReminderLadder } from './reminders-client'

/**
 * The invoice's place on the daily ladder (GET /api/reminders/ladder), read
 * only while the page would otherwise promise the schedule: null until
 * known, and null on a failed read, so nothing is promised on a guess.
 * `version` reads it again (after a reminder went out, say).
 */
export function useInvoiceReminderLadder(invoiceId: string, enabled: boolean, version: number): InvoiceReminderLadder | null {
  const locale = errorLocale(useLocale())
  const [read, setRead] = useState<{ key: string; ladder: InvoiceReminderLadder | null } | null>(null)
  const key = `${invoiceId}|${version}`

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetchInvoiceReminderLadder(locale, invoiceId).then((call) => {
      if (!cancelled) setRead({ key, ladder: call.ok ? call.data : null })
    })
    return () => {
      cancelled = true
    }
  }, [enabled, invoiceId, key, locale])

  return enabled && read?.key === key ? read.ladder : null
}
