'use client'

import { useEffect, useState } from 'react'
import { useDocumentExtraction } from '@/lib/hooks/use-document-extraction'
import ExtractionStatus from '@/components/ui/extraction-status'
import { motion } from 'framer-motion'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { AlertCircle, ArrowUpRight, ArrowDownRight, FileText, Loader2, Trash2, FileCheck2 } from 'lucide-react'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useToast } from '@/components/ui/use-toast'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

// True when the AI tier is active — gates user-facing strings that promise
// AI behavior. On the free build (document-extraction disabled) we keep the
// upload functional but drop the "AI:n läser dokumentet" promise.
const HAS_AI_EXTRACTION = ENABLED_EXTENSION_IDS.has('document-extraction')
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'
import type { SuggestedCategory, SuggestedTemplate } from '@/lib/transactions/category-suggestions'

interface TransactionInboxCardProps {
  transaction: TransactionWithInvoice
  /** Pre-fetched by the parent (page-level suggestions endpoint). The card
   *  no longer renders auto-suggestion chips — the user picks via "Välj
   *  mall…" or hands off to the assistant. Prop retained so callers don't
   *  need to be touched in this PR. */
  suggestions?: SuggestedCategory[]
  /** Same: parent still pre-fetches template suggestions; the card no
   *  longer renders them. */
  templateSuggestions?: SuggestedTemplate[]
  /** When set, this bank tx looks like the bank side of a 1930↔1630
   *  transfer that the user will later see on /skattekonto. Renders a
   *  hint warning so the user doesn't book both sides separately. */
  skvCounterpartDate?: string
  processingId: string | null
  isBatchMode: boolean
  isSelected: boolean
  entityType?: string
  onCategorize: CategorizeHandler
  onMarkPrivate: (id: string) => void
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  /** Retained for callers; unused now. */
  onOpenQuickReview?: (transaction: TransactionWithInvoice, suggestion: SuggestedCategory) => void
  /** Retained for callers; unused now. */
  onOpenTemplateReview?: (transaction: TransactionWithInvoice, templateId: string) => void
  onToggleSelect: (id: string) => void
  onAnimationComplete?: (id: string) => void
}

