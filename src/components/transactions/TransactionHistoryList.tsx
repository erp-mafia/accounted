'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { DataListEmpty } from '@/components/ui/data-list'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { embeddedVoucherLabel, getLinkedJournalEntryIds } from '@/lib/transactions/is-booked'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { bankRowCategoryLabel } from '@/lib/transactions/row-category-label'
import {
  bankRowMatchesHistoryFilter,
  skattekontoRowMatchesHistoryFilter,
} from '@/lib/transactions/history-filter'
import {
  ArrowsRightLeftIcon,
  BuildingLibraryIcon,
  DocumentMagnifyingGlassIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  LinkIcon,
  LinkSlashIcon,
  PaperClipIcon,
  TrashIcon,
} from '@/components/icons'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import { WithCorrection } from '@/components/bookkeeping/WithCorrection'
import { VoucherPeekLink } from '@/components/bookkeeping/VoucherPeekLink'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { canDetachDocument } from './detach-underlag'
import type { JeUnderlagStatus } from '@/lib/transactions/underlag-status'
import type { TransactionWithInvoice, HistoryFilter, SourceFilter } from './transaction-types'
import type { GiroCounterparty } from '@/lib/transactions/giro-counterparty'
import { bankRowTitle } from '@/lib/transactions/row-title'
import { useGiroText } from './use-giro-text'
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
  /** Empties the page's search (the no-hits line's "Rensa sökningen"). */
  onClearSearch?: () => void
  /** Page-level source chip selection (the toolbar ContextPicker on
   *  /transactions, shared with the inbox mode). */
  sourceFilter: SourceFilter
  /** The Alla/Företag/Privat/Ignorerade chip. Held by the page so the ignore
   *  toast can open Ignorerade directly. */
  filter: HistoryFilter
  onFilterChange: (filter: HistoryFilter) => void
  /** Restore an ignored bank row (DELETE /api/transactions/[id]/ignore). */
  onUnignore?: (id: string) => void
  /** Underlag status per journal_entry_id (computeJeUnderlagStatus): drives
   *  the per-row "Underlag"/"Underlag saknas" badges on booked rows. */
  jeUnderlagStatus?: Record<string, JeUnderlagStatus>
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  /** Bokför opens the row on the booking screen, as in Obokförda, when the page hands this (the screen is switched on). */
  onOpenBookingScreen?: (transaction: TransactionWithInvoice) => void
  /** Open the attach-underlag dialog (pin an inbox doc / fresh upload). */
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  /** Detach the pinned underlag. Unbooked rows only (see canDetachDocument). */
  onDetachDocument?: (transaction: TransactionWithInvoice) => void
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
  /** The last page could not be read: the button says so and becomes the retry. */
  loadMoreFailed?: boolean
  onLoadMore?: () => void
  /** Whose giro number a row that names nobody shows (lib/transactions/giro-counterparty, crm#1204). */
  giroCounterpartyFor?: (transaction: TransactionWithInvoice) => GiroCounterparty | null
}

/**
 * "Alla" view: every transaction (booked and not), rendered in the same
 * dry-table language as the inbox so the two modes read as one page.
 * Bokförd is the normal state (muted text); an unbooked row shows its
 * action (Bokför, Matcha) and nothing else, one signal per row; an ignored
 * row says Ignorerad and offers Återställ.
 */
