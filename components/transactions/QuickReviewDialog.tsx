'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight, Check, Paperclip, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import JournalEntryPreview from './JournalEntryPreview'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import VatTreatmentSelect from './VatTreatmentSelect'
import { VAT_TREATMENT_OPTIONS } from './transaction-types'
import type { TransactionWithInvoice } from './transaction-types'
import type { TransactionCategory, VatTreatment, BASAccount, EntityType, LinePatternEntry } from '@/types'

interface QuickReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  category: TransactionCategory | null
  categoryLabel: string
  defaultAccount: string
  defaultVat: VatTreatment | 'none'
  entityType?: EntityType
  template?: BookingTemplate | null
  templateId?: string
  counterpartyLinePattern?: LinePatternEntry[] | null
  onConfirm: (
    id: string,
    category: TransactionCategory,
    vatTreatment: VatTreatment | undefined,
    accountOverride: string | undefined,
    templateId?: string
  ) => Promise<string | null>
  onChangeTemplate?: () => void
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
  onConfirm,
  onChangeTemplate,
}: QuickReviewDialogProps) {
  const t = useTranslations('tx_quick_review')
  const tCat = useTranslations('tx_categories')
  const { toast } = useToast()
  const [accountOverride, setAccountOverride] = useState(defaultAccount)
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none'>(defaultVat)
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [showUploadZone, setShowUploadZone] = useState(false)
  const [showVatDropdown, setShowVatDropdown] = useState(false)
  const [isOpeningDoc, setIsOpeningDoc] = useState(false)
  // Mirror of `transaction` so we can patch in a freshly-fetched SEK conversion
  // before the user confirms — the verifikation must always be in SEK and the
  // engine reads these fields straight off the transaction row.
  const [enrichedTx, setEnrichedTx] = useState<TransactionWithInvoice | null>(transaction)
  const [rateLoading, setRateLoading] = useState(false)
  const [rateError, setRateError] = useState<string | null>(null)

  const preAttachedDocumentId = transaction?.document_id ?? null

  const handleOpenAttachedDoc = useCallback(async () => {
    if (!preAttachedDocumentId || isOpeningDoc) return
    setIsOpeningDoc(true)
    try {
      const res = await fetch(`/api/documents/${preAttachedDocumentId}`)
      if (!res.ok) {
        toast({ title: t('open_attached_failed'), variant: 'destructive' })
        return
      }
      const { data } = await res.json()
      if (data?.download_url) {
        window.open(data.download_url, '_blank', 'noopener,noreferrer')
      }
    } finally {
      setIsOpeningDoc(false)
    }
  }, [preAttachedDocumentId, isOpeningDoc, toast, t])

  // Handle account changes — clear VAT for liability/equity accounts (class 2)
  const handleAccountChange = useCallback((account: string) => {
    setAccountOverride(account)
    if (account.startsWith('2')) {
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
  }, [transaction])

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
          setRateError(json?.error?.message || t('exchange_rate_fetch_failed'))
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
  const isCounterpartyTemplate = !!(counterpartyLinePattern && counterpartyLinePattern.length > 0)
  const isTemplateBooking = !!templateId || isCounterpartyTemplate
  const isLiabilityAccount = accountOverride.startsWith('2')
  // For non-SEK transactions, the verifikation and the headline must show
  // the SEK-converted total — the mall/category booking always posts in SEK.
  const sekAmount = resolveSekAmount(
    tx.amount,
    tx.amount_sek,
    tx.currency,
    tx.exchange_rate
  )
  const isForeign = !!(tx.currency && tx.currency !== 'SEK')
  const sekConversionMissing = isForeign && (tx.amount_sek == null || tx.exchange_rate == null)

  async function handleConfirm() {
    if (!category || !transaction) return

    setIsProcessing(true)
    setError(null)
    try {
      const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
      const catDefault = getDefaultAccountForCategory(category)
      const override = accountOverride && accountOverride !== catDefault
        ? accountOverride
        : undefined

      const journalEntryId = await onConfirm(transaction.id, category, resolvedVat, override, templateId)

      // Link uploaded documents to the journal entry
      if (journalEntryId && uploadedFiles.length > 0) {
        const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
        let linkFailCount = 0
        for (const file of filesToLink) {
          try {
            await fetch(`/api/documents/${file.id}/link`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ journal_entry_id: journalEntryId }),
            })
          } catch {
            linkFailCount++
          }
        }
        if (linkFailCount > 0) {
          toast({
            title: t('doc_link_failed_title'),
            description: t('doc_link_failed_description', { count: linkFailCount }),
            variant: 'destructive',
          })
        }
      }

      setUploadedFiles([])
      setShowUploadZone(false)
    } catch {
      setError(t('generic_error'))
    } finally {
      // Always reset isProcessing — without this, an onConfirm that resolves
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
        setShowUploadZone(false)
      }
      onOpenChange(o)
    }}>
      <DialogContent className="max-w-md sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {isTemplateBooking ? t('description_template') : t('description_default')}
          </DialogDescription>
        </DialogHeader>

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

        {/* Template or Category */}
        <div>
          <label className="text-sm font-medium text-muted-foreground">
            {isCounterpartyTemplate ? t('label_counterparty_template') : template ? t('label_template') : t('label_category')}
          </label>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {template ? template.name_sv : categoryLabel}
            </span>
            {onChangeTemplate && !isCounterpartyTemplate && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={onChangeTemplate}
              >
                {t('change_template')}
              </button>
            )}
          </div>
          {template && !isCounterpartyTemplate && (
            <p className="mt-1.5 text-xs font-mono text-muted-foreground">
              D: {formatAccountWithName(template.debit_account)} → K: {formatAccountWithName(template.credit_account)}
            </p>
          )}
        </div>

        {/* Template special rules */}
        {template?.special_rules_sv && (
          <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2">
            <p className="text-xs text-warning-foreground leading-snug">
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
          <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground flex-shrink-0 mt-0.5" />
              <p className="text-xs text-warning-foreground leading-snug">
                {t('reverse_charge_warning')}
              </p>
            </div>
          </div>
        )}

        {/* Journal entry preview — hidden until we have a SEK conversion;
            otherwise we'd render a verifikation in the wrong currency. */}
        {!sekConversionMissing && !rateLoading && (
          <JournalEntryPreview
            amount={tx.amount}
            amountSek={sekAmount}
            {...(isCounterpartyTemplate
              ? { linePattern: counterpartyLinePattern ?? undefined }
              : templateId && template
                ? {
                    templateDebitAccount: template.debit_account,
                    templateCreditAccount: template.credit_account,
                    templateVatRate: template.vat_rate,
                    templateVatTreatment: template.vat_treatment,
                    templateSupplierType: template.reverse_charge_supplier_type,
                  }
                : { category, vatTreatment: isLiabilityAccount ? 'none' : vatTreatment, accountOverride, entityType }
            )}
          />
        )}

        {/* Account & VAT — hidden for template bookings (accounts defined by the template) */}
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

        {/* Document — either show the doc the inbox attached pre-categorize,
            or let the user upload one if none is attached yet. */}
        {preAttachedDocumentId ? (
          <div className="rounded-lg border flex items-center justify-between px-3 py-2.5 text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="font-medium">{t('attached_doc_label')}</span>
              <span className="text-xs text-muted-foreground truncate">
                {t('attached_doc_source')}
              </span>
            </div>
            <button
              type="button"
              onClick={handleOpenAttachedDoc}
              disabled={isOpeningDoc}
              className="text-xs text-primary hover:underline shrink-0"
            >
              {isOpeningDoc ? t('opening') : t('view')}
            </button>
          </div>
        ) : (
          <div className="rounded-lg border">
            <button
              type="button"
              onClick={() => setShowUploadZone(!showUploadZone)}
              className="flex items-center justify-between w-full px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{t('doc_label')}</span>
                {uploadedFiles.filter((f) => f.status === 'uploaded').length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('doc_attached_count', { count: uploadedFiles.filter((f) => f.status === 'uploaded').length })}
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
              <div className="px-3 pb-3">
                <DocumentUploadZone
                  files={uploadedFiles}
                  onFilesChange={setUploadedFiles}
                  compact
                />
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
      </DialogContent>
    </Dialog>
  )
}
