'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  Unlink,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { TransactionDrawer, type DrawerAction } from './TransactionDrawer'
import { HUE_DOT_CLASS, type TemplateHue } from '@/lib/bookkeeping/template-group-colors'

/** Shell v2: the top suggestion for an unbooked row, shown in the Kategori cell. */
export interface RowProposal {
  label: string
  hue: TemplateHue
  confidence: number
  /** One line on why, the same words the review header uses. */
  why: string
}

// True when the AI tier is active: gates user-facing strings that promise
// AI behavior. On the free build (document-extraction disabled) we keep the
// upload functional but drop the "AI:n läser dokumentet" promise.
const HAS_AI_EXTRACTION = ENABLED_EXTENSION_IDS.has('document-extraction')
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { canDetachDocument } from './detach-underlag'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'
import type { CashAccount } from '@/types'
import type { TxColumnId } from '@/lib/transactions/columns-v2'

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
  /** Open the utlägg picker: book this outflow as the repayment of chosen
   *  registered claims (sum must equal the row). Passed only while the company
   *  has open claims, so the item never shows for the companies without any. */
  onOpenMatchExpense?: (transaction: TransactionWithInvoice) => void
  /** Open the attach-underlag dialog: pin an inbox document or a fresh upload
   *  to the transaction (the tx→doc mirror of the Documents view's matcher). */
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  /** Detach the pinned underlag (DELETE attach-document). Unbooked rows only:
   *  once the doc has propagated onto a verifikation the route answers 409. */
  onDetachDocument?: (transaction: TransactionWithInvoice) => void
  /** Shell v2 passes the element that asked, so the picker can open beside it. */
  onOpenCategoryDialog: (transaction: TransactionWithInvoice, anchor?: HTMLElement) => void
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
  /**
   * Shell v2 (dev_docs/ui_v2_build_plan.md, PR 4): the visible columns.
   * Undefined = the v1 five-column row, byte-identical.
   */
  columns?: ReadonlySet<TxColumnId>
  /** Konto column: bank and account, resolved by the page from cashAccounts. */
  accountLabel?: string | null
  /** Kategori column: a match hint; null shows the "Välj kategori" prompt. */
  categoryLabel?: string | null
  /** Shell v2: brand icon for the Konto cell (bank, Stripe, Skatteverket). */
  accountLogo?: string | null
  /** Shell v2: the top rule or keyword suggestion, shown in the Kategori cell; Bokför uses it. */
  proposal?: RowProposal | null
  /** Shell v2: book the row with its proposal (opens the review with the template set). */
  onBookProposal?: (transaction: TransactionWithInvoice) => void
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
  onOpenMatchExpense,
  onOpenAttachDocument,
  onDetachDocument,
  onOpenCategoryDialog,
  onDelete,
  onIgnore,
  onEditTitle,
  onMoveCashAccount,
  cashAccounts,
  onToggleSelect,
  preMigrationCutoff = null,
  columns,
  accountLabel = null,
  categoryLabel = null,
  accountLogo = null,
  proposal = null,
  onBookProposal,
}: TransactionInboxCardProps) {
  const show = (c: TxColumnId) => !columns || columns.has(c)
  const t = useTranslations('tx_inbox_card')
  const tDetach = useTranslations('tx_detach')
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
    // Detach (page handler) drops the override too, or the indicator would
    // keep showing a doc the row no longer carries.
    function onUnlinked(e: Event) {
      const detail = (e as CustomEvent<{ transaction_id?: string }>).detail
      if (!detail || detail.transaction_id !== transaction.id) return
      setOptimisticDocumentId(null)
    }
    window.addEventListener('Accounted:transaction-document-linked', onLinked)
    window.addEventListener('Accounted:transaction-document-unlinked', onUnlinked)
    return () => {
      window.removeEventListener('Accounted:transaction-document-linked', onLinked)
      window.removeEventListener('Accounted:transaction-document-unlinked', onUnlinked)
    }
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
  // Skatteverkets ROT/RUT-utbetalning for one or several open begäran: same
  // 1-click shortcut as an invoice match, confirmed in its own dialog.
  const rotRutRequests = transaction.potential_rot_rut_payout?.requests ?? []
  const hasRotRutPayoutMatch = rotRutRequests.length > 0 && !transaction.journal_entry_id
  // A transfer that repays one person's registered utlägg to the öre: same
  // 1-click shortcut, confirmed in its own dialog.
  const hasExpensePayoutMatch = !!transaction.potential_expense_payout && !transaction.journal_entry_id
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
      : hasRotRutPayoutMatch
        ? rotRutRequests.length === 1
          ? t('match_rot_rut_payout_btn', { name: rotRutRequests[0].name })
          : t('match_rot_rut_payout_set_btn', { count: rotRutRequests.length })
        : hasExpensePayoutMatch
          ? t('match_expense_payout_btn', { name: transaction.potential_expense_payout!.claimant_name })
          : null

  // Primary action: invoice/supplier-invoice match keeps the 1-click
  // shortcut; otherwise the user opens the template picker. Rendered as the
  // row-level quiet pill AND as the foldout's leading pill.
  const runPrimary = (anchor?: HTMLElement) => {
    if (matchLabel) onOpenMatchDialog(transaction)
    else if (proposal && onBookProposal) onBookProposal(transaction)
    else onOpenCategoryDialog(transaction, anchor)
  }
  const primaryLabel = matchLabel ?? 'Bokför'

  // Manual invoice-match affordance. Hidden once an auto-detected match is
  // already shown as the primary button: having both makes the row noisy.
  const showInvoiceMatchButton =
    isUnbooked && !hasInvoiceMatch && !hasSupplierInvoiceMatch && !hasRotRutPayoutMatch && !hasExpensePayoutMatch

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
  const showMatchExpenseItem = isUnbooked && !isIncome && !!onOpenMatchExpense && !hasExpensePayoutMatch
  // "Matcha mot underlag": pin an inbox doc / fresh upload to the tx. The
  // tx→doc mirror of the Documents view's "Matcha mot transaktion".
  const showAttachDocumentItem = isUnbooked && canWrite && !!onOpenAttachDocument
  // Same gate as attach, plus an actual pin to remove.
  const showDetachDocumentItem =
    showAttachDocumentItem &&
    canDetachDocument({
      isBooked: !isUnbooked,
      canWrite,
      documentId: attachedDocumentId,
      hasHandler: !!onDetachDocument,
    })
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
    showInvoiceMatchButton || showMatchVoucherItem || showMatchExpenseItem || showAttachDocumentItem || showSplitItem || showEditItem || showMoveAccountItem || showIgnoreItem || showDeleteItem

  // Pre-migration history row (ISO dates compare lexically): most likely
  // corresponds to an already-imported verifikat, so it carries a quiet
  // marker steering toward matching rather than re-booking.
  const isPreMigration = !!preMigrationCutoff && transaction.date <= preMigrationCutoff

  // The overflow actions as data: the row's ⋯ menu and the v2 drawer render
  // the same list, in the same order, from one place.
  const overflowItems: DrawerAction[] = []
  if (showInvoiceMatchButton)
    overflowItems.push({ key: 'invoice', label: invoiceMatchLabel, icon: Link2, onSelect: () => onOpenMatchInvoicePicker(transaction) })
  if (showMatchVoucherItem)
    overflowItems.push({ key: 'voucher', label: t('match_voucher_btn'), icon: FileSearch, onSelect: () => onOpenMatchVoucher!(transaction) })
  if (showMatchExpenseItem)
    overflowItems.push({ key: 'expense', label: t('match_expense_btn'), icon: FileSearch, onSelect: () => onOpenMatchExpense!(transaction) })
  if (showAttachDocumentItem)
    overflowItems.push({ key: 'attach', label: t('attach_document_btn'), icon: Paperclip, onSelect: () => onOpenAttachDocument!(transaction) })
  if (showDetachDocumentItem)
    overflowItems.push({ key: 'detach', label: tDetach('menu_item'), icon: Unlink, onSelect: () => onDetachDocument!(transaction) })
  if (showSplitItem) overflowItems.push({ key: 'split', label: splitMatchLabel, icon: Split, onSelect: () => onOpenSplitMatch!(transaction) })
  if (showEditItem) overflowItems.push({ key: 'edit', label: t('edit_title_aria'), icon: Pencil, onSelect: () => onEditTitle!(transaction) })
  if (showMoveAccountItem)
    overflowItems.push({ key: 'move', label: t('move_account_btn'), icon: ArrowRightLeft, onSelect: () => onMoveCashAccount!(transaction) })
  const dangerItems: DrawerAction[] = []
  if (showIgnoreItem) dangerItems.push({ key: 'ignore', label: t('ignore_btn'), icon: EyeOff, onSelect: () => onIgnore!(transaction) })
  if (showDeleteItem) dangerItems.push({ key: 'delete', label: t('delete_aria'), icon: Trash2, onSelect: () => onDelete!(transaction.id), destructive: true })
  const showDangerSeparator =
    (showIgnoreItem || showDeleteItem) && (showMatchVoucherItem || showAttachDocumentItem || showSplitItem || showEditItem || showMoveAccountItem)

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
  // Shell v2 (columns set): every row opens the drawer, which always has
  // something to show; v1 folds out only when the row has detail lines.
  const canExpand = columns ? true : hasFoldoutContent
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
        {/* v1: zero-width cell, the checkbox hangs in the left page margin so
            the date column can sit flush with the page edge. v2 (columns
            set): a real first column, since the full-bleed panel has no
            margin for it to hang in. */}
        <td
          className={cn(TD_CLASS, 'select-none', columns ? 'w-7 !pl-0 !pr-2' : 'relative w-0 !p-0')}
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
                'border-foreground duration-150',
                columns ? 'block' : 'absolute -left-5 top-1/2 -translate-y-1/2 md:-left-6',
                isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
              )}
            />
          )}
        </td>
        {show('date') && (
          <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
            {formatDate(transaction.date)}
          </td>
        )}
        {/* overflow-hidden: the shrink-0 markers below don't truncate, so on
            a viewport too narrow for them the cell must clip instead of
            painting over the Belopp column. */}
        <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden')}>
          <span className="row-collapsible flex min-w-0 items-center gap-2">
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
        {columns?.has('category') && (
          <td className={cn(TD_CLASS, 'whitespace-nowrap')} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={cn(
                'inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs transition-colors duration-150',
                categoryLabel || proposal
                  ? 'text-foreground hover:bg-secondary/60'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={(e) => onOpenCategoryDialog(transaction, e.currentTarget)}
              disabled={isProcessing || isDisabled}
              title={!categoryLabel && proposal ? t('proposal_title', { label: proposal.label, percent: Math.round(proposal.confidence * 100) }) : undefined}
            >
              {!categoryLabel && proposal && (
                <span className={cn('h-2 w-2 shrink-0 rounded-full', HUE_DOT_CLASS[proposal.hue])} aria-hidden />
              )}
              <span className="truncate">{categoryLabel ?? proposal?.label ?? t('category_pick')}</span>
            </button>
          </td>
        )}
        {columns?.has('account') && (
          <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
            <span className="inline-flex items-center gap-2">
              {accountLogo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={accountLogo} alt="" className="h-4 w-4 shrink-0 rounded-sm object-contain" />
              )}
              {accountLabel ?? ''}
            </span>
          </td>
        )}
        {show('amount') && (
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
        )}
        <td className={cn(TD_CLASS, 'relative whitespace-nowrap text-right !pr-0 py-[9px]')}>
          <span className="row-collapsible inline-flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3.5 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                runPrimary(e.currentTarget)
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
                  {overflowItems.map((item) => (
                    <DropdownMenuItem
                      key={item.key}
                      onClick={(e) => {
                        e.stopPropagation()
                        item.onSelect()
                      }}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                  {showDangerSeparator && <DropdownMenuSeparator />}
                  {dangerItems.map((item) => (
                    <DropdownMenuItem
                      key={item.key}
                      className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
                      onClick={(e) => {
                        e.stopPropagation()
                        item.onSelect()
                      }}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {/* Expand affordance hangs in the right page margin, mirroring
                the selection checkbox on the left. */}
            {canExpand && !columns && (
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
      {expanded &&
        columns &&
        createPortal(
          <TransactionDrawer
            transaction={transaction}
            accountLabel={accountLabel}
            categoryLabel={categoryLabel ?? proposal?.label ?? null}
            proposalWhy={!categoryLabel && proposal ? proposal.why : null}
            accountLogo={accountLogo}
            primaryLabel={primaryLabel}
            onPrimary={(anchor) => runPrimary(anchor)}
            onOpenCategory={(anchor) => onOpenCategoryDialog(transaction, anchor)}
            actions={[...overflowItems, ...dangerItems]}
            methodLabel={transaction.transaction_method ? tMethod(transaction.transaction_method) : null}
            originalName={originalName ?? null}
            skvCounterpartDate={skvCounterpartDate}
            isPreMigration={isPreMigration}
            attachedDocumentId={attachedDocumentId}
            extra={
              HAS_AI_EXTRACTION && (extraction.status === 'running' || extraction.status === 'failed') ? (
                <ExtractionStatus status={extraction.status} elapsedMs={extraction.elapsedMs} />
              ) : null
            }
            processing={isProcessing}
            onClose={() => onToggleExpand(transaction.id)}
          />,
          document.body,
        )}
      {expanded && !columns && (
        <tr data-no-stagger>
          {/* v1 only (the drawer covers v2), so the five-column head. */}
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
