'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { linkDocuments, formatFailedDocumentNames } from '@/lib/documents/link-documents'
import { ArrowUpRight, ArrowDownRight, Check, Paperclip, ChevronDown, ChevronUp, AlertTriangle, Inbox, FileText, X } from 'lucide-react'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import { isCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-templates'
import { computeProposalLines, resolveTemplateAccountsForEntity } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLine, ProposalLinesInput } from '@/lib/bookkeeping/proposal-lines'
import type { ReviewTemplate } from '@/lib/transactions/quick-review-defaults'
import { resolveExplicitVat } from '@/lib/transactions/quick-review-defaults'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import JournalEntryPreview from './JournalEntryPreview'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import VatTreatmentSelect from './VatTreatmentSelect'
import AiCategorizeProposal, { type AiProposalMeta } from './AiCategorizeProposal'
import { VAT_TREATMENT_OPTIONS } from './transaction-types'
import type { TransactionWithInvoice } from './transaction-types'
import type { TransactionCategory, VatTreatment, BASAccount, EntityType, LinePatternEntry } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface QuickReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  category: TransactionCategory | null
  categoryLabel: string
  /** Empty string when there is no sensible default: never undefined. */
  defaultAccount: string
  defaultVat: VatTreatment | 'none'
  entityType?: EntityType
  template?: ReviewTemplate | null
  templateId?: string
  counterpartyLinePattern?: LinePatternEntry[] | null
  /**
   * Learned bag from the counterparty template (default_dimensions): prefills
   * the picker so the user sees, and can change, what the booking will be
   * tagged with.
   */
  counterpartyDefaultDimensions?: Record<string, string> | null
  onConfirm: (
    id: string,
    category: TransactionCategory,
    vatTreatment: VatTreatment | undefined,
    accountOverride: string | undefined,
    templateId?: string,
    dimensions?: Record<string, string>
  ) => Promise<string | null>
  onChangeTemplate?: () => void
  /**
   * "Andra rader": hand the COMPUTED proposal lines (exactly what the
   * verifikation preview shows) to the parent, which routes them into
   * TransactionBookingDialog as an editable prefill. The transaction passed
   * back is the dialog's ENRICHED row (with any in-dialog SEK conversion
   * backfill): the parent must hand that one to the booking dialog so the
   * settlement leg's FX metadata carries the same rate the amounts used.
   */
  onEditLines?: (lines: ProposalLine[], transaction: TransactionWithInvoice) => void
}

