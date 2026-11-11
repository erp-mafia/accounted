'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { useDocumentExtraction } from '@/lib/hooks/use-document-extraction'
import ExtractionStatus from '@/components/ui/extraction-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TD_CLASS, RowSelectCheckbox, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { canOfferSplitMatch } from '@/lib/transactions/split-match'
import {
  ArrowsRightLeftIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  ExclamationCircleIcon,
  EyeSlashIcon,
  LinkIcon,
  LinkSlashIcon,
  PaperClipIcon,
  PencilIcon,
  ScissorsIcon,
  TrashIcon,
} from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import dynamic from 'next/dynamic'
import type { DrawerAction } from './TransactionDrawer'

// The drawer, and the document viewer it carries, load on the first expand:
// the list's own chunk stays free of them.
const TransactionDrawer = dynamic(() => import('./TransactionDrawer').then((m) => m.TransactionDrawer), { ssr: false })
import { HUE_DOT_CLASS, type TemplateHue } from '@/lib/bookkeeping/template-group-colors'

/** The top suggestion for an unbooked row, shown in the Kategori cell. */
export interface RowProposal {
  label: string
  hue: TemplateHue
  confidence: number
  /** One line on why, the same words the review header uses. */
  why: string
  /** The person set it in the review (lib/transactions/review-choice.ts): theirs, not a recommendation. */
  own?: boolean
}

// True when the AI tier is active: gates user-facing strings that promise
// AI behavior. On the free build (document-extraction disabled) we keep the
// upload functional but drop the "AI:n läser dokumentet" promise.
const HAS_AI_EXTRACTION = ENABLED_EXTENSION_IDS.has('document-extraction')
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { canDetachDocument } from './detach-underlag'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'
import type { BatchAllocationPrefill } from '@/lib/transactions/parts-read'
import type { CashAccount } from '@/types'
import type { TxColumnId } from '@/lib/transactions/columns-v2'
import type { GiroCounterparty } from '@/lib/transactions/giro-counterparty'
import { bankRowTitle } from '@/lib/transactions/row-title'
import { useGiroText } from './use-giro-text'

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
   *  source-compatible. `prefill` carries the allocations the row's Bankgirot
   *  split suggests (the drawer's "Matcha N fakturor"). */
  onOpenSplitMatch?: (transaction: TransactionWithInvoice, prefill?: BatchAllocationPrefill[]) => void
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
  /** The page passes the element that asked, so the picker can open beside it. */
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
  /** Pre-migration history the imported bokföring already explains: dated
   *  inside its coverage, with unlinked vouchers of the same amount within a
   *  week (GET /api/transactions/migration-coverage). The row carries a quiet
   *  marker steering toward matching rather than re-booking. Date alone is
   *  not enough: it marked rows the old system never booked (crm#1239). */
  preMigration?: boolean
  /** The visible columns (lib/transactions/columns-v2, UI v2 PR 4). */
  columns: ReadonlySet<TxColumnId>
  /** Konto column: bank and account, resolved by the page from cashAccounts. */
  accountLabel?: string | null
  /** Kategori column: a match hint; null shows the "Välj kategori" prompt. */
  categoryLabel?: string | null
  /** Brand icon for the Konto cell (bank, Stripe, Skatteverket). */
  accountLogo?: string | null
  /** The top rule or keyword suggestion, shown in the Kategori cell; Bokför uses it. */
  proposal?: RowProposal | null
  /** Book the row with its proposal (opens the review with the template set). */
  onBookProposal?: (transaction: TransactionWithInvoice) => void
  /**
   * The period ("2026-10") of a booked salary run that already pays this row
   * out (lib/transactions/salary-run-payouts.ts, crm#1685): the primary
   * action matches the row to the run's verifikat (onOpenMatchVoucher)
   * instead of booking it again.
   */
  salaryRunPeriod?: string | null
  /** Whose giro number a row that names nobody shows (lib/transactions/giro-counterparty, crm#1204). */
  giroCounterparty?: GiroCounterparty | null
}

