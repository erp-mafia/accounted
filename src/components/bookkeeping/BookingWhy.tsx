'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDownIcon } from '@/components/icons'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { Skeleton } from '@/components/ui/skeleton'
import { useBranding } from '@/lib/branding/brand-context'
import { useFormat } from '@/lib/hooks/use-format'
import { cn } from '@/lib/utils'
import { bookingWhy, type BookingWhyData, type BookingWhyView } from '@/lib/suggestion-log/receipt-display'
import { attributionWordsFrom } from '@/lib/attribution/format-actor'

/**
 * The decision behind one verifikat, from its decision receipts and commit
 * actor. Best-effort: a failed read renders nothing, the verifikat never
 * depends on it. Keyed by entry id so a re-pointed component never shows the
 * previous entry's answer while its own read is in flight.
 */
function useBookingWhyData(journalEntryId: string): { data: BookingWhyData | null; loading: boolean } {
  const [loaded, setLoaded] = useState<{ id: string; data: BookingWhyData | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let data: BookingWhyData | null = null
      try {
        const res = await fetch(`/api/bookkeeping/journal-entries/${journalEntryId}/decision-receipts`)
        if (res.ok) data = ((await res.json()) as { data?: BookingWhyData }).data ?? null
      } catch {
        // Silent: see above.
      }
      if (!cancelled) setLoaded({ id: journalEntryId, data })
    })()
    return () => {
      cancelled = true
    }
  }, [journalEntryId])

  const current = loaded?.id === journalEntryId ? loaded : null
  return { data: current?.data ?? null, loading: current === null }
}

function useBookingWhy(journalEntryId: string): { view: BookingWhyView | null; loading: boolean } {
  const { data, loading } = useBookingWhyData(journalEntryId)
  const t = useTranslations('booking_why')
  const tAttribution = useTranslations('attribution')
  const { formatDateLong } = useFormat()
  const { appName } = useBranding()
  if (!data) return { view: null, loading }
  const words = attributionWordsFrom((key, values) => tAttribution(key, values))
  return { view: bookingWhy(data, { t: (key, values) => t(key, values), formatWhen: formatDateLong, appName, words }), loading }
}

function SummaryLine({ summary, className }: { summary: NonNullable<BookingWhyView['summary']>; className?: string }) {
  return (
    // data-ph-mask: the line names a person or a credential label.
    <p data-ph-mask="" className={className}>
      {summary.text}
      {summary.when && <span className="tabular-nums text-muted-foreground">{` · ${summary.when}`}</span>}
    </p>
  )
}

/**
 * "Därför bokades den så": who booked the verifikat, how and when, with the
 * recorded detail (decision, proposal, grounds, changes, checks, policy)
 * behind a disclosure that starts collapsed.
 *
 * `section`: its own quiet section on the verifikat page.
 * `inline`: the summary line alone, beside a link to the verifikat (Inkorg).
 */
export default function BookingWhy({
  journalEntryId,
  variant = 'section',
  className,
}: {
  journalEntryId: string
  variant?: 'section' | 'inline'
  className?: string
}) {
  const t = useTranslations('booking_why')
  const { view, loading } = useBookingWhy(journalEntryId)
  const [open, setOpen] = useState(false)
  const detailsId = useId()

  if (variant === 'inline') {
    if (!view?.summary) return null
    return <SummaryLine summary={view.summary} className={cn('text-[12.5px] text-muted-foreground', className)} />
  }

  if (loading) {
    return (
      <DetailSection kicker={t('title')} className={className}>
        <Skeleton className="h-5 w-72 max-w-full" />
      </DetailSection>
    )
  }
  if (!view?.summary) return null

  return (
    <DetailSection kicker={t('title')} className={className}>
      <SummaryLine summary={view.summary} className="text-sm" />
      {view.rows.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            className="mt-1 flex items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-10"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-180')}
            />
            {open ? t('hide_details') : t('show_details')}
          </button>
          <div id={detailsId} hidden={!open} className="animate-fade-in">
            {view.rows.map((row) => (
              <DefRow key={row.id} label={row.label}>
                {/* data-ph-mask: values carry names, labels and accounts. */}
                <div data-ph-mask="">
                  <span>{row.value}</span>
                  {row.items && row.items.length > 0 && (
                    <ul className="mt-1 space-y-1 text-xs tabular-nums text-muted-foreground">
                      {row.items.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </DefRow>
            ))}
          </div>
        </>
      )}
    </DetailSection>
  )
}
