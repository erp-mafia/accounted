'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * One-time pill telling the user how many new PSD2-synced transactions
 * have arrived since they last visited /transactions. Helps make the
 * nightly cron visible without polling or pushing notifications.
 *
 * State lives in localStorage keyed per company. On mount:
 *  - If no previous visit recorded: store now, render nothing.
 *  - Else: count rows added since lastVisit. If > 0, show the pill.
 *  - On dismiss: write `now` to localStorage and hide.
 */
export default function BankSyncSinceLastVisit() {
  const t = useTranslations('transactions')
  const { company } = useCompany()
  const [count, setCount] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!company?.id) return
    if (typeof window === 'undefined') return

    const storageKey = `gnubok.lastTransactionsVisit.${company.id}`
    const lastVisitRaw = window.localStorage.getItem(storageKey)
    const now = new Date().toISOString()

    if (!lastVisitRaw) {
      window.localStorage.setItem(storageKey, now)
      return
    }

    let cancelled = false
    const supabase = createClient()
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company.id)
      .eq('import_source', 'enable_banking')
      .gt('created_at', lastVisitRaw)
      .then(({ count: rowCount }) => {
        if (cancelled) return
        if (rowCount && rowCount > 0) {
          setCount(rowCount)
        } else {
          // Nothing new — refresh the timestamp so we don't keep checking
          // the same window forever.
          window.localStorage.setItem(storageKey, now)
        }
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  if (dismissed || !count || count <= 0) return null

  function handleDismiss() {
    if (typeof window === 'undefined') return
    if (company?.id) {
      window.localStorage.setItem(
        `gnubok.lastTransactionsVisit.${company.id}`,
        new Date().toISOString(),
      )
    }
    setDismissed(true)
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">
      <span>
        {count === 1
          ? t('bank_sync_new_since_last_visit_one')
          : t('bank_sync_new_since_last_visit_many', { count })}
      </span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('bank_sync_new_since_last_visit_dismiss')}
        className="ml-1 rounded-sm p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
