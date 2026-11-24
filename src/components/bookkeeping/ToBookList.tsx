'use client'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
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
  bankRowMatchHref,
  inToBookFilter,
  suggestedJournalEntryId,
  toBookAmountLabel,
  toBookCounts,
  toBookFilterFromSlug,
  toBookIsMoneyIn,
  toBookListHref,
  toBookRowDoor,
  toBookScreenSubject,
  TO_BOOK_FILTER_PARAM,
  TO_BOOK_FILTERS,
  type ToBookFilter,
  type ToBookRow,
  type ToBookSuggestion,
} from '@/lib/bookkeeping/to-book'
import { useToBookRows } from './use-to-book-rows'
import type { SkattekontoTransactionWithSuggestion } from '@/types/skatteverket'
import type { MatchVoucherRow } from '@/components/transactions/MatchVoucherDialog'

// The skattekonto events book in the dialog Bankrader and the Skattekonto
// page use, loaded when one is opened.
const SkattekontoBookDialog = dynamic(() => import('@/components/skattekonto/SkattekontoBookDialog'))
const SkattekontoMatchDialog = dynamic(() =>
  import('@/components/skattekonto/SkattekontoMatchDialog').then((module) => module.SkattekontoMatchDialog),
)
// A bank row a verifikat already books is matched to it in the matcher
// Bankrader uses, loaded when one is opened.
const MatchVoucherDialog = dynamic(() =>
  import('@/components/transactions/MatchVoucherDialog').then((module) => module.MatchVoucherDialog),
)
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { cn, formatDate } from '@/lib/utils'

/**
 * Att bokföra (/att-bokfora): everything that waits to be booked, as one
 * list (lib/bookkeeping/to-book.ts). A bank row opens the booking screen,
 * with the receipt found for it held as its underlag; a bank row with an
 * invoice found for it, and a document with no bank row, open that document
 * in Inkommande, where the pair is confirmed or the document is booked. A
 * skattekonto event opens the skattekonto booking dialog here, as in Bankrader.
 * A bank row the product already has a match for names it beside the row and
 * opens where that match is confirmed (toBookRowDoor), not on the booking
 * screen.
 */
