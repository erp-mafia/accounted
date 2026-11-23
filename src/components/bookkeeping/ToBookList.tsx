'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Badge } from '@/components/ui/badge'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table-classes'
import { ChevronRightIcon } from '@/components/icons'
import { inboxFocusHref } from '@/components/dashboard/StepItems'
import { INKORG_HREF, LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { bookingScreenHref } from '@/lib/bookkeeping/booking-screen'
import {
  inToBookFilter,
  opensInBookingScreen,
  toBookAmountLabel,
  toBookCounts,
  toBookFilterFromSlug,
  toBookIsMoneyIn,
  toBookListHref,
  TO_BOOK_FILTER_PARAM,
  TO_BOOK_FILTERS,
  type ToBookFilter,
  type ToBookRow,
} from '@/lib/bookkeeping/to-book'
import { useToBookRows } from './use-to-book-rows'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { cn, formatDate } from '@/lib/utils'

/**
 * Att bokföra (/att-bokfora): everything that waits to be booked, as one
 * list (lib/bookkeeping/to-book.ts). A bank row opens the booking screen; a
 * bank row with a document found for it, and a document with no bank row,
 * open that document in Inkommande, where the pair is confirmed or the
 * document is booked.
 */
export function ToBookList({ inkorgV2Enabled }: { inkorgV2Enabled: boolean }) {
  const t = useTranslations('to_book_list')
  const router = useRouter()
  // The filter lives in the address (?visa=), so the booking screen's way back
  // and its next row keep it.
  const filter = toBookFilterFromSlug(useSearchParams().get(TO_BOOK_FILTER_PARAM))
  const setFilter = (next: ToBookFilter) => router.replace(toBookListHref(next), { scroll: false })
  const { rows, loading, failed, retry } = useToBookRows()
  const { cashAccounts } = useCashAccounts()
  const inboxBase = inkorgV2Enabled ? INKORG_HREF : LEGACY_INBOX_HREF

  const counts = useMemo(() => toBookCounts(rows), [rows])
  const shown = rows.filter((r) => inToBookFilter(r, filter))
  const filterLabel: Record<ToBookFilter, string> = {
    all: t('filter_all'),
    missing: t('filter_missing'),
    found: t('filter_found'),
    no_bank: t('filter_no_bank'),
  }
  const accountName = (id: string | null) => cashAccounts.find((a) => a.id === id)?.name ?? null

  const hrefOf = (row: ToBookRow): string =>
    opensInBookingScreen(row)
      ? bookingScreenHref({ kind: 'transaction', transactionId: row.transactionId as string, account: null }, toBookListHref(filter))
      : inboxFocusHref(inboxBase, row.inboxItemId as string)

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} />

      <SegmentedControl
        aria-label={t('filter_label')}
        value={filter}
        onChange={setFilter}
        options={TO_BOOK_FILTERS.map((f) => ({ value: f, label: filterLabel[f], count: counts[f] }))}
      />

      {failed ? (
        <LoadError title={t('load_error')} onRetry={() => void retry()} />
      ) : loading ? (
        <LateReveal>
          <div className="space-y-1">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        </LateReveal>
      ) : shown.length === 0 ? (
        <EmptyState
          tone={filter === 'all' ? 'done' : 'empty'}
          title={filter === 'all' ? t('empty_all_title') : t('empty_filter_title')}
          description={filter === 'all' ? t('empty_all_description') : undefined}
        />
      ) : (
        <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_date')}</th>
                {/* w-full: the name takes the width the other columns leave, and truncates only past it. */}
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_what')}</th>
                <th className={TH_CLASS}>{t('col_payment')}</th>
                <th className={TH_CLASS}>{t('col_underlag')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                <th className={cn(TH_CLASS, 'w-8')} aria-hidden="true" />
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {shown.map((row) => (
                <tr key={row.key} className="group relative hover:bg-secondary/35">
                  <td className={cn(TD_CLASS, 'date-figures whitespace-nowrap text-muted-foreground')}>
                    {row.date ? formatDate(row.date) : ''}
                  </td>
                  <td className={cn(TD_CLASS, 'max-w-0 truncate')}>
                    {/* The whole row is the link: the name carries it, stretched over the row. */}
                    <Link href={hrefOf(row)} className="text-strong after:absolute after:inset-0" data-ph-mask="">
                      {row.name || t('unnamed')}
                    </Link>
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {row.kind === 'bank' ? (
                      <span className="text-foreground/80">{accountName(row.cashAccountId) ?? t('payment_bank')}</span>
                    ) : (
                      <Badge variant="secondary">{t('payment_none')}</Badge>
                    )}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {/* Missing is most rows, so it is muted text; the chip
                        marks the exception, a receipt found for the row. */}
                    {row.underlag === 'missing' ? (
                      <span className="text-muted-foreground">{t('underlag_missing')}</span>
                    ) : row.underlag === 'found' ? (
                      <Badge variant="outline">{t('underlag_found')}</Badge>
                    ) : (
                      <span className="text-foreground/80">
                        {row.underlag === 'attached' ? t('underlag_attached') : t('underlag_document')}
                      </span>
                    )}
                  </td>
                  <td
                    className={cn(
                      TD_CLASS,
                      'whitespace-nowrap text-right tabular-nums',
                      toBookIsMoneyIn(row) ? 'text-success' : 'text-strong',
                    )}
                    data-ph-mask=""
                  >
                    {toBookAmountLabel(row)}
                  </td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')} aria-hidden="true">
                    <ChevronRightIcon className="h-4 w-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
