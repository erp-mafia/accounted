'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Badge } from '@/components/ui/badge'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table-classes'
import { ChevronRightIcon } from '@/components/icons'
import { inboxFocusHref } from '@/components/dashboard/StepItems'
import { itemHeadline, queueFor, type InkorgItem } from '@/lib/inkorg/items'
import { INKORG_HREF, LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { bookingScreenHref } from '@/lib/bookkeeping/booking-screen'
import {
  buildToBookRows,
  inToBookFilter,
  toBookCounts,
  TO_BOOK_FILTERS,
  type ToBookBankRow,
  type ToBookDocument,
  type ToBookFilter,
  type ToBookRow,
} from '@/lib/bookkeeping/to-book'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'

/** The page this list is, for the booking screen's way back. */
const LIST_PATH = '/att-bokfora'

/**
 * The inbox rows, as Inkommande reads them (components/inkorg/use-inkorg-data.ts):
 * scope=inbox reads every item and answers the ones still in the inbox, so an
 * old open document is never cut off behind newer booked ones.
 */
const INBOX_ITEMS_URL = '/api/extensions/ext/invoice-inbox/items?scope=inbox'

/** The open bank rows: the read Bankrader's Att bokföra tab makes (open_bank_rows). */
async function readBankRows(): Promise<ToBookBankRow[]> {
  const res = await fetch('/api/transactions?unmatched=true')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: ToBookBankRow[] }
  return json.data ?? []
}

/**
 * The documents Inkommande asks a person about, in its Behöver dig queue. A
 * company without the inbox (no extension, no capability) has none: the
 * list then holds the bank rows only.
 */
async function readDocuments(): Promise<ToBookDocument[]> {
  const res = await fetch(INBOX_ITEMS_URL)
  if (res.status === 402 || res.status === 403 || res.status === 404) return []
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { items?: InkorgItem[] } }
  return queueFor(json.data?.items ?? [], { kind: 'need' })
    .filter((item) => !item.matched_transaction_id)
    .map((item) => {
      const head = itemHeadline(item)
      return {
        id: item.id,
        name: head.name ?? item.email_from?.trim() ?? '',
        date: head.documentDate ?? item.created_at.slice(0, 10),
        amount: head.amount,
        currency: head.amount == null ? null : head.currency,
        bankMatchTransactionId: item.bank_match?.transaction_id ?? null,
      }
    })
}

/**
 * Att bokföra (/att-bokfora): everything that waits to be booked, as one
 * list (lib/bookkeeping/to-book.ts). A bank row opens the booking screen; a
 * bank row with a document found for it, and a document with no bank row,
 * open that document in Inkommande, where the pair is confirmed or the
 * document is booked.
 */
export function ToBookList({ inkorgV2Enabled }: { inkorgV2Enabled: boolean }) {
  const t = useTranslations('to_book_list')
  const [filter, setFilter] = useState<ToBookFilter>('all')
  const bank = useSWR('to-book:bank-rows', readBankRows)
  const docs = useSWR('to-book:documents', readDocuments)
  const { cashAccounts } = useCashAccounts()
  const inboxBase = inkorgV2Enabled ? INKORG_HREF : LEGACY_INBOX_HREF

  const rows = useMemo(() => buildToBookRows(bank.data ?? [], docs.data ?? []), [bank.data, docs.data])
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
    row.inboxItemId && (row.kind === 'document' || row.underlag === 'found')
      ? inboxFocusHref(inboxBase, row.inboxItemId)
      : bookingScreenHref({ kind: 'transaction', transactionId: row.transactionId as string, account: null }, LIST_PATH)

  const loading = (!bank.data && !bank.error) || (!docs.data && !docs.error)
  const failed = bank.error || docs.error

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
        <LoadError title={t('load_error')} onRetry={() => void Promise.all([bank.mutate(), docs.mutate()])} />
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
                <th className={TH_CLASS}>{t('col_what')}</th>
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
                    {row.underlag === 'missing' ? (
                      <Badge variant="warning">{t('underlag_missing')}</Badge>
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
                      row.amount != null && row.amount > 0 && row.kind === 'bank' ? 'text-success' : 'text-strong',
                    )}
                    data-ph-mask=""
                  >
                    {row.amount == null ? '' : `${row.amount > 0 && row.kind === 'bank' ? '+' : ''}${formatRowAmount(row.amount, row.currency)}`}
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