export default function QuickReviewDialog({
  open,
  onOpenChange,
  transaction,
  category,
  categoryLabel,
  defaultAccount,
  defaultVat,
  entityType,
  template,
  templateId,
  counterpartyLinePattern,
  counterpartyDefaultDimensions,
  onConfirm,
  onChangeTemplate,
  onEditLines,
}: QuickReviewDialogProps) {
  const t = useTranslations('tx_quick_review')
  const tCat = useTranslations('tx_categories')
  const { toast } = useToast()
  const router = useRouter()
  // `?? ''` is deliberate belt-and-braces: the prop is a required string, but
  // a caller that hands over a template-shaped object missing debit_account
  // used to make this undefined and take the whole page down on the
  // .startsWith() below. An empty account disables the confirm button; it
  // never throws.
  const [accountOverride, setAccountOverride] = useState(defaultAccount ?? '')
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none'>(defaultVat)
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  // The AI proposal shown this session, kept so we can log a calibration sample
  // (proposed vs actually booked) once the user confirms.
  const [aiProposal, setAiProposal] = useState<AiProposalMeta | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  // Underlag already sitting in the inkorg, picked instead of re-uploaded. The
  // journal entry does not exist yet at pick time, so these are held here and
  // linked (with their inbox_item_id, which consumes the inbox item) once the
  // booking returns a verifikat: same select-mode contract TransactionBookingDialog uses.
  const [pickedInboxDocs, setPickedInboxDocs] = useState<AvailableInboxDoc[]>([])
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)
  const [showUploadZone, setShowUploadZone] = useState(false)
  const [showVatDropdown, setShowVatDropdown] = useState(false)
  // Mirror of `transaction` so we can patch in a freshly-fetched SEK conversion
  // before the user confirms: the verifikation must always be in SEK and the
  // engine reads these fields straight off the transaction row.
  const [enrichedTx, setEnrichedTx] = useState<TransactionWithInvoice | null>(transaction)
  const [rateLoading, setRateLoading] = useState(false)
  const [rateError, setRateError] = useState<string | null>(null)
  // Dimension tagging (kostnadsställe/projekt): the picker renders only when
  // company_settings.dimensions_enabled, same gate as BulkBookDialog. Seeded
  // from the counterparty template's learned bag so the user sees what the
  // booking will carry and can change it.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [dims, setDims] = useState<Record<string, string>>(
    () => ({ ...(counterpartyDefaultDimensions ?? {}) }),
  )

  const preAttachedDocumentId = transaction?.document_id ?? null

  // Handle account changes: clear VAT for liability/equity accounts (class 2)
  const handleAccountChange = useCallback((account: string) => {
    setAccountOverride(account ?? '')
    if (account?.startsWith('2')) {
      setVatTreatment('none')
    }
  }, [])

  // Fetch accounts on mount
  useEffect(() => {
    async function fetchAccounts() {
      try {
        const res = await fetch('/api/bookkeeping/accounts')
        const { data } = await res.json()
        if (data) {
          setAccounts(data)
        }
      } catch {
        // Non-critical
      }
    }
    fetchAccounts()
  }, [])

  // Reset local mirror whenever the underlying transaction changes (the parent
  // reuses the dialog instance across rows).
  useEffect(() => {
    setEnrichedTx(transaction)
    setRateError(null)
    setDims({ ...(counterpartyDefaultDimensions ?? {}) })
    // A document picked for the previous row must never follow the dialog to
    // the next one: it would attach that underlag to the wrong verifikat.
    setPickedInboxDocs([])
    // Re-seeding on counterpartyDefaultDimensions alone would clobber in-
    // flight edits; the bag only changes together with the transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction])

  // Company settings gate the dimension affordance (dimensions_enabled).
  // Fetched once per open; on failure the picker simply stays hidden.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/settings')
      .then((r) => r.json())
      .then(({ data }) => {
        if (!cancelled) setDimensionsEnabled(data?.dimensions_enabled === true)
      })
      .catch(() => {
        if (!cancelled) setDimensionsEnabled(false)
      })
    return () => { cancelled = true }
  }, [open])

  // Backfill the SEK conversion on demand. resolveSekAmount silently falls
  // back to the raw foreign amount when amount_sek/exchange_rate are null,
  // which means the user would see misleading "kr" values in the verifikation
  // and the engine would post the wrong number to the books.
  useEffect(() => {
    if (!open || !transaction) return
    const needsRate =
      !!transaction.currency &&
      transaction.currency !== 'SEK' &&
      (transaction.amount_sek == null || transaction.exchange_rate == null)
    if (!needsRate) return

    let cancelled = false
    setRateLoading(true)
    setRateError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/transactions/${transaction.id}/refresh-exchange-rate`, {
          method: 'POST',
        })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setRateError(getUserErrorMessage(json?.error) || t('exchange_rate_fetch_failed'))
          return
        }
        if (json?.data) {
          setEnrichedTx({ ...json.data, ...{
            potential_invoice: transaction.potential_invoice,
            potential_supplier_invoice: transaction.potential_supplier_invoice,
          } })
        }
      } catch {
        if (!cancelled) setRateError(t('exchange_rate_fetch_failed'))
      } finally {
        if (!cancelled) setRateLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, transaction, t])

  if (!transaction || !category) return null

  const tx = enrichedTx ?? transaction
  const isIncome = tx.amount > 0
  // Keyed off the template ID, not off the presence of a line pattern: a
  // *learned* counterparty (one business line, no pattern) is still booked
  // server-side from counterparty_template_id, so its accounts and VAT come
  // from the stored template. Deciding this from counterparties that happen
  // to have a multi-line pattern made single-line ones fall through to the
  // category branch, which previewed the wrong accounts and offered an
  // account/VAT editor whose values the categorize route discards.
  const isCounterpartyTemplate = !!template?.id && isCounterpartyTemplateId(template.id)
  const hasCounterpartyPattern = !!(counterpartyLinePattern && counterpartyLinePattern.length > 0)
  const isTemplateBooking = !!templateId || isCounterpartyTemplate
  const isLiabilityAccount = accountOverride?.startsWith('2') ?? false
  // For non-SEK transactions, the verifikation and the headline must show
  // the SEK-converted total: the mall/category booking always posts in SEK.
  const sekAmount = resolveSekAmount(
    tx.amount,
    tx.amount_sek,
    tx.currency,
    tx.exchange_rate
  )
  const attachedCount =
    uploadedFiles.filter((f) => f.status === 'uploaded').length + pickedInboxDocs.length
  const isForeign = !!(tx.currency && tx.currency !== 'SEK')
  const sekConversionMissing = isForeign && (tx.amount_sek == null || tx.exchange_rate == null)

  // Dimensions carried by the counterparty template's line pattern (dimensions
  // PR7). Business lines may each carry a {sie_dim_no: code} bag: merge them
  // into one compact display label ("KS01 · P001", dim-number order). This is
  // display-only: booking applies the pattern's bags server-side.
  const patternDims: Record<string, string> = {}
  for (const line of counterpartyLinePattern ?? []) {
    if (line.dimensions) Object.assign(patternDims, line.dimensions)
  }
  const patternDimsLabel = Object.entries(patternDims)
    .filter(([, code]) => code)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, code]) => code)
    .join(' · ')

  // Static templates carry AB-specific accounts; the engine substitutes them
  // at booking time, so the preview and the prefill must show the same
  // substitution (an aktiebolag must never be handed 2013-style EF accounts).
  const entityAccounts = resolveTemplateAccountsForEntity(template ?? {}, entityType)

  // The one proposal definition: rendered by JournalEntryPreview and, via
  // "Andra rader", computed into editable prefill lines. Building it once
  // guarantees the user edits exactly the lines they were shown, and every
  // branch mirrors the engine path that books the proposal (see
  // lib/bookkeeping/proposal-lines.ts).
  const proposalInput: ProposalLinesInput = {
    amount: tx.amount,
    amountSek: sekAmount,
    ...(hasCounterpartyPattern
      ? { linePattern: counterpartyLinePattern ?? undefined }
      : isTemplateBooking && template?.debit_account && template?.credit_account
        ? isCounterpartyTemplate
          ? {
              // Legacy counterparty pair: computeProposalLines mirrors the
              // legacy booking path (VAT incl. the 2645/2614 fiktiv-moms
              // pair on expenses only, no basbelopp, mismatches mirrored).
              templateDebitAccount: template.debit_account,
              templateCreditAccount: template.credit_account,
              templateVatTreatment: template.vat_treatment ?? null,
              counterpartyLegacy: true,
            }
          : {
              templateDebitAccount: entityAccounts.debitAccount ?? template.debit_account,
              templateCreditAccount: entityAccounts.creditAccount ?? template.credit_account,
              templateVatRate: template.vat_rate,
              templateVatTreatment: template.vat_treatment,
              templateSupplierType: template.reverse_charge_supplier_type,
            }
        : {
            category,
            // Send the WIRE value, not the UI sentinel: 'none' as a seeded
            // default stays undefined (server derives, no VAT for exempt
            // categories), 'none' as a deviation becomes explicit 'exempt'.
            // Passing raw 'none' made the mapping re-derive the category
            // default and preview (and, worse, prefill) 25% moms against an
            // explicit no-VAT choice: the exact collapse resolveExplicitVat
            // exists to prevent on the confirm path.
            vatTreatment: resolveExplicitVat(isLiabilityAccount ? 'none' : vatTreatment, defaultVat),
            accountOverride,
            entityType,
          }
    ),
  }

  // Computed once per render: gates the affordance (no lines, no link) and is
  // the exact payload the link hands over.
  const proposalLines = onEditLines ? computeProposalLines(proposalInput) : []

  function handleEditLines() {
    if (!onEditLines || proposalLines.length === 0) return
    onEditLines(proposalLines, tx)
  }

  async function handleConfirm() {
    if (!category || !transaction) return

    setIsProcessing(true)
    setError(null)
    try {
      // 'none' as the seeded default stays off the wire (server derives, no
      // VAT line); 'none' as a user deviation goes as explicit 'exempt'. The
      // old unconditional collapse re-derived the default server-side and
      // booked 25% moms against an explicit "Ingen moms" while the preview
      // showed none. See resolveExplicitVat.
      const resolvedVat = resolveExplicitVat(vatTreatment, defaultVat)
      const catDefault = getDefaultAccountForCategory(category)
      const override = accountOverride && accountOverride !== catDefault
        ? accountOverride
        : undefined

      // Cleared combobox values leave empty strings behind; strip them so an
      // untouched picker sends no bag at all (learned template bags then apply
      // server-side unchanged).
      const cleanedDims = Object.fromEntries(
        Object.entries(dims).filter(([, code]) => code && code.trim().length > 0),
      )
      const journalEntryId = await onConfirm(
        transaction.id,
        category,
        resolvedVat,
        override,
        templateId,
        Object.keys(cleanedDims).length > 0 ? cleanedDims : undefined,
      )

      // Calibration telemetry: what the model proposed vs what was actually
      // booked. Best-effort and fire-and-forget — never blocks the booking.
      if (journalEntryId && aiProposal) {
        void fetch('/api/agent/categorize/outcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confidence: aiProposal.confidence,
            agreement: aiProposal.agreement,
            model_confidence: aiProposal.modelConfidence,
            source: aiProposal.source,
            proposed_account: aiProposal.account,
            booked_account: override ?? catDefault,
            amount: Math.abs(sekAmount),
          }),
        }).catch(() => {})
      }

      // Attach the uploaded underlag to the verifikat the booking just created.
      // BFL 5 kap 7 § requires the verifikation to reference its underlag and
      // BFL 7 kap requires that underlag to be archived with it; the verifikat
      // is already committed here, so a failed link can only be reported, not
      // undone. The parent's "Bokförd" toast must not be the last word when a
      // receipt never made it onto the books.
      if (journalEntryId && (uploadedFiles.length > 0 || pickedInboxDocs.length > 0)) {
        const targets = [
          ...uploadedFiles
            .filter((f) => f.status === 'uploaded' && f.id)
            .map((f) => ({ documentId: f.id as string, fileName: f.fileName })),
          // inboxItemId stamps the inbox item as consumed so the underlag drops
          // out of "Underlag att hantera" instead of lingering as a duplicate of
          // the verifikat it now belongs to: see app/api/documents/[id]/link/route.ts.
          ...pickedInboxDocs.map((doc) => ({
            documentId: doc.document_id,
            fileName: doc.supplier_name ?? doc.file_name,
            inboxItemId: doc.inbox_item_id,
          })),
        ]
        const { failed } = await linkDocuments(targets, journalEntryId)
        if (failed.length > 0) {
          toast({
            title: t('doc_link_failed_booked_title'),
            description: t('doc_link_failed_booked_description', {
              count: failed.length,
              files: formatFailedDocumentNames(failed),
            }),
            variant: 'destructive',
            action: (
              <ToastAction
                altText={t('doc_link_open_entry')}
                onClick={() => router.push(`/bookkeeping/${journalEntryId}`)}
              >
                {t('doc_link_open_entry')}
              </ToastAction>
            ),
          })
          // By this point the parent has already closed the dialog (onConfirm
          // resolved before linkDocuments did), so this component's file state
          // is invisible either way: the toast above, with its open-entry
          // action, is the user's actual pointer to the underlag that did not
          // attach. The early return just skips the redundant cleanup below.
          //
          // Picks are still dropped: the dialog instance is reused across rows,
          // and a pick that DID link is already consumed, so carrying it into
          // the next transaction would re-link a spent document. Nothing is lost
          // by clearing, unlike uploadedFiles: an underlag that failed to link
          // was never stamped, so it is still sitting in the inkorg to re-pick.
          setPickedInboxDocs([])
          return
        }
      }

      setUploadedFiles([])
      setPickedInboxDocs([])
      setShowUploadZone(false)
    } catch {
      setError(t('generic_error'))
    } finally {
      // Always reset isProcessing: without this, an onConfirm that resolves
      // with null (e.g. server returned a structured 4xx error like
      // ACCOUNTS_NOT_IN_CHART) leaves the dialog frozen because the
      // <Dialog onOpenChange> below disables backdrop/ESC while processing.
      setIsProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : (o) => {
      if (!o) {
        setUploadedFiles([])
        setPickedInboxDocs([])
        setShowUploadZone(false)
      }
      onOpenChange(o)
    }}>
      <DialogContent className={preAttachedDocumentId ? 'max-w-6xl max-h-[90vh] overflow-y-auto' : 'max-w-md sm:max-w-lg max-h-[85vh] overflow-y-auto'}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {isTemplateBooking ? t('description_template') : t('description_default')}
          </DialogDescription>
        </DialogHeader>

        {/* When a document is pre-attached, show it side-by-side (receipt left,
            review right). With no document the wrappers use display:contents so
            the dialog collapses to the original single-column layout. */}
        <div className={preAttachedDocumentId ? 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)]' : 'contents'}>
          {preAttachedDocumentId && (
            <div className="h-[45vh] lg:sticky lg:top-0 lg:h-[72vh] lg:self-start">
              <DocumentViewerPane documentId={preAttachedDocumentId} className="h-full" />
            </div>
          )}
          <div className={preAttachedDocumentId ? 'space-y-4' : 'contents'}>

        {/* Transaction summary */}
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <div
            className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${isIncome ? 'text-success' : 'text-destructive'}`}
          >
            {isIncome ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : (
              <ArrowDownRight className="h-4 w-4" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm break-all">{tx.description}</p>
            <p className="text-xs text-muted-foreground">{formatDate(tx.date)}</p>
          </div>
          <div className="text-right flex-shrink-0">
            {isForeign ? (
              <>
                <p className={`font-medium text-sm tabular-nums ${isIncome ? 'text-success' : ''}`}>
                  {isIncome ? '+' : ''}
                  {formatCurrency(tx.amount, tx.currency)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {rateLoading || sekConversionMissing
                    ? t('amount_loading')
                    : t('amount_approx', { sign: isIncome ? '+' : '', sek: formatCurrency(sekAmount, 'SEK') })}
                </p>
              </>
            ) : (
              <p className={`font-medium text-sm tabular-nums ${isIncome ? 'text-success' : ''}`}>
                {isIncome ? '+' : ''}
                {formatCurrency(sekAmount, 'SEK')}
              </p>
            )}
          </div>
        </div>

        {isForeign && tx.exchange_rate != null && tx.exchange_rate_date && !sekConversionMissing && (
          <p className="text-xs text-muted-foreground -mt-1">
            {t('rate_footnote', {
              rate: formatCurrency(tx.exchange_rate, 'SEK'),
              currency: tx.currency,
              date: formatDate(tx.exchange_rate_date),
            })}
          </p>
        )}

        {rateError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-2">
            <p className="text-xs text-destructive leading-snug">{rateError}</p>
          </div>
        )}

        {/* AI booking proposal: pre-fills account + VAT and explains why.
            Falls back silently to the deterministic defaults on error. */}
        {tx.id && (
          <AiCategorizeProposal
            key={tx.id}
            transactionId={tx.id}
            open={open}
            onProposal={setAiProposal}
            onApply={(account, vat) => {
              handleAccountChange(account)
              // handleAccountChange clears VAT for class-2 accounts; for the
              // rest, apply the proposed treatment.
              if (!account.startsWith('2')) setVatTreatment(vat)
            }}
          />
        )}

        {/* Template or Category */}
        <div>
          <label className="text-sm font-medium text-muted-foreground">
            {isCounterpartyTemplate ? t('label_counterparty_template') : template ? t('label_template') : t('label_category')}
          </label>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {template ? template.name_sv : categoryLabel}
            </span>
            {patternDimsLabel && (
              <Badge data-ph-mask="" variant="secondary" className="font-mono tabular-nums">
                {patternDimsLabel}
              </Badge>
            )}
            {onChangeTemplate && !hasCounterpartyPattern && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={onChangeTemplate}
              >
                {t('change_template')}
              </button>
            )}
          </div>
          {/* Only when there IS a single debit/credit pair to show: a
              multi-line counterparty pattern has none, and a template that
              never carried accounts would render "D:  → K: ". */}
          {!hasCounterpartyPattern && entityAccounts.debitAccount && entityAccounts.creditAccount && (
            <p className="mt-1.5 text-xs font-mono text-muted-foreground">
              D: {formatAccountWithName(entityAccounts.debitAccount)} → K: {formatAccountWithName(entityAccounts.creditAccount)}
            </p>
          )}
        </div>

        {/* Template special rules */}
        {template?.special_rules_sv && (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <p className="text-xs text-attn leading-snug">
              {template.special_rules_sv}
            </p>
          </div>
        )}

        {/* Deductibility note */}
        {template?.deductibility_note_sv && (
          <div className="rounded-lg border border-primary/20 bg-primary/[0.03] px-3 py-2">
            <p className="text-xs text-foreground leading-snug">
              {template.deductibility_note_sv}
            </p>
          </div>
        )}

        {/* Reverse charge warning */}
        {template?.requires_vat_registration_data && (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-attn flex-shrink-0 mt-0.5" />
              <p className="text-xs text-attn leading-snug">
                {t('reverse_charge_warning')}
              </p>
            </div>
          </div>
        )}

        {/* Journal entry preview: hidden until we have a SEK conversion;
            otherwise we'd render a verifikation in the wrong currency. */}
        {!sekConversionMissing && !rateLoading && (
          <div>
            <JournalEntryPreview {...proposalInput} />
            {/* "Andra rader": send the computed lines into the manual booking
                dialog for per-line editing. Offered on every proposal surface
                (AI suggestion, static template, counterparty pattern). */}
            {onEditLines && proposalLines.length > 0 && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
                  disabled={isProcessing}
                  onClick={handleEditLines}
                >
                  {t('edit_lines')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Account & VAT: hidden for template bookings (accounts defined by the template) */}
        {!isTemplateBooking && (
          <>
            <div>
              <label className="text-sm font-medium text-muted-foreground">{t('label_account')}</label>
              <div className="mt-1">
                <AccountCombobox
                  value={accountOverride}
                  accounts={accounts}
                  onChange={handleAccountChange}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-muted-foreground">{t('label_vat_treatment')}</label>
              <div className="mt-1">
                {isLiabilityAccount ? (
                  <p className="text-sm text-muted-foreground">
                    {t('no_vat_liability_account')}
                  </p>
                ) : showVatDropdown ? (
                  <VatTreatmentSelect
                    value={vatTreatment}
                    onValueChange={setVatTreatment}
                  />
                ) : (
                  <p className="text-sm">
                    {(() => {
                      const opt = VAT_TREATMENT_OPTIONS.find(o => o.value === vatTreatment)
                      return opt ? tCat(opt.labelKey) : t('no_vat_default')
                    })()}
                    {' '}
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setShowVatDropdown(true)}
                    >
                      {t('change')}
                    </button>
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Dimension tags (kostnadsställe/projekt): rendered for category,
            library-template and legacy counterparty bookings. Multi-line
            counterparty patterns are excluded: their per-line bags are
            authoritative server-side and an edit here would be ignored. */}
        {dimensionsEnabled && !hasCounterpartyPattern && (
          <div>
            <label className="text-sm font-medium text-muted-foreground">{t('label_dimensions')}</label>
            <div className="mt-1">
              <LineDimensionFields
                dimensions={dims}
                onChange={(sieDimNo, code) => {
                  setDims((prev) => {
                    const next = { ...prev }
                    if (code) next[sieDimNo] = code
                    else delete next[sieDimNo]
                    return next
                  })
                }}
                inputClassName="h-8"
              />
            </div>
          </div>
        )}

        {/* No pre-attached document: let the user upload one. (When a document
            IS pre-attached it's shown in the left preview column instead.) */}
        {!preAttachedDocumentId && (
          <div className="rounded-lg border">
            <button
              type="button"
              onClick={() => setShowUploadZone(!showUploadZone)}
              className="flex items-center justify-between w-full px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{t('doc_label')}</span>
                {attachedCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('doc_attached_count', { count: attachedCount })}
                  </span>
                )}
              </div>
              {showUploadZone ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {showUploadZone && (
              <div className="px-3 pb-3 space-y-2">
                <DocumentUploadZone
                  files={uploadedFiles}
                  onFilesChange={setUploadedFiles}
                  compact
                />
                {pickedInboxDocs.map((doc) => (
                  <div
                    key={doc.document_id}
                    className="flex items-center gap-2 rounded-sm bg-muted/50 px-2 py-1.5 text-sm"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{doc.supplier_name ?? doc.file_name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 shrink-0 p-0"
                      aria-label={t('doc_picked_remove')}
                      disabled={isProcessing}
                      onClick={() =>
                        setPickedInboxDocs((prev) =>
                          prev.filter((d) => d.document_id !== doc.document_id),
                        )
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                {/* Locked while the booking is in flight: handleConfirm captured
                    pickedInboxDocs when it started, so anything picked now would
                    never be linked and would then be cleared on completion,
                    vanishing from the list with no error to explain it.
                    Styled as the dropzone's footer (same treatment as
                    TransactionBookingDialog) so upload and inbox-pick read as
                    one underlag surface. */}
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setInboxPickerOpen(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-muted-foreground/25 px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Inbox className="h-4 w-4" />
                  <span>{t('doc_pick_existing_inline')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
          >
            {t('cancel')}
          </Button>
          <Button
            className="flex-1"
            onClick={handleConfirm}
            disabled={
              isProcessing ||
              (!isTemplateBooking && !accountOverride) ||
              rateLoading ||
              sekConversionMissing
            }
          >
            <Check className="mr-2 h-4 w-4" />
            {isProcessing ? t('booking') : rateLoading ? t('fetching_rate') : t('book')}
          </Button>
        </div>
          </div>
        </div>

        {/* Select mode: the verifikat does not exist yet, so the pick is held in
            state and linked in handleConfirm once the booking returns its id. */}
        <InboxDocumentPicker
          open={inboxPickerOpen}
          onClose={() => setInboxPickerOpen(false)}
          onSelect={(doc) =>
            setPickedInboxDocs((prev) =>
              prev.some((d) => d.document_id === doc.document_id) ? prev : [...prev, doc],
            )
          }
        />
      </DialogContent>
    </Dialog>
  )
}
