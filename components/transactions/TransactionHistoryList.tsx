'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataListEmpty } from '@/components/ui/data-list'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { getCategoryDisplayName } from '@/lib/tax/expense-warnings'
import {
  ArrowLeftRight,
  FileText,
  Landmark,
  Link2,
  FileSearch,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Trash2,
} from 'lucide-react'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import CorrectionAffordance from '@/components/bookkeeping/CorrectionAffordance'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { JeUnderlagStatus } from '@/lib/transactions/underlag-status'
import type { TransactionWithInvoice, HistoryFilter, SourceFilter } from './transaction-types'
import type {
  SkattekontoTransactionWithSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'

type HistoryRow =
  | { source: 'bank'; date: string; data: TransactionWithInvoice }
  | { source: 'skatteverket'; date: string; data: SkattekontoTransactionWithSuggestion }

interface TransactionHistoryListProps {
  transactions: TransactionWithInvoice[]
  skvRows?: SkattekontoTransactionWithSuggestion[]
  /** Rows animating out during the page's 350ms removal window (delete):
   *  rendered with .row-exit so the departure is visible, not a hard jump. */
  exitingIds?: Set<string>
  searchTerm?: string
  /** Page-level source chip selection (the toolbar ContextPicker on
   *  /transactions, shared with the inbox mode). */
  sourceFilter: SourceFilter
  /** Underlag status per journal_entry_id (computeJeUnderlagStatus): drives
   *  the per-row "Underlag"/"Underlag saknas" badges on booked rows. */
  jeUnderlagStatus?: Record<string, JeUnderlagStatus>
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  /** Open the attach-underlag dialog (pin an inbox doc / fresh upload). */
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  /** Open the match-against-existing-voucher dialog. Unbooked rows can end up
   *  here (not in the inbox) when is_business is already set, e.g. after a
   *  voucher was removed without a full uncategorize; without this item such
   *  rows have no path back to voucher matching. */
  onOpenMatchVoucher?: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  onSkvBokfor?: (row: StoredSkattekontoTransaction) => void
  onSkvMatch?: (row: StoredSkattekontoTransaction) => void
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
}

/**
 * "Alla" view: every transaction (booked and not), rendered in the same
 * dry-table language as the inbox so the two modes read as one page.
 * Bokförd is the normal state (muted text); Ej bokförd is the exception chip.
 */
export default function TransactionHistoryList({
  transactions,
  skvRows = [],
  exitingIds,
  searchTerm = '',
  sourceFilter,
  jeUnderlagStatus,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onOpenAttachDocument,
  onOpenMatchVoucher,
  onDelete,
  onSkvBokfor,
  onSkvMatch,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: TransactionHistoryListProps) {
  const t = useTranslations('tx_history')
  const [filter, setFilter] = useState<HistoryFilter>('all')

  // The bank/private filter doesn't apply to SKV rows: they have no
  // is_business flag. So when the filter is 'business' or 'private' we
  // implicitly hide SKV.
  const bankFiltered = transactions.filter((tx) => {
    if (
      sourceFilter.startsWith('acct:') &&
      tx.cash_account_id !== sourceFilter.slice('acct:'.length)
    ) {
      return false
    }
    if (sourceFilter === 'bank:other' && tx.cash_account_id != null) return false
    const matchesSearch = tx.description.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesFilter =
      filter === 'all' ||
      (filter === 'business' && tx.is_business === true) ||
      (filter === 'private' && tx.is_business === false)
    return matchesSearch && matchesFilter
  })

  const skvFiltered = skvRows.filter((r) => {
    if (filter !== 'all') return false
    return r.transaktionstext.toLowerCase().includes(searchTerm.toLowerCase())
  })

  const merged: HistoryRow[] = []
  if (sourceFilter !== 'skatteverket') {
    for (const tx of bankFiltered) {
      merged.push({ source: 'bank', date: tx.date, data: tx })
    }
  }
  // Skattekonto rows belong to no cash account: any bank-side narrowing
  // ('bank', 'bank:other', 'acct:<id>') hides them.
  if (sourceFilter === 'all' || sourceFilter === 'skatteverket') {
    for (const r of skvFiltered) {
      merged.push({ source: 'skatteverket', date: r.transaktionsdatum, data: r })
    }
  }
  merged.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return a.source === 'bank' ? -1 : 1
  })

  const filtered = merged

  const FILTERS: Array<{ key: HistoryFilter; labelKey: string }> = [
    { key: 'all', labelKey: 'filter_all' },
    { key: 'business', labelKey: 'filter_business' },
    { key: 'private', labelKey: 'filter_private' },
  ]

  return (
    <div className="space-y-4">
      {/* Business/private seg; the source chip lives in the page toolbar. */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          options={FILTERS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }))}
        />
      </div>

      {filtered.length === 0 ? (
        <DataListEmpty
          icon={<ArrowLeftRight className="h-6 w-6" />}
          title={t('empty_title')}
          description={searchTerm ? t('empty_search') : t('empty_filter')}
        />
      ) : (
        /* Negative margin + matching padding: keeps the columns flush with
           the page edges (mirrors the inbox table on the transactions page). */
        <div className="-mx-5 overflow-x-auto px-5 md:-mx-8 md:px-8">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-0 !p-0')} aria-hidden="true"></th>
                <th className={cn(TH_CLASS, '!pl-0')}>{t('th_date')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('th_description')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                <th className={cn(TH_CLASS, 'text-right !pr-0')}>{t('th_status')}</th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {filtered.map((item) =>
                item.source === 'bank' ? (
                  <BankHistoryRow
                    key={`bank-${item.data.id}`}
                    transaction={item.data}
                    isExiting={exitingIds?.has(item.data.id) ?? false}
                    jeUnderlagStatus={jeUnderlagStatus}
                    onOpenMatchDialog={onOpenMatchDialog}
                    onOpenCategoryDialog={onOpenCategoryDialog}
                    onOpenAttachDocument={onOpenAttachDocument}
                    onOpenMatchVoucher={onOpenMatchVoucher}
                    onDelete={onDelete}
                  />
                ) : (
                  <SkattekontoHistoryRow
                    key={`skv-${item.data.id}`}
                    row={item.data}
                    onBokfor={onSkvBokfor}
                    onMatch={onSkvMatch}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination pages BANK rows: keep it reachable whenever more exist,
          even when the current page has no rows matching an acct:/bank:other
          scope (filtered.length would hide the only way to older matches),
          and drop it for the skattekonto scope where it cannot change the
          visible list. */}
      {hasMore && onLoadMore && !searchTerm && sourceFilter !== 'skatteverket' && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('loading_more')}
              </>
            ) : (
              t('load_more')
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

function BankHistoryRow({
  transaction,
  isExiting = false,
  jeUnderlagStatus,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onOpenAttachDocument,
  onOpenMatchVoucher,
  onDelete,
}: {
  transaction: TransactionWithInvoice
  isExiting?: boolean
  jeUnderlagStatus?: Record<string, JeUnderlagStatus>
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  onOpenMatchVoucher?: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
}) {
  const t = useTranslations('tx_history')
  // Viewers must not see write affordances. CorrectionAffordance opens a
  // dialog that stages a storno + correction journal entry; the API path
  // already 403s for viewers but rendering the trigger creates a confusing
  // dead end.
  const { canWrite } = useCanWrite()
  const isIncome = transaction.amount > 0
  const isBooked = !!transaction.journal_entry_id
  // Only user-created rows are deletable; imported (bank sync / CSV) rows are
  // ignore-only. Mirrors the server guard in DELETE /api/transactions/[id].
  const canDelete = !isBooked && !isImportedTransaction(transaction)
  const isLinkedToInvoice = !!transaction.invoice_id
  const hasInvoiceMatch =
    !isLinkedToInvoice && !!transaction.potential_invoice && !isBooked

  // Underlag status: see computeJeUnderlagStatus. Unknown/not-yet-loaded JE
  // renders neither badge (no false "saknas" flash while the enrichment loads).
  const jeStatus = transaction.journal_entry_id
    ? jeUnderlagStatus?.[transaction.journal_entry_id]
    : undefined
  const hasJeDoc = jeStatus === 'has'
  const missingUnderlag = isBooked && !transaction.document_id && jeStatus === 'missing'
  const showAttachItem = canWrite && !!onOpenAttachDocument
  // Same affordance as the inbox card: an unbooked row may need to be linked
  // to an already-booked voucher (e.g. the other leg of a transfer).
  const showMatchVoucherItem = canWrite && !isBooked && !!onOpenMatchVoucher
  const showOverflowMenu =
    hasInvoiceMatch || (canDelete && !!onDelete) || (isBooked && canWrite) || showAttachItem || showMatchVoucherItem

  const isPrivate = transaction.is_business === false
  const categoryLabel =
    transaction.is_business === true &&
    !(transaction.category === 'uncategorized' && transaction.journal_entry_id)
      ? getCategoryDisplayName(transaction.category)
      : null

  return (
    <tr
      data-tx-id={transaction.id}
      className={cn(
        'group transition-colors duration-150 hover:bg-secondary/35',
        isExiting && 'row-exit',
      )}
      // .row-exit only blocks pointer input; `inert` also drops keyboard
      // focus and activation (booking, delete, the ⋯ menu) during the 350ms
      // removal window.
      inert={isExiting || undefined}
    >
      <td className={cn(TD_CLASS, 'w-0 !p-0')} aria-hidden="true"></td>
      <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
        {formatDate(transaction.date)}
      </td>
      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
        <span className="row-collapsible flex min-w-0 items-center gap-2">
          <span className="truncate">{transaction.description}</span>
          <TransactionAttachmentIndicator
            documentId={transaction.document_id}
            journalEntryId={transaction.journal_entry_id}
            hasJeDoc={hasJeDoc}
            missing={missingUnderlag}
            onAttach={
              showAttachItem ? () => onOpenAttachDocument!(transaction) : undefined
            }
          />
          {categoryLabel && (
            <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
              {categoryLabel}
            </span>
          )}
          {isLinkedToInvoice && (
            <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground md:inline-flex">
              <Link2 className="h-3 w-3" />
              {t('linked_to_invoice')}
            </span>
          )}
          {hasInvoiceMatch && (
            <Badge data-ph-mask="" variant="secondary" className="hidden shrink-0 gap-1 font-normal md:inline-flex">
              <FileText className="h-3 w-3" />
              {t('possible_match_invoice', {
                number: transaction.potential_invoice!.invoice_number ?? '',
              })}
            </Badge>
          )}
        </span>
      </td>
      <td
        className={cn(
          TD_CLASS,
          'whitespace-nowrap text-right tabular-nums rr-mask',
          isIncome && 'text-success',
        )}
        title={
          transaction.currency !== 'SEK' && transaction.amount_sek != null
            ? formatCurrency(transaction.amount_sek)
            : undefined
        }
      >
        {isIncome ? '+' : ''}
        {formatCurrency(transaction.amount, transaction.currency)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0 py-[9px]')}>
        <span className="row-collapsible inline-flex items-center justify-end gap-2">
          {isBooked ? (
            <>
              <span className="text-muted-foreground">
                {isPrivate ? t('private_badge') : t('posted')}
              </span>
              <Link
                href={`/bookkeeping/${transaction.journal_entry_id}`}
                className={QUIET_LINK_CLASS}
              >
                {t('view_voucher_short')}
              </Link>
            </>
          ) : isPrivate ? (
            <span className="text-muted-foreground">{t('private_badge')}</span>
          ) : (
            <>
              <Badge variant="secondary" className="font-normal">
                {t('not_posted')}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3.5 text-xs"
                onClick={() => onOpenCategoryDialog(transaction)}
              >
                {t('book')}
              </Button>
            </>
          )}
          {showOverflowMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* mr-2 tucks the button in so the dots glyph sits under
                    the middle of the STATUS header, not at the page edge. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-2 h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label="Fler alternativ"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hasInvoiceMatch && (
                  <DropdownMenuItem onSelect={() => onOpenMatchDialog(transaction)}>
                    <FileText className="h-3.5 w-3.5" />
                    {t('possible_match_invoice', {
                      number: transaction.potential_invoice!.invoice_number ?? '',
                    })}
                  </DropdownMenuItem>
                )}
                {showMatchVoucherItem && (
                  <DropdownMenuItem onSelect={() => onOpenMatchVoucher!(transaction)}>
                    <FileSearch className="h-3.5 w-3.5" />
                    {t('match_voucher')}
                  </DropdownMenuItem>
                )}
                {/* Attach underlag: available on both booked rows (the route
                    propagates the doc onto the verifikation) and unbooked. */}
                {showAttachItem && (
                  <DropdownMenuItem onSelect={() => onOpenAttachDocument!(transaction)}>
                    <Paperclip className="h-3.5 w-3.5" />
                    {t('attach_document')}
                  </DropdownMenuItem>
                )}
                {isBooked && canWrite && transaction.journal_entry_id && (
                  <CorrectionAffordance journalEntryId={transaction.journal_entry_id}>
                    {({ open, isLoading }) => (
                      <DropdownMenuItem onSelect={() => open()} disabled={isLoading}>
                        {isLoading ? t('fetching') : t('create_correction')}
                      </DropdownMenuItem>
                    )}
                  </CorrectionAffordance>
                )}
                {canDelete && onDelete && (
                  <>
                    {(hasInvoiceMatch || showAttachItem || showMatchVoucherItem) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onSelect={() => onDelete(transaction.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('delete')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </td>
    </tr>
  )
}

function SkattekontoHistoryRow({
  row,
  onBokfor,
  onMatch,
}: {
  row: SkattekontoTransactionWithSuggestion
  onBokfor?: (row: StoredSkattekontoTransaction) => void
  onMatch?: (row: StoredSkattekontoTransaction) => void
}) {
  const t = useTranslations('tx_history')
  const amount = Number(row.belopp_skatteverket)
  const isIncome = amount > 0
  const isBooked = !!row.journal_entry_id

  return (
    <tr className="group transition-colors duration-150 hover:bg-secondary/35">
      <td className={cn(TD_CLASS, 'w-0 !p-0')} aria-hidden="true"></td>
      <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
        {formatDate(row.transaktionsdatum)}
      </td>
      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{row.transaktionstext}</span>
          <Badge variant="outline" className="h-4 shrink-0 gap-1 px-1.5 py-0 text-[10px] font-normal">
            <Landmark className="h-3 w-3" />
            {t('skv_badge')}
          </Badge>
          {!isBooked && row.match_suggestion && (
            <Badge variant="warning" className="h-4 shrink-0 px-1.5 py-0 text-[10px]">
              {t('possible_duplicate')}
            </Badge>
          )}
        </span>
      </td>
      <td
        className={cn(
          TD_CLASS,
          'whitespace-nowrap text-right tabular-nums rr-mask',
          isIncome && 'text-success',
        )}
      >
        {isIncome ? '+' : ''}
        {formatCurrency(amount)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0 py-[9px]')}>
        <span className="inline-flex items-center justify-end gap-2">
          {isBooked ? (
            <>
              <span className="text-muted-foreground">{t('posted')}</span>
              <Link href={`/bookkeeping/${row.journal_entry_id}`} className={QUIET_LINK_CLASS}>
                {t('view_voucher_short')}
              </Link>
            </>
          ) : (
            <>
              <Badge variant="secondary" className="font-normal">
                {t('not_posted')}
              </Badge>
              {onMatch && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-3.5 text-xs"
                  onClick={() => onMatch(row)}
                >
                  {row.match_suggestion ? t('link') : t('match')}
                </Button>
              )}
              {!row.match_suggestion && onBokfor && (
                <button type="button" className={QUIET_LINK_CLASS} onClick={() => onBokfor(row)}>
                  {t('book')}
                </button>
              )}
            </>
          )}
        </span>
      </td>
    </tr>
  )
}