export default function TransactionInboxCard({
  transaction,
  skvCounterpartDate,
  processingId,
  isBatchMode,
  isSelected,
  entityType = 'enskild_firma',
  onCategorize,
  onMarkPrivate,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onDelete,
  onToggleSelect,
  onAnimationComplete,
}: TransactionInboxCardProps) {
  const isProcessing = processingId === transaction.id
  const isDisabled = processingId !== null && processingId !== transaction.id
  const isIncome = transaction.amount > 0
  const { openAgentSheet, identity } = useAgentSheet()
  const { toast } = useToast()
  const [isOpeningDoc, setIsOpeningDoc] = useState(false)
  // Optimistic override — flips the icon to "attached" as soon as the upload
  // POST succeeds, without waiting for the parent to refetch. The next
  // parent refresh will sync; in the meantime the user sees the correct
  // visual state immediately. Same hook handles agent-chat uploads via the
  // gnubok:transaction-document-linked window event (AgentChat dispatches
  // it after /api/agent/upload returns).
  const [optimisticDocumentId, setOptimisticDocumentId] = useState<string | null>(null)
  useEffect(() => {
    function onLinked(e: Event) {
      const detail = (e as CustomEvent<{ transaction_id?: string; document_id?: string }>).detail
      if (!detail || detail.transaction_id !== transaction.id || !detail.document_id) return
      setOptimisticDocumentId(detail.document_id)
    }
    window.addEventListener('gnubok:transaction-document-linked', onLinked)
    return () => window.removeEventListener('gnubok:transaction-document-linked', onLinked)
  }, [transaction.id])
  const attachedDocumentId =
    optimisticDocumentId ?? (transaction as { document_id?: string | null }).document_id ?? null
  const hasAttachment = !!attachedDocumentId
  // Only poll extraction status for documents the user attached during THIS
  // session. Pre-existing attached docs from prior sessions wouldn't change
  // status during this view, and polling them would be wasted requests.
  // Gated on HAS_AI_EXTRACTION so the free tier doesn't poll an endpoint
  // whose pipeline never runs.
  const extraction = useDocumentExtraction(
    HAS_AI_EXTRACTION ? optimisticDocumentId : null,
  )

  async function handleOpenAttachment(): Promise<void> {
    if (!attachedDocumentId || isOpeningDoc) return
    setIsOpeningDoc(true)
    try {
      const res = await fetch(`/api/documents/${attachedDocumentId}`)
      if (!res.ok) {
        toast({ title: 'Kunde inte hämta underlaget', variant: 'destructive' })
        return
      }
      const { data } = await res.json()
      if (data?.download_url) {
        window.open(data.download_url, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      toast({
        title: 'Kunde inte öppna underlaget',
        description: err instanceof Error ? err.message : 'Okänt fel.',
        variant: 'destructive',
      })
    } finally {
      setIsOpeningDoc(false)
    }
  }

  const hasInvoiceMatch = !!transaction.potential_invoice && !transaction.invoice_id
  const hasSupplierInvoiceMatch = !!transaction.potential_supplier_invoice && !transaction.supplier_invoice_id
  const isUncategorized = transaction.is_business === null && !transaction.journal_entry_id
  const showCheckbox = isBatchMode && isUncategorized
  const isDeletable = !transaction.journal_entry_id

  return (
    <motion.div
      layout
      initial={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, x: -16 }}
      transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      onAnimationComplete={(definition) => {
        // Only call on exit animation
        if (typeof definition === 'object' && 'opacity' in definition && definition.opacity === 0) {
          onAnimationComplete?.(transaction.id)
        }
      }}
    >
      <Card
        data-tx-id={transaction.id}
        className={cn(
          'transition-colors',
          hasInvoiceMatch || hasSupplierInvoiceMatch ? 'border-primary/50' : 'border-warning/50',
          isSelected && 'border-primary bg-primary/[0.02]',
          isDisabled && 'opacity-50'
        )}
        onClick={showCheckbox ? () => onToggleSelect(transaction.id) : undefined}
      >
        <CardContent className="py-4">
          {skvCounterpartDate && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-warning" />
              <p className="min-w-0">
                <span className="font-medium">Möjlig 1930↔1630-överföring.</span>{' '}
                Det finns en skattekonto-händelse den{' '}
                <span className="tabular-nums">{skvCounterpartDate}</span> som
                matchar — bokför detta verifikat först, koppla sedan
                skattekonto-raden mot samma verifikat istället för att bokföra
                två gånger.
              </p>
            </div>
          )}
          <div className="flex items-start justify-between gap-4">
            {/* Left: checkbox + icon + info */}
            <div className="flex items-start gap-3 min-w-0 flex-1">
              {showCheckbox && (
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => onToggleSelect(transaction.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-1"
                />
              )}
              <div
                className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${isIncome ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
                aria-hidden="true"
              >
                {isIncome ? (
                  <ArrowUpRight className="h-5 w-5" />
                ) : (
                  <ArrowDownRight className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="font-medium truncate">{transaction.description}</p>
                  <TransactionAttachmentIndicator documentId={attachedDocumentId} />
                </div>
                <p className="text-sm text-muted-foreground">{formatDate(transaction.date)}</p>
              </div>
            </div>

            {/* Right: amount */}
            <div className="text-right flex-shrink-0">
              <p className={cn('font-medium tabular-nums', isIncome && 'text-success')}>
                {isIncome ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </p>
              {transaction.currency !== 'SEK' && transaction.amount_sek && (
                <p className="text-sm text-muted-foreground">
                  {formatCurrency(transaction.amount_sek)}
                </p>
              )}
            </div>
          </div>

          {/* Inline action buttons - only shown when not in batch mode */}
          {!isBatchMode && (
            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t">
              {/* Primary action: invoice match or top suggestion */}
              {hasInvoiceMatch ? (
                <Button
                  size="sm"
                  variant="default"
                  className="h-9 text-xs max-w-full truncate"
                  onClick={() => onOpenMatchDialog(transaction)}
                  disabled={isProcessing || isDisabled}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin flex-shrink-0" />
                  ) : (
                    <FileText className="mr-1.5 h-3 w-3 flex-shrink-0" />
                  )}
                  Matcha Faktura {transaction.potential_invoice!.invoice_number}
                </Button>
              ) : hasSupplierInvoiceMatch ? (
                <Button
                  size="sm"
                  variant="default"
                  className="h-9 text-xs max-w-full truncate"
                  onClick={() => onOpenMatchDialog(transaction)}
                  disabled={isProcessing || isDisabled}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin flex-shrink-0" />
                  ) : (
                    <FileText className="mr-1.5 h-3 w-3 flex-shrink-0" />
                  )}
                  Matcha Leverantörsfaktura {transaction.potential_supplier_invoice!.supplier_invoice_number}
                </Button>
              ) : null}

              {/* Template picker. Replaces the previous "El & Uppvärmning",
                  "Molntjänster" auto-suggestion chips — guess-quality was
                  inconsistent and the user prefers to choose a mall
                  explicitly OR hand the categorization to the assistant. */}
              <Button
                size="sm"
                variant={!hasInvoiceMatch && !hasSupplierInvoiceMatch ? 'default' : 'outline'}
                className="h-9 text-xs"
                onClick={() => onOpenCategoryDialog(transaction)}
                disabled={isProcessing || isDisabled}
              >
                Välj mall...
              </Button>

              {/* Document affordance: shown only when this transaction has
                  an attachment (either via tx.document_id or a matched
                  invoice_inbox_items row whose document_id propagated
                  through the optimistic flip). Click opens the signed URL
                  in a new tab. Uploading happens in /e/general/invoice-inbox
                  (the canonical document inbox), never inline here. */}
              {hasAttachment && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto text-success hover:text-success/80 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleOpenAttachment()
                  }}
                  disabled={isProcessing || isDisabled || isOpeningDoc}
                  title="Underlag bifogat — klicka för att öppna"
                  aria-label="Öppna bifogat underlag"
                >
                  {isOpeningDoc ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileCheck2 className="h-4 w-4" />
                  )}
                </Button>
              )}

              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'text-muted-foreground hover:text-foreground',
                  !hasAttachment && 'ml-auto',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  openAgentSheet({
                    intentId: 'transaction.categorization',
                    intentArgs: { transaction_id: transaction.id },
                    contextRef: `transaction:${transaction.id}`,
                  })
                }}
                disabled={isProcessing || isDisabled}
                aria-label={`Fråga ${identity.displayName?.trim() || 'din assistent'} om denna transaktion`}
              >
                <AgentAvatar
                  avatarId={identity.avatarId}
                  size="xs"
                  alt={identity.displayName ?? 'Assistent'}
                />
              </Button>

              {/* Delete button — available for all unbooked transactions */}
              {isDeletable && onDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(transaction.id)}
                  disabled={isProcessing || isDisabled}
                  aria-label="Ta bort transaktion"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}

          {/* Extraction status — visible only while AI is reading a freshly
              attached document, or briefly if reading failed. Sits below the
              action row so it doesn't compete with the buttons for space. */}
          {!isBatchMode &&
            (extraction.status === 'running' || extraction.status === 'failed') && (
              <div className="mt-2 pt-2 border-t border-border/40">
                <ExtractionStatus
                  status={extraction.status}
                  elapsedMs={extraction.elapsedMs}
                />
              </div>
            )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