export function ToBookList({ inkorgV2Enabled }: { inkorgV2Enabled: boolean }) {
  const t = useTranslations('to_book_list')
  const router = useRouter()
  // The filter lives in the address (?visa=), so the booking screen's way back
  // and its next row keep it.
  const filter = toBookFilterFromSlug(useSearchParams().get(TO_BOOK_FILTER_PARAM))
  const setFilter = (next: ToBookFilter) => router.replace(toBookListHref(next), { scroll: false })
  const { rows, skattekonto, loading, failed, retry, refreshBankRows, refreshSkattekonto } = useToBookRows()
  // The bank row the matcher is open for, held as it was when opened: the
  // matcher reads its candidates again whenever the row it is given changes.
  const [matching, setMatching] = useState<{
    transaction: MatchVoucherRow
    preferredJournalEntryId: string | null
    note: string | null
  } | null>(null)
  const [skvBook, setSkvBook] = useState<SkattekontoTransactionWithSuggestion | null>(null)
  const [skvMatch, setSkvMatch] = useState<SkattekontoTransactionWithSuggestion | null>(null)
  const openSkattekonto = (id: string | null) => setSkvBook(skattekonto.rows.find((r) => r.id === id) ?? null)
  const { cashAccounts } = useCashAccounts()
  const inboxBase = inkorgV2Enabled ? INKORG_HREF : LEGACY_INBOX_HREF

  const counts = useMemo(() => toBookCounts(rows), [rows])
  const shown = rows.filter((r) => inToBookFilter(r, filter))
  const filterLabel: Record<ToBookFilter, string> = {
    all: t('filter_all'),
    missing: t('filter_missing'),
    found: t('filter_found'),
    suggested: t('filter_suggested'),
    no_bank: t('filter_no_bank'),
    skattekonto: t('filter_skattekonto'),
  }
  const accountName = (id: string | null) => cashAccounts.find((a) => a.id === id)?.name ?? null

  const hrefOf = (row: ToBookRow): string => {
    switch (toBookRowDoor(row)) {
      case 'bank_rows':
        return bankRowMatchHref(row.transactionId as string)
      case 'screen':
        return bookingScreenHref(toBookScreenSubject(row), toBookListHref(filter))
      default:
        return inboxFocusHref(inboxBase, row.inboxItemId as string, toBookListHref(filter))
    }
  }

  const suggestionLabel = (suggestion: ToBookSuggestion): string => {
    switch (suggestion.kind) {
      case 'invoice':
        return suggestion.number ? t('suggestion_invoice', { number: suggestion.number }) : t('suggestion_invoice_unnumbered')
      case 'supplier_invoice':
        return suggestion.number
          ? t('suggestion_supplier_invoice', { number: suggestion.number })
          : t('suggestion_supplier_invoice_unnumbered')
      case 'rot_rut':
        return t('suggestion_rot_rut')
      case 'expense_payout':
        return suggestion.name ? t('suggestion_expense_payout', { name: suggestion.name }) : t('suggestion_expense_payout_unnamed')
      case 'salary':
        return t('suggestion_salary', { period: suggestion.period })
      case 'voucher':
        return t('suggestion_voucher', { voucher: suggestion.voucher })
      case 'ledger':
        return t('suggestion_ledger')
    }
  }
  const matchNote = (suggestion: ToBookSuggestion | null): string | null => {
    if (suggestion?.kind === 'salary') return t('match_note_salary', { period: suggestion.period })
    if (suggestion?.kind === 'voucher') return t('match_note_voucher')
    return null
  }
  const openMatcher = (row: ToBookRow) => {
    if (!row.transactionId || !row.date || row.amount == null) return
    setMatching({
      transaction: {
        id: row.transactionId,
        date: row.date,
        amount: row.amount,
        currency: row.currency,
        description: row.name,
        cash_account_id: row.cashAccountId,
      },
      preferredJournalEntryId: suggestedJournalEntryId(row),
      note: matchNote(row.suggestion),
    })
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} />

      {/* Each chip keeps its label on one line, and the row scrolls on its
          own when it is wider than a phone: the page never grows wider than
          the screen. */}
      <div className="overflow-x-auto">
        <SegmentedControl
          aria-label={t('filter_label')}
          value={filter}
          onChange={setFilter}
          className="whitespace-nowrap"
          // Skattekonto and Att matcha are filters only where there are such rows.
          options={TO_BOOK_FILTERS.filter(
            (f) => (f !== 'skattekonto' && f !== 'suggested') || counts[f] > 0 || filter === f,
          ).map((f) => ({
            value: f,
            label: filterLabel[f],
            count: counts[f],
          }))}
        />
      </div>

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
          {/* On a phone (below sm) the row is Datum, Vad and Belopp: Betalning
              and Underlag hide, and the table drops its minimum width. */}
          <table className="w-full border-collapse text-sm sm:min-w-[720px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_date')}</th>
                {/* w-full: the name takes the width the other columns leave, and truncates only past it. */}
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_what')}</th>
                <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('col_payment')}</th>
                <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('col_underlag')}</th>
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
                  <td className={cn(TD_CLASS, 'max-w-0')}>
                    <div className="flex min-w-0 items-center gap-2">
                      {/* The whole row is the way in: the name carries it, stretched over the row. */}
                      {row.kind === 'skattekonto' || toBookRowDoor(row) === 'match_voucher' ? (
                        <button
                          type="button"
                          onClick={() => (row.kind === 'skattekonto' ? openSkattekonto(row.skattekontoId) : openMatcher(row))}
                          className="min-w-0 truncate text-left text-strong after:absolute after:inset-0"
                          data-ph-mask=""
                        >
                          {row.name || t('unnamed')}
                        </button>
                      ) : (
                        <Link
                          href={hrefOf(row)}
                          className="min-w-0 truncate text-strong after:absolute after:inset-0"
                          data-ph-mask=""
                        >
                          {row.name || t('unnamed')}
                        </Link>
                      )}
                      {/* The chip marks the exception: a row the product already has a match for. */}
                      {row.suggestion && (
                        <Badge variant="outline" className="shrink-0" data-ph-mask="">
                          {suggestionLabel(row.suggestion)}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className={cn(TD_CLASS, 'hidden whitespace-nowrap sm:table-cell')}>
                    {row.kind === 'bank' ? (
                      <span className="text-foreground/80">{accountName(row.cashAccountId) ?? t('payment_bank')}</span>
                    ) : row.kind === 'skattekonto' ? (
                      <span className="text-foreground/80">{t('payment_skattekonto')}</span>
                    ) : (
                      <Badge variant="secondary">{t('payment_none')}</Badge>
                    )}
                  </td>
                  <td className={cn(TD_CLASS, 'hidden whitespace-nowrap sm:table-cell')}>
                    {/* Missing is most rows, so it is muted text; the chip
                        marks the exception, a receipt found for the row. */}
                    {row.underlag === 'missing' ? (
                      <span className="text-muted-foreground">{t('underlag_missing')}</span>
                    ) : row.underlag === 'found' ? (
                      <Badge variant="outline">{t('underlag_found')}</Badge>
                    ) : (
                      <span className="text-foreground/80">
                        {row.underlag === 'attached'
                          ? t('underlag_attached')
                          : row.underlag === 'skatteverket'
                            ? t('underlag_skatteverket')
                            : t('underlag_document')}
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

      {skvBook && (
        <SkattekontoBookDialog
          row={skvBook}
          skattekontoAccount={skattekonto.account}
          open
          onOpenChange={(open) => {
            if (!open) setSkvBook(null)
          }}
          onBooked={() => {
            setSkvBook(null)
            void refreshSkattekonto()
          }}
          onMatch={() => {
            setSkvMatch(skvBook)
            setSkvBook(null)
          }}
          onLinked={() => void refreshSkattekonto()}
        />
      )}
      {matching && (
        <MatchVoucherDialog
          open
          onOpenChange={(open) => {
            if (!open) setMatching(null)
          }}
          transaction={matching.transaction}
          onLinked={() => {
            setMatching(null)
            void refreshBankRows()
          }}
          preferredJournalEntryId={matching.preferredJournalEntryId}
          preferredNote={matching.note}
        />
      )}
      {skvMatch && (
        <SkattekontoMatchDialog
          row={skvMatch}
          open
          onClose={() => setSkvMatch(null)}
          onMatched={() => {
            setSkvMatch(null)
            void refreshSkattekonto()
          }}
          skattekontoAccount={skattekonto.account}
        />
      )}
    </div>
  )
}