/**
 * A bank transaction in the inbox, rendered as a dry-table row (concept scene
 * 10): selection checkbox, the visible columns and the primary action as a
 * quiet pill. A click opens the drawer with the row's detail and full action
 * set; the ⋯ overflow menu stays on the row for one-click access to the same
 * actions.
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
  preMigration = false,
  columns,
  accountLabel = null,
  categoryLabel = null,
  accountLogo = null,
  proposal = null,
  onBookProposal,
  salaryRunPeriod = null,
  giroCounterparty = null,
}: TransactionInboxCardProps) {
  const show = (c: TxColumnId) => columns.has(c)
  const t = useTranslations('tx_inbox_card')
  const giroText = useGiroText()
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

  // A booked salary run's net pay: matched to the run's verifikat in the
  // existing-verifikat matcher, which opens with it picked; booking the row
  // again would count the salary twice.
  const salaryRunLabel =
    salaryRunPeriod && isUnbooked && onOpenMatchVoucher
      ? t('match_salary_run_btn', { period: salaryRunPeriod })
      : null

  // Primary action: invoice/supplier-invoice match keeps the 1-click
  // shortcut, then a salary run's payout; otherwise the user opens the
  // template picker. Rendered as the row-level quiet pill AND as the
  // drawer's leading pill.
  const runPrimary = (anchor?: HTMLElement) => {
    if (matchLabel) onOpenMatchDialog(transaction)
    else if (salaryRunLabel && onOpenMatchVoucher) onOpenMatchVoucher(transaction)
    else if (proposal && onBookProposal) onBookProposal(transaction)
    else onOpenCategoryDialog(transaction, anchor)
  }
  const primaryLabel = matchLabel ?? salaryRunLabel ?? 'Bokför'

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

  // Secondary row actions live twice, deliberately: in the drawer and in the
  // row's ⋯ overflow menu for one-click use.
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
  // Not gated on the invoice suggestion: one payment for several invoices is
  // exactly when the matcher still suggests a single one (see split-match.ts).
  const showSplitItem =
    canOfferSplitMatch({ isUnbooked, hasRotRutPayoutMatch, hasExpensePayoutMatch }) && !!onOpenSplitMatch
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

  // Pre-migration history row the imported bokföring explains: it carries a
  // quiet marker steering toward matching rather than re-booking.
  const isPreMigration = preMigration
  // The Bankgirot split behind the row (bank_transaction_parts), counted by
  // the list fetch: a quiet marker; the parts themselves are in the drawer.
  const partsCount = transaction.parts_count?.[0]?.count ?? 0

  // The overflow actions as data: the row's ⋯ menu and the drawer render
  // the same list, in the same order, from one place.
  const overflowItems: DrawerAction[] = []
  if (showInvoiceMatchButton)
    overflowItems.push({ key: 'invoice', label: invoiceMatchLabel, icon: LinkIcon, onSelect: () => onOpenMatchInvoicePicker(transaction) })
  if (showMatchVoucherItem)
    overflowItems.push({ key: 'voucher', label: t('match_voucher_btn'), icon: DocumentMagnifyingGlassIcon, onSelect: () => onOpenMatchVoucher!(transaction) })
  if (showMatchExpenseItem)
    overflowItems.push({ key: 'expense', label: t('match_expense_btn'), icon: DocumentMagnifyingGlassIcon, onSelect: () => onOpenMatchExpense!(transaction) })
  if (showAttachDocumentItem)
    overflowItems.push({ key: 'attach', label: t('attach_document_btn'), icon: PaperClipIcon, onSelect: () => onOpenAttachDocument!(transaction) })
  if (showDetachDocumentItem)
    overflowItems.push({ key: 'detach', label: tDetach('menu_item'), icon: LinkSlashIcon, onSelect: () => onDetachDocument!(transaction) })
  if (showSplitItem) overflowItems.push({ key: 'split', label: splitMatchLabel, icon: ScissorsIcon, onSelect: () => onOpenSplitMatch!(transaction) })
  if (showEditItem) overflowItems.push({ key: 'edit', label: t('edit_title_aria'), icon: PencilIcon, onSelect: () => onEditTitle!(transaction) })
  if (showMoveAccountItem)
    overflowItems.push({ key: 'move', label: t('move_account_btn'), icon: ArrowsRightLeftIcon, onSelect: () => onMoveCashAccount!(transaction) })
  const dangerItems: DrawerAction[] = []
  if (showIgnoreItem) dangerItems.push({ key: 'ignore', label: t('ignore_btn'), icon: EyeSlashIcon, onSelect: () => onIgnore!(transaction) })
  if (showDeleteItem) dangerItems.push({ key: 'delete', label: t('delete_aria'), icon: TrashIcon, onSelect: () => onDelete!(transaction.id), destructive: true })
  const showDangerSeparator =
    (showIgnoreItem || showDeleteItem) && (showMatchVoucherItem || showAttachDocumentItem || showSplitItem || showEditItem || showMoveAccountItem)

  // Every row opens the drawer, which always has something to show. An
  // exiting row's drawer closes with it.
  const expanded = isExpanded && !isExiting

  return (
    <>
      <tr
        data-tx-id={transaction.id}
        className={cn(
          'group transition-colors duration-150',
          'cursor-pointer',
          expanded ? 'bg-secondary/25' : 'hover:bg-secondary/35',
          isSelected && 'bg-secondary/40',
          isDisabled && 'opacity-50',
          isExiting && 'row-exit',
        )}
        // .row-exit only blocks pointer input; `inert` also drops keyboard
        // focus and activation (row expand, Bokför, the ⋯ menu) during the
        // 350ms removal window.
        inert={isExiting || undefined}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => onToggleExpand(transaction.id)}
        onKeyDown={(e) => {
          // Only when the row itself is focused: Enter/Space on a nested
          // control (Bokför, ⋯, checkbox) bubbles here, and preventDefault
          // would cancel the button's keyboard activation.
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleExpand(transaction.id)
          }
        }}
      >
        {/* Always-visible selection checkbox (concept .cb) in a real first
            column: the full-bleed panel has no margin for it to hang in. */}
        <td
          className={cn(TD_CLASS, 'select-none', 'w-7 !pl-0 !pr-2')}
          onClick={(e) => e.stopPropagation()}
        >
          {selectable && (
            <RowSelectCheckbox
              checked={isSelected}
              onClick={(e) => {
                shiftHeld.current = e.shiftKey
              }}
              onCheckedChange={() => onToggleSelect(transaction.id, shiftHeld.current)}
              aria-label="Välj transaktion"
              className="block"
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
            <span className="truncate">{bankRowTitle(transaction)}</span>
            {/* Derived, beside the bank's text: whose giro the row shows. */}
            {giroCounterparty && (
              <span
                className="hidden max-w-[16rem] shrink-0 truncate text-xs text-muted-foreground md:inline-block"
                title={giroText.sentence(giroCounterparty)}
              >
                {giroText.short(giroCounterparty)}
              </span>
            )}
            <TransactionAttachmentIndicator documentId={attachedDocumentId} />
            {/* The markers below are desktop-only (hidden md:*): on mobile
                they overflowed the cell into Belopp; their info stays
                reachable in the drawer (TransactionHistoryList gates its
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
              <Badge variant="warning" className="hidden h-4 shrink-0 gap-1 px-1.5 py-0 text-[11px] md:inline-flex">
                <ExclamationCircleIcon className="h-3 w-3" />
                Möjlig bank↔skattekonto
              </Badge>
            )}
            {/* Quiet pre-migration marker (muted text, not a chip: it is
                context, not an exception state). */}
            {isPreMigration && (
              <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                {t('pre_migration_marker')}
              </span>
            )}
            {partsCount > 1 && (
              <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                {t('parts_hint', { count: partsCount })}
              </span>
            )}
          </span>
        </td>
        {columns.has('category') && (
          <td className={cn(TD_CLASS, 'whitespace-nowrap')} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={cn(
                'inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border px-3 py-0.5 text-xs transition-colors duration-150',
                categoryLabel || proposal
                  ? 'text-foreground hover:bg-secondary/60'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={(e) => onOpenCategoryDialog(transaction, e.currentTarget)}
              disabled={isProcessing || isDisabled}
              title={
                !categoryLabel && proposal
                  ? proposal.own
                    ? proposal.why
                    : t('proposal_title', { label: proposal.label, percent: Math.round(proposal.confidence * 100) })
                  : undefined
              }
            >
              {!categoryLabel && proposal && (
                <span className={cn('h-2 w-2 shrink-0 rounded-full', HUE_DOT_CLASS[proposal.hue])} aria-hidden />
              )}
              <span className="truncate">{categoryLabel ?? proposal?.label ?? t('category_pick')}</span>
            </button>
          </td>
        )}
        {columns.has('account') && (
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
              onClick={(e) => {
                e.stopPropagation()
                runPrimary(e.currentTarget)
              }}
              disabled={isDisabled}
              loading={isProcessing}
            >
              {primaryLabel}
            </Button>
            {showOverflowMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* mr-2 tucks the button in so the dots glyph sits under
                      the middle of the STATUS header, not at the page edge. */}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn('mr-2 text-muted-foreground hover:text-foreground data-[state=open]:opacity-100', HOVER_REVEAL_CLASS)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('more_actions_aria')}
                    title={t('more_actions_aria')}
                    disabled={isProcessing || isDisabled}
                  >
                    <EllipsisHorizontalIcon className="h-4 w-4" />
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
          </span>
        </td>
      </tr>
      {expanded &&
        createPortal(
          <TransactionDrawer
            transaction={transaction}
            accountLabel={accountLabel}
            categoryLabel={categoryLabel ?? proposal?.label ?? null}
            proposalWhy={!categoryLabel && proposal ? proposal.why : null}
            proposalOwn={!categoryLabel && !!proposal?.own}
            accountLogo={accountLogo}
            primaryLabel={primaryLabel}
            onPrimary={(anchor) => runPrimary(anchor)}
            onOpenCategory={(anchor) => onOpenCategoryDialog(transaction, anchor)}
            actions={[...overflowItems, ...dangerItems]}
            methodLabel={transaction.transaction_method ? tMethod(transaction.transaction_method) : null}
            originalName={originalName ?? null}
            skvCounterpartDate={skvCounterpartDate}
            isPreMigration={isPreMigration}
            giroCounterparty={giroCounterparty}
            attachedDocumentId={attachedDocumentId}
            onMatchParts={showSplitItem ? (prefill) => onOpenSplitMatch!(transaction, prefill) : undefined}
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
    </>
  )
}
