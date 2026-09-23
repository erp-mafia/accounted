'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Banknote, Landmark } from 'lucide-react'
import { DefRow } from '@/components/ui/detail-section'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { LinkedTransactionRef } from '@/lib/core/bookkeeping/journal-entry-transactions'

/**
 * Deep link to the händelse on the transactions page. `highlight` scrolls to
 * the row (and widens the view so a booked row is visible); skattekonto rows
 * also pin the source so the list is already narrowed to Skatteverket.
 */
export function linkedTransactionHref(ref: LinkedTransactionRef): string {
  const params = new URLSearchParams({ highlight: ref.id })
  if (ref.kind === 'skattekonto') params.set('source', 'skatteverket')
  return `/transactions?${params.toString()}`
}

/**
 * The bank transactions / skattekonto rows anchored to a verifikation.
 * Best-effort: a failed fetch reads as "no linked händelse", the verifikat
 * itself never depends on it.
 */
export function useLinkedTransactions(journalEntryId: string): LinkedTransactionRef[] {
  // Keyed by entry id so a re-pointed component never shows the previous
  // entry's händelser while its own fetch is in flight.
  const [loaded, setLoaded] = useState<{ id: string; links: LinkedTransactionRef[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/bookkeeping/journal-entries/${journalEntryId}/transactions`)
        if (!res.ok) return
        const json = (await res.json()) as { data?: { transactions?: LinkedTransactionRef[] } }
        if (!cancelled) setLoaded({ id: journalEntryId, links: json.data?.transactions ?? [] })
      } catch {
        // Silent: see above.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [journalEntryId])

  return loaded?.id === journalEntryId ? loaded.links : []
}

function signedAmount(ref: LinkedTransactionRef): string {
  return `${ref.amount > 0 ? '+' : ''}${formatCurrency(ref.amount, ref.currency ?? 'SEK')}`
}

/**
 * "Visa transaktion" from the verifikat side: the mirror of "Visa verifikat"
 * on the transactions page, so the verifieringskedja is followable in both
 * directions. Renders nothing for an entry with no linked händelse (a manual
 * voucher, an invoice registration), so the common case adds no noise.
 *
 * `inline`: one quiet line per händelse inside the list fold-out.
 * `detail`: a DefRow beside the other facts on the verifikat page.
 */
export default function JournalEntryTransactionLinks({
  journalEntryId,
  variant = 'inline',
}: {
  journalEntryId: string
  variant?: 'inline' | 'detail'
}) {
  const t = useTranslations('journal_transaction_links')
  const links = useLinkedTransactions(journalEntryId)

  if (links.length === 0) return null

  if (variant === 'detail') {
    return (
      <DefRow label={t('label')} className="items-baseline">
        <ul className="divide-y divide-border">
          {links.map((ref) => {
            const Icon = ref.kind === 'skattekonto' ? Landmark : Banknote
            return (
              <li key={`${ref.kind}-${ref.id}`} className="py-1 first:pt-0 last:pb-0">
                <Link
                  href={linkedTransactionHref(ref)}
                  className="inline-flex max-w-full items-center gap-2 hover:underline"
                  title={t('show')}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatDate(ref.date)}</span>
                  <span className="truncate" data-ph-mask>{ref.description}</span>
                  <span className={cn('shrink-0 tabular-nums', ref.amount > 0 && 'text-success')} data-ph-mask>
                    {signedAmount(ref)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </DefRow>
    )
  }

  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
      <span className="text-muted-foreground">{t('label')}</span>
      <ul className="min-w-0 flex-1 space-y-1">
        {links.map((ref) => (
          <li
            key={`${ref.kind}-${ref.id}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"
          >
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatDate(ref.date)}</span>
            <span className="truncate" data-ph-mask>{ref.description}</span>
            {ref.kind === 'skattekonto' && (
              <span className="shrink-0 text-muted-foreground">{t('skattekonto')}</span>
            )}
            <span className={cn('shrink-0 tabular-nums', ref.amount > 0 && 'text-success')} data-ph-mask>
              {signedAmount(ref)}
            </span>
            <Link href={linkedTransactionHref(ref)} className={QUIET_LINK_CLASS}>
              {t('show')}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
