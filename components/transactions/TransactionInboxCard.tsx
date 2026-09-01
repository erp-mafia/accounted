'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useDocumentExtraction } from '@/lib/hooks/use-document-extraction'
import ExtractionStatus from '@/components/ui/extraction-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TD_CLASS, CHECKBOX_REVEAL_CLASS, RowFoldout } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isImportedTransaction } from '@/lib/transactions/origin'
import {
  AlertCircle,
  ArrowRightLeft,
  ChevronRight,
  EyeOff,
  FileSearch,
  Link2,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Split,
  Trash2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

// True when the AI tier is active: gates user-facing strings that promise
// AI behavior. On the free build (document-extraction disabled) we keep the
// upload functional but drop the "AI:n läser dokumentet" promise.
const HAS_AI_EXTRACTION = ENABLED_EXTENSION_IDS.has('document-extraction')
import { BrandMark } from '@/components/ui/brand-mark'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'
import type { CashAccount } from '@/types'

interface TransactionInboxCardProps {
  transaction: TransactionWithInvoice
  /** When set, this bank tx looks like the bank side of a 1930↔1630
   *  transfer that the user will later see on /skattekonto. */
  skvCounterpartDate?: string
  /** The row was just booked/ignored/deleted and is animating out during the
   *  page's 350ms removal window: .row-exit fades and collapses it, and
   *  pointer events are off. Instant removal under prefers-reduced-motion. */
  isExiting?: boolean
  processingId: string | null
  isSelected: boolean
  /** Row expansion (concept foldout): controlled by the page so only one
   *  row is open at a time, mirroring the verifikat list. */
  isExpanded: boolean
  onToggleExpand: (id: string) => void
  entityType?: string
  onCategorize: CategorizeHandler
  /** Confirm an auto-detected invoice match (1-click shortcut). */
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  /** Open the manual picker: routes to customer or supplier picker by amount sign. */
  onOpenMatchInvoicePicker: (transaction: TransactionWithInvoice) => void
  /** Open the split-payment allocator (1 tx → N invoices): same direction
   *  detection as the single-pick picker. Optional so legacy callers stay
   *  source-compatible. */
  onOpenSplitMatch?: (transaction: TransactionWithInvoice) => void
  /** Open the existing-verifikat matcher: link the bank tx to an already-booked
   *  voucher (salary, Fortnox import, manual entry) with no new bokföring. */
  onOpenMatchVoucher?: (transaction: TransactionWithInvoice) => void
  /** Open the attach-underlag dialog: pin an inbox document or a fresh upload
   *  to the transaction (the tx→doc mirror of the Documents view's matcher). */
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  /** Mark the transaction as ignored so it leaves the inbox without a journal entry. */
  onIgnore?: (transaction: TransactionWithInvoice) => void
  /** Open the edit-title dialog. Only wired for editable (unbooked/unmatched) rows. */
  onEditTitle?: (transaction: TransactionWithInvoice) => void
  /** Open the move-to-another-cash-account dialog. Only shown when the company
   *  has more than one enabled cash account (see `cashAccounts`). */
  onMoveCashAccount?: (transaction: TransactionWithInvoice) => void
  /** The company's enabled cash accounts (the page's ?enabled_only=true fetch):
   *  gates the move action, which is pointless with a single account. */
  cashAccounts?: CashAccount[]
  onToggleSelect: (id: string, extend?: boolean) => void
  /** End date of the company's completed SIE-import coverage. Rows on or
   *  before it are pre-migration history: they most likely correspond to an
   *  already-imported verifikat, so the row carries a quiet marker steering
   *  toward matching rather than re-booking. */
  preMigrationCutoff?: string | null
}

/**
 * A bank transaction in the inbox, rendered as a dry-table row pair (concept
 * scene 10): main row with hover checkbox/chevron and the primary action as a
 * quiet pill, plus a foldout with the row's detail and full action set. The
 * ⋯ overflow menu stays on the row for one-click access to the same actions.
 */
export default function TransactionInboxCard({
  transaction,
  skvCounterpartDate,
  isExiting = false,
  processingId,
  isSelected,
  isExpanded,
  onToggleExpand,
  onOpenMatchDialog,
  onOpenMatchInvoicePicker,
  onOpenSplitMatch,
  onOpenMatchVoucher,
  onOpenAttachDocument,
  onOpenCategoryDialog,
  onDelete,
  onIgnore,
  onEditTitle,
  onMoveCashAccount,
  cashAccounts,
  onToggleSelect,
  preMigrationCutoff = null,
}: TransactionInboxCardProps) {
  const t = useTranslations('tx_inbox_card')
  const tMethod = useTranslations('tx_method')
  // Radix' onCheckedChange carries no mouse event, so the shift state is
  // captured from the click that precedes it (Radix composes our onClick
  // before its own handler) and read back when the toggle fires.
  const shiftHeld = useRef(false)
  // Attaching underlag is a write: hide the affordance from viewers so they
  // don't dead-end on a 403 (mirrors the gate in TransactionHistoryList).
  const { canWrite } = useCanWrite()
  const isProcessing = processingId === transaction.id
  const isDisabled = processingId !== null && processingId !== transaction.id
  const isIncome = transaction.amount > 0
  // Optimistic override: flips the indicator to "attached" as soon as the
  // upload POST succeeds, without waiting for the parent to refetch. The
  // next parent refresh will sync; in the meantime the user sees the
  // correct visual state immediately. Same hook handles agent-chat uploads
  // via the Accounted:transaction-document-linked window event (AgentChat
  // dispatches it after /api/agent/upload returns).
  const [optimisticDocumentId, setOptimisticDocumentId] = useState<string | null>(null)
  useEffect(() => {
    function onLinked(e: Event) {
      const detail = (e as CustomEvent<{ transaction_id?: string; document_id?: string }>).detail
      if (!detail || detail.transaction_id !== transaction.id || !detail.document_id) return
      setOptimisticDocumentId(detail.document_id)
    }
    window.addEventListener('Accounted:transaction-document-linked', onLinked)
    return () => window.removeEventListener('Accounted:transaction-document-linked', onLinked)
  }, [transaction.id])
  const attachedDocumentId =
    optimisticDocumentId ?? (transaction as { document_id?: string | null }).document_id ?? null
  // Only poll extraction status for documents the user attached during THIS
  // session. Pre-existing attached docs from prior sessions wouldn't change
  // status during this view, and polling them would be wasted requests.
  // Gated on HAS_AI_EXTRACTION so the free tier doesn't poll an endpoint
  // whose pipeline never runs.
  const extraction = useDocumentExtraction(
    HAS_AI_EXTRACTION ? optimisticDocumentId : null,
  )

  const hasInvoiceMatch = !!transaction.potential_invoice && !transaction.invoice_id
  const hasSupplierInvoiceMatch =
    !!transaction.potential_supplier_invoice && !transaction.supplier_invoice_id
  const isUncategorized = transaction.is_business === null && !transaction.journal_entry_id
  const selectable = isUncategorized && canWrite
  // Unbooked rows are still actionable (match, split, edit, categorize): that
  // includes imported bank rows, which are the whole point of the inbox.
  const isUnbooked = !transaction.journal_entry_id
  // ...but only rows the USER created in the app may be deleted. Imported rows
  // (bank sync / CSV) are ignore-only: mirrors the server guard in
  // DELETE /api/transactions/[id]. See lib/transactions/origin.ts.
  const canDelete = isUnbooked && !isImportedTransaction(transaction)
  // Title is editable only on a mutable staging row: not booked and not
  // confirmed-matched. Mirrors the server-side gate in PATCH /api/transactions/[id].
  const isTitleEditable =
    !transaction.journal_entry_id && !transaction.invoice_id && !transaction.supplier_invoice_id
  const originalName = transaction.original_description

  const matchLabel = hasInvoiceMatch
    ? t('match_invoice_btn', { number: transaction.potential_invoice!.invoice_number ?? '' })
    : hasSupplierInvoiceMatch
      ? t('match_supplier_invoice_btn', {
          number: transaction.potential_supplier_invoice!.supplier_invoice_number ?? '',
        })
      : null

  // Primary action: invoice/supplier-invoice match keeps the 1-click
  // shortcut; otherwise the user opens the template picker. Rendered as the
  // row-level quiet pill AND as the foldout's leading pill.
  const runPrimary = () => {
    if (matchLabel) onOpenMatchDialog(transaction)
    else onOpenCategoryDialog(transaction)
  }
  const primaryLabel = matchLabel ?? 'Bokför'

  // Manual invoice-match affordance. Hidden once an auto-detected match is
  // already shown as the primary button: having both makes the row noisy.
  const showInvoiceMatchButton =
    isUnbooked && !hasInvoiceMatch && !hasSupplierInvoiceMatch

  const invoiceMatchLabel = isIncome
    ? 'Matcha mot kundfaktura'
    : 'Matcha mot leverantörsfaktura'

  const splitMatchLabel = isIncome
    ? 'Dela inbetalningen på flera fakturor'
    : 'Dela utbetalningen på flera leverantörsfakturor'

  // Secondary row actions live twice, deliberately: as quiet links in the
  // foldout (concept vact) and in the row's ⋯ overflow menu for one-click use.
  // "Matcha mot befintlig verifikation": link to an already-booked voucher.
  // Available on any unbooked row (income or expense), independent of whether an
  // invoice match was auto-detected: the user may want to point the bank line at
  // an existing salary/Fortnox/manual voucher instead of confirming a payment.
  const showMatchVoucherItem = isUnbooked && !!onOpenMatchVoucher
  // "Matcha mot underlag": pin an inbox doc / fresh upload to the tx. The
  // tx→doc mirror of the Documents view's "Matcha mot transaktion".
  const showAttachDocumentItem = isUnbooked && canWrite && !!onOpenAttachDocument
  const showSplitItem = showInvoiceMatchButton && !!onOpenSplitMatch
  const showEditItem = isTitleEditable && !!onEditTitle
  // Moving between cash accounts only makes sense with somewhere to move TO,
  // and only for rows the server would accept: same movable gate as the title
  // (not booked, not confirmed-matched: mirrors PATCH .../cash-account).
  const showMoveAccountItem =
    isTitleEditable && canWrite && (cashAccounts?.length ?? 0) > 1 && !!onMoveCashAccount
  const showIgnoreItem = isUnbooked && isImportedTransaction(transaction) && !!onIgnore
  const showDeleteItem = canDelete && !!onDelete
  const showOverflowMenu =
    showInvoiceMatchButton || showMatchVoucherItem || showAttachDocumentItem || showSplitItem || showEditItem || showMoveAccountItem || showIgnoreItem || showDeleteItem

  // Pre-migration history row (ISO dates compare lexically): most likely
  // corresponds to an already-imported verifikat, so it carries a quiet
  // marker steering toward matching rather than re-booking.
  const isPreMigration = !!preMigrationCutoff && transaction.date <= preMigrationCutoff

  // The foldout carries row detail only (actions live on the row: pill + ⋯).
  // Rows with nothing to show don't expand at all; classified imported rows
  // always have at least the payment-method line.
  const hasFoldoutContent =
    Boolean(transaction.transaction_method) ||
    (transaction.currency !== 'SEK' && transaction.amount_sek != null) ||
    // No originalName requirement: below md the inline "redigerad" marker is
    // hidden, so the foldout is the only place the edited state survives; it
    // must open even when the original bank name is missing.
    Boolean(transaction.title_edited_at) ||
    Boolean(skvCounterpartDate) ||
    isPreMigration ||
    (HAS_AI_EXTRACTION && (extraction.status === 'running' || extraction.status === 'failed'))
  const canExpand = hasFoldoutContent
  // An exiting row's foldout closes with it: the foldout <tr> has no exit
  // styling of its own and would otherwise linger un-animated.
  const expanded = isExpanded && canExpand && !isExiting

  return (
    <>
      <tr
        data-tx-id={transaction.id}
        className={cn(
          'group transition-colors duration-150',
          canExpand && 'cursor-pointer',
          expanded ? 'bg-secondary/25' : 'hover:bg-secondary/35',
          isSelected && 'bg-secondary/40',
          isDisabled && 'opacity-50',
          isExiting && 'row-exit',
        )}
        // .row-exit only blocks pointer input; `inert` also drops keyboard
        // focus and activation (row expand, Bokför, the ⋯ menu) during the
        // 350ms removal window.
        inert={isExiting || undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        onClick={canExpand ? () => onToggleExpand(transaction.id) : undefined}
        onKeyDown={
          canExpand
            ? (e) => {
                // Only when the row itself is focused: Enter/Space on a nested
                // control (Bokför, ⋯, checkbox) bubbles here, and preventDefault
                // would cancel the button's keyboard activation.
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggleExpand(transaction.id)
                }
              }
            : undefined
        }
      >
        {/* Always-visible selection checkbox (concept .cb) */}
        {/* Zero-width cell: the checkbox hangs in the left page margin so
            the date column can sit flush with the page edge. */}
        <td
          className={cn(TD_CLASS, 'relative w-0 !p-0 select-none')}
          onClick={(e) => e.stopPropagation()}
        >
          {selectable && (
            <Checkbox
              checked={isSelected}
              onClick={(e) => {
                shiftHeld.current = e.shiftKey
              }}
              onCheckedChange={() => onToggleSelect(transaction.id, shiftHeld.current)}
              aria-label="Välj transaktion"
              className={cn(
                'absolute -left-5 top-1/2 -translate-y-1/2 border-foreground duration-150 md:-left-6',
                isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
              )}
            />
          )}
        </td>
        <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
          {formatDate(transaction.date)}
        </td>
        {/* overflow-hidden: the shrink-0 markers below don't truncate, so on
            a viewport too narrow for them the cell must clip instead of
            painting over the Belopp column. */}
        <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden')}>
          <span className="row-collapsible flex min-w-0 items-center gap-2">
            {/* Identity precedence mirrors normalizeMerchantKey()
                (lib/transactions/category-suggestions.ts): merchant_name when
                the feed carried one, else the raw descriptor. `description` is
                a user-editable working title, so keying the mark on it would
                change the icon on rename. */}
            <BrandMark label={transaction.merchant_name ?? originalName ?? transaction.description} />
            <span className="truncate">{transaction.description}</span>
            <TransactionAttachmentIndicator documentId={attachedDocumentId} />
            {/* The markers below are desktop-only (hidden md:*): on mobile
                they overflowed the cell into Belopp; their info stays
                reachable in the foldout (TransactionHistoryList gates its
                markers the same way). */}
            {transaction.title_edited_at && (
              <span
                className="hidden shrink-0 text-xs text-muted-foreground md:inline"
                title={originalName ? t('original_name_tooltip', { name: originalName }) : undefined}
              >
                {t('edited_badge')}
              </span>
            )}
            {skvCounterpartDate && (
              <Badge variant="warning" className="hidden h-4 shrink-0 gap-1 px-1.5 py-0 text-[10px] md:inline-flex">
                <AlertCircle className="h-3 w-3" />
                Möjlig 1930↔1630
              </Badge>
            )}
            {/* Quiet pre-migration marker (muted text, not a chip: it is
                context, not an exception state). */}
            {isPreMigration && (
              <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                {t('pre_migration_marker')}
              </span>
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
          {formatCurrency(transaction.amount, transaction.currency)}
        </td>
        <td className={cn(TD_CLASS, 'relative whitespace-nowrap text-right !pr-0 py-[9px]')}>
          <span className="row-collapsible inline-flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3.5 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                runPrimary()
              }}
              disabled={isProcessing || isDisabled}
            >
              {isProcessing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              {primaryLabel}
            </Button>
            {showOverflowMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* mr-2 tucks the button in so the dots glyph sits under
                      the middle of the STATUS header, not at the page edge. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mr-2 h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('more_actions_aria')}
                    title={t('more_actions_aria')}
                    disabled={isProcessing || isDisabled}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[14rem]">
                  {showInvoiceMatchButton && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenMatchInvoicePicker(transaction)
                      }}
                    >
                      <Link2 className="h-4 w-4" />
                      {invoiceMatchLabel}
                    </DropdownMenuItem>
                  )}
                  {showMatchVoucherItem && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenMatchVoucher!(transaction)
                      }}
                    >
                      <FileSearch className="h-4 w-4" />
                      {t('match_voucher_btn')}
                    </DropdownMenuItem>
                  )}
                  {showAttachDocumentItem && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenAttachDocument!(transaction)
                      }}
                    >
                      <Paperclip className="h-4 w-4" />
                      {t('attach_document_btn')}
                    </DropdownMenuItem>
                  )}
                  {showSplitItem && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenSplitMatch!(transaction)
                      }}
                    >
                      <Split className="h-4 w-4" />
                      {splitMatchLabel}
                    </DropdownMenuItem>
                  )}
                  {showEditItem && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditTitle!(transaction)
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      {t('edit_title_aria')}
                    </DropdownMenuItem>
                  )}
                  {showMoveAccountItem && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onMoveCashAccount!(transaction)
                      }}
                    >
                      <ArrowRightLeft className="h-4 w-4" />
                      {t('move_account_btn')}
                    </DropdownMenuItem>
                  )}
                  {(showIgnoreItem || showDeleteItem) && (showMatchVoucherItem || showAttachDocumentItem || showSplitItem || showEditItem || showMoveAccountItem) && (
                    <DropdownMenuSeparator />
                  )}
                  {showIgnoreItem && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onIgnore!(transaction)
                      }}
                    >
                      <EyeOff className="h-4 w-4" />
                      {t('ignore_btn')}
                    </DropdownMenuItem>
                  )}
                  {showDeleteItem && (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete!(transaction.id)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('delete_aria')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {/* Expand affordance hangs in the right page margin, mirroring
                the selection checkbox on the left. */}
            {canExpand && (
              <ChevronRight
                className={cn(
                  'absolute -right-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground transition-all duration-200 md:-right-6',
                  expanded ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              />
            )}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr data-no-stagger>
          <td colSpan={5} className="border-b border-border p-0">
            <RowFoldout>
              <div className="pb-6 pt-1">
                {transaction.transaction_method ||
                (transaction.currency !== 'SEK' && transaction.amount_sek != null) ||
                transaction.title_edited_at ||
                skvCounterpartDate ||
                isPreMigration ? (
                  <div className="space-y-1 py-1 text-xs text-muted-foreground">
                    {transaction.transaction_method && (
                      <p>
                        {t('method_line', {
                          method: tMethod(transaction.transaction_method),
                        })}
                      </p>
                    )}
                    {transaction.currency !== 'SEK' && transaction.amount_sek != null && (
                      <p className="tabular-nums">
                        {formatCurrency(transaction.amount, transaction.currency)}
                        {' · '}
                        {formatCurrency(transaction.amount_sek)}
                      </p>
                    )}
                    {transaction.title_edited_at && (
                      <p>
                        {originalName
                          ? t('original_name_tooltip', { name: originalName })
                          : t('edited_no_original')}
                      </p>
                    )}
                    {skvCounterpartDate && (
                      <p>
                        {t('skv_counterpart_label')}{' '}
                        {t('skv_counterpart_body', { date: skvCounterpartDate })}
                      </p>
                    )}
                    {isPreMigration && <p>{t('pre_migration_foldout')}</p>}
                  </div>
                ) : null}

                {/* Extraction status: visible only while AI is reading a freshly
                    attached document, or briefly if reading failed. */}
                {HAS_AI_EXTRACTION &&
                  (extraction.status === 'running' || extraction.status === 'failed') && (
                    <div className="py-1">
                      <ExtractionStatus
                        status={extraction.status}
                        elapsedMs={extraction.elapsedMs}
                      />
                    </div>
                  )}

              </div>
            </RowFoldout>
          </td>
        </tr>
      )}
    </>
  )
}
