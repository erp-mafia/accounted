'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useDocumentExtraction } from '@/lib/hooks/use-document-extraction'
import ExtractionStatus from '@/components/ui/extraction-status'
import { motion } from 'framer-motion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
} from '@/components/ui/data-list'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isImportedTransaction } from '@/lib/transactions/origin'
import {
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
  EyeOff,
  FileSearch,
  FileText,
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

// True when the AI tier is active — gates user-facing strings that promise
// AI behavior. On the free build (document-extraction disabled) we keep the
// upload functional but drop the "AI:n läser dokumentet" promise.
const HAS_AI_EXTRACTION = ENABLED_EXTENSION_IDS.has('document-extraction')
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'

interface TransactionInboxCardProps {
  transaction: TransactionWithInvoice
  /** When set, this bank tx looks like the bank side of a 1930↔1630
   *  transfer that the user will later see on /skattekonto. */
  skvCounterpartDate?: string
  processingId: string | null
  isBatchMode: boolean
  isSelected: boolean
  entityType?: string
  onCategorize: CategorizeHandler
  /** Confirm an auto-detected invoice match (1-click shortcut). */
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  /** Open the manual picker — routes to customer or supplier picker by amount sign. */
  onOpenMatchInvoicePicker: (transaction: TransactionWithInvoice) => void
  /** Open the split-payment allocator (1 tx → N invoices) — same direction
   *  detection as the single-pick picker. Optional so legacy callers stay
   *  source-compatible. */
  onOpenSplitMatch?: (transaction: TransactionWithInvoice) => void
  /** Open the existing-verifikat matcher — link the bank tx to an already-booked
   *  voucher (salary, Fortnox import, manual entry) with no new bokföring. */
  onOpenMatchVoucher?: (transaction: TransactionWithInvoice) => void
  /** Open the attach-underlag dialog — pin an inbox document or a fresh upload
   *  to the transaction (the tx→doc mirror of the Documents view's matcher). */
  onOpenAttachDocument?: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  /** Mark the transaction as ignored so it leaves the inbox without a journal entry. */
  onIgnore?: (transaction: TransactionWithInvoice) => void
  /** Open the edit-title dialog. Only wired for editable (unbooked/unmatched) rows. */
  onEditTitle?: (transaction: TransactionWithInvoice) => void
  onToggleSelect: (id: string) => void
  onAnimationComplete?: (id: string) => void
}

export default function TransactionInboxCard({
  transaction,
  skvCounterpartDate,
  processingId,
  isBatchMode,
  isSelected,
  onOpenMatchDialog,
  onOpenMatchInvoicePicker,
  onOpenSplitMatch,
  onOpenMatchVoucher,
  onOpenAttachDocument,
  onOpenCategoryDialog,
  onDelete,
  onIgnore,
  onEditTitle,
  onToggleSelect,
  onAnimationComplete,
}: TransactionInboxCardProps) {
  const t = useTranslations('tx_inbox_card')
  // Attaching underlag is a write — hide the affordance from viewers so they
  // don't dead-end on a 403 (mirrors the gate in TransactionHistoryList).
  const { canWrite } = useCanWrite()
  const isProcessing = processingId === transaction.id
  const isDisabled = processingId !== null && processingId !== transaction.id
  const isIncome = transaction.amount > 0
  // Optimistic override — flips the indicator to "attached" as soon as the
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
  const showCheckbox = isBatchMode && isUncategorized
  // Unbooked rows are still actionable (match, split, edit, categorize) — that
  // includes imported bank rows, which are the whole point of the inbox.
  const isUnbooked = !transaction.journal_entry_id
  // ...but only rows the USER created in the app may be deleted. Imported rows
  // (bank sync / CSV) are ignore-only — mirrors the server guard in
  // DELETE /api/transactions/[id]. See lib/transactions/origin.ts.
  const canDelete = isUnbooked && !isImportedTransaction(transaction)
  // Title is editable only on a mutable staging row — not booked and not
  // confirmed-matched. Mirrors the server-side gate in PATCH /api/transactions/[id].
  const isTitleEditable =
    !transaction.journal_entry_id && !transaction.invoice_id && !transaction.supplier_invoice_id
  const originalName = transaction.original_description

  // Primary action: invoice/supplier-invoice match keeps the 1-click shortcut;
  // otherwise the user opens the template picker.
  const primaryAction = (() => {
    if (hasInvoiceMatch) {
      return (
        <Button
          size="sm"
          variant="default"
          className="h-9 px-3 text-sm"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMatchDialog(transaction)
          }}
          disabled={isProcessing || isDisabled}
        >
          {isProcessing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('match_invoice_btn', {
            number: transaction.potential_invoice!.invoice_number ?? '',
          })}
        </Button>
      )
    }
    if (hasSupplierInvoiceMatch) {
      return (
        <Button
          size="sm"
          variant="default"
          className="h-9 px-3 text-sm"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMatchDialog(transaction)
          }}
          disabled={isProcessing || isDisabled}
        >
          {isProcessing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('match_supplier_invoice_btn', {
            number: transaction.potential_supplier_invoice!.supplier_invoice_number ?? '',
          })}
        </Button>
      )
    }
    return (
      <Button
        size="sm"
        variant="default"
        className="h-9 px-3 text-sm"
        onClick={(e) => {
          e.stopPropagation()
          onOpenCategoryDialog(transaction)
        }}
        disabled={isProcessing || isDisabled}
      >
        Bokför
      </Button>
    )
  })()

  // Manual invoice-match affordance. Hidden once an auto-detected match is
  // already shown as the primary button — having both makes the row noisy.
  const showInvoiceMatchButton =
    isUnbooked && !hasInvoiceMatch && !hasSupplierInvoiceMatch

  const invoiceMatchLabel = isIncome
    ? 'Matcha mot kundfaktura'
    : 'Matcha mot leverantörsfaktura'

  const splitMatchLabel = isIncome
    ? 'Dela inbetalningen på flera fakturor'
    : 'Dela utbetalningen på flera leverantörsfakturor'

  // Secondary row actions are collapsed into a single ⋯ overflow menu to keep
  // the inbox row uncluttered. Bokför + the invoice-match button stay inline.
  // "Matcha mot befintlig verifikation" — link to an already-booked voucher.
  // Available on any unbooked row (income or expense), independent of whether an
  // invoice match was auto-detected: the user may want to point the bank line at
  // an existing salary/Fortnox/manual voucher instead of confirming a payment.
  const showMatchVoucherItem = isUnbooked && !!onOpenMatchVoucher
  // "Matcha mot underlag" — pin an inbox doc / fresh upload to the tx. The
  // tx→doc mirror of the Documents view's "Matcha mot transaktion".
  const showAttachDocumentItem = isUnbooked && canWrite && !!onOpenAttachDocument
  const showSplitItem = showInvoiceMatchButton && !!onOpenSplitMatch
  const showEditItem = isTitleEditable && !!onEditTitle
  const showIgnoreItem = isUnbooked && isImportedTransaction(transaction) && !!onIgnore
  const showDeleteItem = canDelete && !!onDelete
  const showOverflowMenu =
    showMatchVoucherItem || showAttachDocumentItem || showSplitItem || showEditItem || showIgnoreItem || showDeleteItem

  return (
    <motion.div
      layout
      initial={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, x: -16 }}
      transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      onAnimationComplete={(definition) => {
        if (typeof definition === 'object' && 'opacity' in definition && definition.opacity === 0) {
          onAnimationComplete?.(transaction.id)
        }
      }}
    >
      <DataListRow
        data-tx-id={transaction.id}
        selected={isSelected}
        className={cn(isDisabled && 'opacity-50')}
        rowClassName="py-4 gap-4"
        onClick={showCheckbox ? () => onToggleSelect(transaction.id) : undefined}
        leading={
          showCheckbox ? (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect(transaction.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label="Välj transaktion"
            />
          ) : (
            <span
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center',
                isIncome ? 'text-success' : 'text-foreground/60'
              )}
              aria-hidden
            >
              {isIncome ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : (
                <ArrowDownRight className="h-5 w-5" />
              )}
            </span>
          )
        }
        trailing={
          <>
            <div className="text-right">
              <p
                className={cn(
                  'text-base font-medium tabular-nums leading-none',
                  isIncome && 'text-success'
                )}
              >
                {isIncome ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </p>
              {transaction.currency !== 'SEK' && transaction.amount_sek != null && (
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {formatCurrency(transaction.amount_sek)}
                </p>
              )}
            </div>
            {!isBatchMode && (
              <>
                {primaryAction}
                {showInvoiceMatchButton && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMatchInvoicePicker(transaction)
                    }}
                    aria-label={invoiceMatchLabel}
                    title={invoiceMatchLabel}
                    disabled={isProcessing || isDisabled}
                  >
                    <Link2 className="h-4 w-4" />
                  </Button>
                )}
                {/* The Paperclip indicator next to the description
                    (TransactionAttachmentIndicator) is the single click
                    target for opening the underlag. We deliberately don't
                    duplicate that with a second icon in the trailing slot.
                    Per-transaction agent help has moved to Dokumentinkorgen:
                    match the underlag to the transaction and ask from there,
                    where the receipt/invoice is in view. */}
                {/* Secondary actions (split, edit, delete) collapse into a ⋯
                    overflow menu so the row stays uncluttered. */}
                {showOverflowMenu && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-foreground"
                        onClick={(e) => e.stopPropagation()}
                        aria-label={t('more_actions_aria')}
                        title={t('more_actions_aria')}
                        disabled={isProcessing || isDisabled}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[14rem]">
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
                      {(showIgnoreItem || showDeleteItem) && (showMatchVoucherItem || showAttachDocumentItem || showSplitItem || showEditItem) && (
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
              </>
            )}
          </>
        }
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <DataListPrimary className="text-base">{transaction.description}</DataListPrimary>
          <TransactionAttachmentIndicator documentId={attachedDocumentId} />
        </div>
        <DataListMeta className="mt-1">
          <span className="tabular-nums">{formatDate(transaction.date)}</span>
          {transaction.title_edited_at && (
            <>
              <DataListMetaSeparator />
              <Badge
                variant="secondary"
                className="h-4 px-1.5 py-0 text-[10px]"
                title={originalName ? t('original_name_tooltip', { name: originalName }) : undefined}
              >
                {t('edited_badge')}
              </Badge>
            </>
          )}
          {skvCounterpartDate && (
            <>
              <DataListMetaSeparator />
              <Badge variant="warning" className="h-4 gap-1 px-1.5 py-0 text-[10px]">
                <AlertCircle className="h-3 w-3" />
                Möjlig 1930↔1630
              </Badge>
            </>
          )}
        </DataListMeta>
        {/* Extraction status — visible only while AI is reading a freshly
            attached document, or briefly if reading failed. */}
        {HAS_AI_EXTRACTION &&
          !isBatchMode &&
          (extraction.status === 'running' || extraction.status === 'failed') && (
            <div className="mt-2 pt-2 border-t border-border">
              <ExtractionStatus
                status={extraction.status}
                elapsedMs={extraction.elapsedMs}
              />
            </div>
          )}
      </DataListRow>
    </motion.div>
  )
}
