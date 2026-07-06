'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DataList,
  DataListHeader,
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
  DataListEmpty,
} from '@/components/ui/data-list'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { getCategoryDisplayName } from '@/lib/tax/expense-warnings'
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Check,
  ChevronDown,
  Landmark,
  Link2,
  FileText,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Trash2,
} from 'lucide-react'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import CorrectionAffordance from '@/components/bookkeeping/CorrectionAffordance'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { JeUnderlagStatus } from '@/lib/transactions/underlag-status'
import type { TransactionWithInvoice, HistoryFilter } from './transaction-types'
import type {
  SkattekontoTransactionWithSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'

type SourceFilter = 'all' | 'bank' | 'skatteverket'

type HistoryRow =
  | { source: 'bank'; date: string; data: TransactionWithInvoice }
  | { source: 'skatteverket'; date: string; data: SkattekontoTransactionWithSuggestion }

interface TransactionHistoryListProps {
  transactions: TransactionWithInvoice[]
  skvRows?: SkattekontoTransactionWithSuggestion[]
  searchTerm?: string
  /** Underlag status per journal_entry_id (computeJeUnderlagStatus): drives
   *  the per-row "Underlag"/"Underlag saknas" badges on booked rows. */
  jeUnderlagStatus?: Record<string, JeUnderlagStatus>
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  /** Open the attach-underlag dialog (pin an inbox doc / fresh upload). */
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  onSkvBokfor?: (row: StoredSkattekontoTransaction) => void
  onSkvMatch?: (row: StoredSkattekontoTransaction) => void
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
}

export default function TransactionHistoryList({
  transactions,
  skvRows = [],
  searchTerm = '',
  jeUnderlagStatus,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onOpenAttachDocument,
  onDelete,
  onSkvBokfor,
  onSkvMatch,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: TransactionHistoryListProps) {
  const t = useTranslations('tx_history')
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')

  // The bank/private filter doesn't apply to SKV rows: they have no
  // is_business flag. So when the filter is 'business' or 'private' we
  // implicitly hide SKV.
  const bankFiltered = transactions.filter((tx) => {
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
  if (sourceFilter !== 'bank') {
    for (const r of skvFiltered) {
      merged.push({ source: 'skatteverket', date: r.transaktionsdatum, data: r })
    }
  }
  merged.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return a.source === 'bank' ? -1 : 1
  })

  const showSourceFilter = skvRows.length > 0 && transactions.length > 0
  const filtered = merged
  const showHeader = showSourceFilter

  return (
    <div className="space-y-4">
      {/* Business/private tabs */}
      <Tabs value={filter} onValueChange={(v) => setFilter(v as HistoryFilter)}>
        <TabsList>
          <TabsTrigger value="all">{t('filter_all')}</TabsTrigger>
          <TabsTrigger value="business">{t('filter_business')}</TabsTrigger>
          <TabsTrigger value="private">{t('filter_private')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <DataList>
        {showHeader && (
          <DataListHeader>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('source_label')}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                  {sourceFilter === 'all'
                    ? t('source_all')
                    : sourceFilter === 'bank'
                      ? t('source_bank')
                      : t('source_skatteverket')}
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[12rem]">
                <DropdownMenuRadioGroup
                  value={sourceFilter}
                  onValueChange={(v) => setSourceFilter(v as SourceFilter)}
                >
                  <DropdownMenuRadioItem value="all">{t('source_all')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="bank">{t('source_bank')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="skatteverket">{t('source_skatteverket')}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </DataListHeader>
        )}

        {filtered.length === 0 ? (
          <DataListEmpty
            icon={<ArrowLeftRight className="h-6 w-6" />}
            title={t('empty_title')}
            description={searchTerm ? t('empty_search') : t('empty_filter')}
          />
        ) : (
          filtered.map((item) =>
            item.source === 'bank' ? (
              <BankHistoryRow
                key={`bank-${item.data.id}`}
                transaction={item.data}
                jeUnderlagStatus={jeUnderlagStatus}
                onOpenMatchDialog={onOpenMatchDialog}
                onOpenCategoryDialog={onOpenCategoryDialog}
                onOpenAttachDocument={onOpenAttachDocument}
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
          )
        )}
      </DataList>

      {hasMore && onLoadMore && !searchTerm && filtered.length > 0 && (
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
  jeUnderlagStatus,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onOpenAttachDocument,
  onDelete,
}: {
  transaction: TransactionWithInvoice
  jeUnderlagStatus?: Record<string, JeUnderlagStatus>
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
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

  // Primary status badge: pick the most informative one.
  const statusBadge = (() => {
    if (isBooked) {
      return (
        <Badge variant="success" className="h-4 gap-1 px-1.5 py-0 text-[10px]">
          <Check className="h-3 w-3" />
          {t('posted')}
        </Badge>
      )
    }
    return (
      <Badge variant="warning" className="h-4 px-1.5 py-0 text-[10px]">
        {t('not_posted')}
      </Badge>
    )
  })()

  const categoryLabel =
    transaction.is_business !== null &&
    !(
      transaction.is_business &&
      transaction.category === 'uncategorized' &&
      transaction.journal_entry_id
    )
      ? transaction.is_business
        ? getCategoryDisplayName(transaction.category)
        : t('private_badge')
      : null

  return (
    <DataListRow
      data-tx-id={transaction.id}
      leading={
        <span
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center',
            isIncome ? 'text-success' : 'text-foreground/60'
          )}
          aria-hidden
        >
          {isIncome ? (
            <ArrowUpRight className="h-4 w-4" />
          ) : (
            <ArrowDownRight className="h-4 w-4" />
          )}
        </span>
      }
      trailing={
        <>
          <div className="text-right">
            <p
              className={cn(
                'font-medium tabular-nums leading-none',
                isIncome && 'text-success'
              )}
            >
              {isIncome ? '+' : ''}
              {formatCurrency(transaction.amount, transaction.currency)}
            </p>
            {transaction.currency !== 'SEK' && transaction.amount_sek != null && (
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {formatCurrency(transaction.amount_sek)}
              </p>
            )}
          </div>
          {!isBooked && (
            <Button
              size="sm"
              variant="default"
              className="h-8 px-3 text-xs"
              onClick={() => onOpenCategoryDialog(transaction)}
            >
              {t('book')}
            </Button>
          )}
          {isBooked && (
            <Button asChild size="sm" variant="ghost" className="h-8 px-3 text-xs">
              <Link href={`/bookkeeping/${transaction.journal_entry_id}`}>
                {t('view_voucher_short')}
              </Link>
            </Button>
          )}
          {(hasInvoiceMatch || (canDelete && onDelete) || (isBooked && canWrite) || showAttachItem) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
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
                    {(hasInvoiceMatch || showAttachItem) && <DropdownMenuSeparator />}
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
        </>
      }
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <DataListPrimary>{transaction.description}</DataListPrimary>
        <TransactionAttachmentIndicator
          documentId={transaction.document_id}
          journalEntryId={transaction.journal_entry_id}
          hasJeDoc={hasJeDoc}
          missing={missingUnderlag}
          onAttach={
            showAttachItem ? () => onOpenAttachDocument!(transaction) : undefined
          }
        />
      </div>
      <DataListMeta>
        <span className="tabular-nums">{formatDate(transaction.date)}</span>
        <DataListMetaSeparator />
        {statusBadge}
        {categoryLabel && (
          <>
            <DataListMetaSeparator />
            <span>{categoryLabel}</span>
          </>
        )}
        {isLinkedToInvoice && (
          <>
            <DataListMetaSeparator />
            <span className="inline-flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              {t('linked_to_invoice')}
            </span>
          </>
        )}
        {hasInvoiceMatch && (
          <>
            <DataListMetaSeparator />
            <span className="inline-flex items-center gap-1 text-primary">
              <FileText className="h-3 w-3" />
              {t('possible_match_invoice', {
                number: transaction.potential_invoice!.invoice_number ?? '',
              })}
            </span>
          </>
        )}
      </DataListMeta>
    </DataListRow>
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

  const statusBadge = (() => {
    if (isBooked) {
      return (
        <Badge variant="success" className="h-4 gap-1 px-1.5 py-0 text-[10px]">
          <Check className="h-3 w-3" />
          {t('posted')}
        </Badge>
      )
    }
    if (row.match_suggestion) {
      return (
        <Badge variant="warning" className="h-4 px-1.5 py-0 text-[10px]">
          {t('possible_duplicate')}
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
        {t('not_posted')}
      </Badge>
    )
  })()

  return (
    <DataListRow
      leading={
        <span
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center',
            isIncome ? 'text-success' : 'text-foreground/60'
          )}
          aria-hidden
        >
          {isIncome ? (
            <ArrowUpRight className="h-4 w-4" />
          ) : (
            <ArrowDownRight className="h-4 w-4" />
          )}
        </span>
      }
      trailing={
        <>
          <div className="text-right">
            <p
              className={cn(
                'font-medium tabular-nums leading-none',
                isIncome && 'text-success'
              )}
            >
              {isIncome ? '+' : ''}
              {formatCurrency(amount)}
            </p>
          </div>
          {!isBooked && onMatch && (
            <Button
              size="sm"
              variant={row.match_suggestion ? 'default' : 'outline'}
              className="h-8 px-3 text-xs"
              onClick={() => onMatch(row)}
            >
              <Link2 className="mr-1 h-3 w-3" />
              {row.match_suggestion ? t('link') : t('match')}
            </Button>
          )}
          {!isBooked && !row.match_suggestion && onBokfor && (
            <Button
              size="sm"
              variant="default"
              className="h-8 px-3 text-xs"
              onClick={() => onBokfor(row)}
            >
              {t('book')}
            </Button>
          )}
          {isBooked && (
            <Button asChild size="sm" variant="ghost" className="h-8 px-3 text-xs">
              <Link href={`/bookkeeping/${row.journal_entry_id}`}>
                {t('view_voucher_short')}
              </Link>
            </Button>
          )}
        </>
      }
    >
      <DataListPrimary>{row.transaktionstext}</DataListPrimary>
      <DataListMeta>
        <span className="tabular-nums">{formatDate(row.transaktionsdatum)}</span>
        <DataListMetaSeparator />
        <span className="inline-flex items-center gap-1">
          <Landmark className="h-3 w-3" />
          {t('skv_badge')}
        </span>
        <DataListMetaSeparator />
        {statusBadge}
      </DataListMeta>
    </DataListRow>
  )
}