export default function TransactionHistoryList({
  transactions,
  skvRows = [],
  exitingIds,
  searchTerm = '',
  onClearSearch,
  sourceFilter,
  filter,
  onFilterChange,
  onUnignore,
  jeUnderlagStatus,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onOpenBookingScreen,
  onOpenAttachDocument,
  onDetachDocument,
  onOpenMatchVoucher,
  onDelete,
  onSkvBokfor,
  onSkvMatch,
  hasMore,
  isLoadingMore,
  loadMoreFailed = false,
  onLoadMore,
  giroCounterpartyFor,
}: TransactionHistoryListProps) {
  const t = useTranslations('tx_history')
  const tCommon = useTranslations('common')

  // Which chip shows which row: lib/transactions/history-filter.
  const bankFiltered = transactions.filter((tx) => {
    if (
      sourceFilter.startsWith('acct:') &&
      tx.cash_account_id !== sourceFilter.slice('acct:'.length)
    ) {
      return false
    }
    if (sourceFilter === 'bank:other' && tx.cash_account_id != null) return false
    const matchesSearch = tx.description.toLowerCase().includes(searchTerm.toLowerCase())
    return matchesSearch && bankRowMatchesHistoryFilter(tx, filter)
  })

  const skvFiltered = skvRows.filter((r) => {
    if (!skattekontoRowMatchesHistoryFilter(r, filter)) return false
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
    { key: 'ignored', labelKey: 'filter_ignored' },
  ]

  return (
    <div className="space-y-4">
      {/* Business/private/ignored seg; the source chip lives in the page toolbar. */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={filter}
          onChange={onFilterChange}
          options={FILTERS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }))}
        />
      </div>

      {filtered.length === 0 && searchTerm ? (
        // No hits for the search: one muted line in the list, not a block.
        <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
          <span>{t('empty_search')}</span>
          {onClearSearch && (
            <Button variant="link" onClick={onClearSearch}>
              {tCommon('clear_search')}
            </Button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <DataListEmpty
          icon={<ArrowsRightLeftIcon className="h-6 w-6" />}
          title={t('empty_title')}
          description={filter === 'ignored' ? t('empty_ignored') : t('empty_filter')}
        />
      ) : (
        /* Negative margin + matching padding: keeps the columns flush with
           the page edges (mirrors the inbox table on the transactions page). */
        <div className="-mx-4 overflow-x-auto px-2 md:-mx-6 md:px-4">
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
                    onOpenBookingScreen={onOpenBookingScreen}
                    onOpenAttachDocument={onOpenAttachDocument}
                    onDetachDocument={onDetachDocument}
                    onOpenMatchVoucher={onOpenMatchVoucher}
                    onDelete={onDelete}
                    onUnignore={onUnignore}
                    giroCounterparty={giroCounterpartyFor?.(item.data) ?? null}
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
          and drop it for the skattekonto scope and under Ignorerade (the page
          loads every ignored row of the period) where it cannot change the
          visible list. */}
      {hasMore && onLoadMore && !searchTerm && sourceFilter !== 'skatteverket' && filter !== 'ignored' && (
        <div className="flex flex-col items-center gap-2">
          {loadMoreFailed && !isLoadingMore && (
            <p role="alert" className="text-[13px] text-muted-foreground">
              {t('load_more_failed')}
            </p>
          )}
          <Button variant="outline" onClick={onLoadMore} loading={isLoadingMore}>
            {isLoadingMore ? t('loading_more') : loadMoreFailed ? tCommon('retry') : t('load_more')}
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
  onOpenBookingScreen,
  onOpenAttachDocument,
  onDetachDocument,
  onOpenMatchVoucher,
  onDelete,
  onUnignore,
  giroCounterparty = null,
}: {
  transaction: TransactionWithInvoice
  giroCounterparty?: GiroCounterparty | null
  isExiting?: boolean
  jeUnderlagStatus?: Record<string, JeUnderlagStatus>
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onOpenBookingScreen?: (transaction: TransactionWithInvoice) => void
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  onDetachDocument?: (transaction: TransactionWithInvoice) => void
  onOpenMatchVoucher?: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  onUnignore?: (id: string) => void
}) {
  const t = useTranslations('tx_history')
  const tDetach = useTranslations('tx_detach')
  const giroText = useGiroText()
  // Viewers must not see write affordances. CorrectionAffordance opens a
  // dialog that stages a storno + correction journal entry; the API path
  // already 403s for viewers but rendering the trigger creates a confusing
  // dead end.
  const { canWrite } = useCanWrite()
  const { lockedTitle } = useViewerLock()
  const isIncome = transaction.amount > 0
  // The pointer alone misses a row split over several verifikat (#1553): its
  // journal_entry_id is NULL and the anchors sit in transaction_voucher_links,
  // so it rendered "Ej bokförd" with a Bokför button (crm#48).
  const linkedEntryIds = getLinkedJournalEntryIds(transaction)
  const isBooked = linkedEntryIds.length > 0
  const primaryEntryId = linkedEntryIds[0] ?? null
  const voucherLinks = (transaction.transaction_voucher_links ?? []).filter(
    (link) => (link.role ?? 'bank_line') === 'bank_line',
  )
  // Only user-created rows are deletable; imported (bank sync / CSV) rows are
  // ignore-only. Mirrors the server guard in DELETE /api/transactions/[id].
  const canDelete = !isBooked && !isImportedTransaction(transaction)
  const isLinkedToInvoice = !!transaction.invoice_id
  // Ignored: neither booked nor waiting. It says so and offers Återställ
  // instead of Bokför (crm#1612); booking or matching it starts by restoring.
  const isIgnored = transaction.is_ignored === true && !isBooked
  const hasInvoiceMatch =
    !isLinkedToInvoice && !!transaction.potential_invoice && !isBooked && !isIgnored

  // Underlag status: see computeJeUnderlagStatus. Unknown/not-yet-loaded JE
  // renders neither badge (no false "saknas" flash while the enrichment loads).
  const jeStatus = primaryEntryId ? jeUnderlagStatus?.[primaryEntryId] : undefined
  const hasJeDoc = jeStatus === 'has'
  const missingUnderlag = isBooked && !transaction.document_id && jeStatus === 'missing'
  const showAttachItem = canWrite && !!onOpenAttachDocument
  // Detach is narrower than attach: only unbooked rows, and only with a pin.
  const showDetachItem = canDetachDocument({
    isBooked,
    canWrite,
    documentId: transaction.document_id,
    hasHandler: !!onDetachDocument,
  })
  // Same affordance as the inbox card: an unbooked row may need to be linked
  // to an already-booked voucher (e.g. the other leg of a transfer).
  const showMatchVoucherItem = canWrite && !isBooked && !isIgnored && !!onOpenMatchVoucher
  const correctionEntryId = isBooked && canWrite ? primaryEntryId : null
  const showOverflowMenu =
    hasInvoiceMatch || (canDelete && !!onDelete) || (isBooked && canWrite) || showAttachItem || showDetachItem || showMatchVoucherItem

  const isPrivate = transaction.is_business === false
  const categoryLabel = bankRowCategoryLabel(transaction)

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
      <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap date-figures text-muted-foreground')}>
        {formatDate(transaction.date)}
      </td>
      {/* overflow-hidden: see #2003, the shrink-0 markers below cannot
          truncate and would paint over Belopp. */}
      <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden')}>
        <span className="row-collapsible flex min-w-0 items-center gap-2">
          <span className="truncate">{bankRowTitle(transaction)}</span>
          {giroCounterparty && (
            <span
              className="hidden max-w-[16rem] shrink-0 truncate text-xs text-muted-foreground md:inline-block"
              title={giroText.sentence(giroCounterparty)}
            >
              {giroText.short(giroCounterparty)}
            </span>
          )}
          <TransactionAttachmentIndicator
            documentId={transaction.document_id}
            journalEntryId={primaryEntryId}
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
              <LinkIcon className="h-3 w-3" />
              {t('linked_to_invoice')}
            </span>
          )}
          {hasInvoiceMatch && (
            <Badge data-ph-mask="" variant="secondary" className="hidden shrink-0 gap-1 font-normal md:inline-flex">
              <DocumentTextIcon className="h-3 w-3" />
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
            ? formatRowAmount(transaction.amount_sek)
            : undefined
        }
      >
        {isIncome ? '+' : ''}
        {formatRowAmount(transaction.amount, transaction.currency)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0 py-[9px]')}>
        <span className="row-collapsible inline-flex items-center justify-end gap-2">
          {isBooked ? (
            <>
              <span className="text-muted-foreground">
                {isPrivate ? t('private_badge') : t('posted')}
              </span>
              {/* One link per verifikat the row is anchored to (pointer first,
                  then each bank_line junction row, deduplicated): a split row
                  reads V200, V201 when the fetch embedded the voucher, else
                  the generic label. */}
              {linkedEntryIds.map((entryId, index) => {
                const link = voucherLinks.find((l) => l.journal_entry_id === entryId)
                return (
                  <VoucherPeekLink
                    key={entryId}
                    entryId={entryId}
                    className={QUIET_LINK_CLASS}
                  >
                    {(link ? embeddedVoucherLabel(link) : null) ??
                      (index === 0 ? t('view_voucher_short') : `+${index}`)}
                  </VoucherPeekLink>
                )
              })}
            </>
          ) : isIgnored ? (
            <>
              <span className="text-muted-foreground">{t('ignored_badge')}</span>
              {canWrite && onUnignore && (
                <button
                  type="button"
                  className={QUIET_LINK_CLASS}
                  onClick={() => onUnignore(transaction.id)}
                >
                  {t('unignore')}
                </button>
              )}
            </>
          ) : isPrivate ? (
            <span className="text-muted-foreground">{t('private_badge')}</span>
          ) : (
            // One signal per row: the Bokför button already says the row is
            // not booked, so no "Ej bokförd" chip beside it. It opens the
            // booking screen where it is switched on, else the picker.
            <Button
              variant="outline"
              onClick={() => (onOpenBookingScreen ?? onOpenCategoryDialog)(transaction)}
              disabled={!canWrite}
              title={lockedTitle}
            >
              {t('book')}
            </Button>
          )}
          {showOverflowMenu && (
            <WithCorrection journalEntryId={correctionEntryId}>
              {(correction) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* mr-2 tucks the button in so the dots glyph sits under
                        the middle of the STATUS header, not at the page edge. */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('mr-2 text-muted-foreground hover:text-foreground data-[state=open]:opacity-100', HOVER_REVEAL_CLASS)}
                      aria-label="Fler alternativ"
                    >
                      <EllipsisHorizontalIcon className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {hasInvoiceMatch && (
                      <DropdownMenuItem onSelect={() => onOpenMatchDialog(transaction)}>
                        <DocumentTextIcon className="h-3.5 w-3.5" />
                        {t('possible_match_invoice', {
                          number: transaction.potential_invoice!.invoice_number ?? '',
                        })}
                      </DropdownMenuItem>
                    )}
                    {showMatchVoucherItem && (
                      <DropdownMenuItem onSelect={() => onOpenMatchVoucher!(transaction)}>
                        <DocumentMagnifyingGlassIcon className="h-3.5 w-3.5" />
                        {t('match_voucher')}
                      </DropdownMenuItem>
                    )}
                    {/* Attach underlag: available on both booked rows (the route
                        propagates the doc onto the verifikation) and unbooked. */}
                    {showAttachItem && (
                      <DropdownMenuItem onSelect={() => onOpenAttachDocument!(transaction)}>
                        <PaperClipIcon className="h-3.5 w-3.5" />
                        {t('attach_document')}
                      </DropdownMenuItem>
                    )}
                    {showDetachItem && (
                      <DropdownMenuItem onSelect={() => onDetachDocument!(transaction)}>
                        <LinkSlashIcon className="h-3.5 w-3.5" />
                        {tDetach('menu_item')}
                      </DropdownMenuItem>
                    )}
                    {correction && (
                      <DropdownMenuItem onSelect={() => correction.open()} disabled={correction.isLoading}>
                        {correction.isLoading ? t('fetching') : t('create_correction')}
                      </DropdownMenuItem>
                    )}
                    {canDelete && onDelete && (
                      <>
                        {(hasInvoiceMatch || showAttachItem || showDetachItem || showMatchVoucherItem) && <DropdownMenuSeparator />}
                        <DropdownMenuItem
                          onSelect={() => onDelete(transaction.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                          {t('delete')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </WithCorrection>
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
  const skvLock = useViewerLock()
  const amount = Number(row.belopp_skatteverket)
  const isIncome = amount > 0
  const isBooked = !!row.journal_entry_id

  return (
    <tr data-tx-id={row.id} className="group transition-colors duration-150 hover:bg-secondary/35">
      <td className={cn(TD_CLASS, 'w-0 !p-0')} aria-hidden="true"></td>
      <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap date-figures text-muted-foreground')}>
        {formatDate(row.transaktionsdatum)}
      </td>
      {/* overflow-hidden: see the bank row above. */}
      <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden')}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{row.transaktionstext}</span>
          {/* Source marker, not an exception: muted text instead of a chip
              that would repeat on every Skatteverket row. */}
          <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground md:inline-flex">
            <BuildingLibraryIcon className="h-3 w-3" />
            {t('skv_badge')}
          </span>
          {!isBooked && row.match_suggestion && (
            <Badge variant="warning" className="h-4 shrink-0 px-1.5 py-0 text-xs">
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
        {formatRowAmount(amount)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0 py-[9px]')}>
        <span className="inline-flex items-center justify-end gap-2">
          {row.journal_entry_id ? (
            <>
              <span className="text-muted-foreground">{t('posted')}</span>
              <VoucherPeekLink entryId={row.journal_entry_id} className={QUIET_LINK_CLASS}>
                {t('view_voucher_short')}
              </VoucherPeekLink>
            </>
          ) : (
            // The actions say the row is not booked: no chip beside them.
            <>
              {onMatch && (
                <Button
                  variant="outline"
                  onClick={() => onMatch(row)}
                  disabled={!skvLock.canWrite}
                  title={skvLock.lockedTitle}
                >
                  {row.match_suggestion ? t('link') : t('match')}
                </Button>
              )}
              {!row.match_suggestion && onBokfor && (
                <button type="button" className={QUIET_LINK_CLASS} onClick={() => onBokfor(row)} disabled={!skvLock.canWrite} title={skvLock.lockedTitle}>
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
