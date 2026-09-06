'use client'

import { useState, type RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import { findIllegalVatRateRow } from '@/lib/vat/supplier-invoice-line-checks'
import { rateToPctString, supplierInvoiceCreateUrl, type SupplierInvoiceFormData } from '@/lib/supplier-invoices/form-payload'
import { isPersonPayer } from '@/lib/expenses/payer'
import type { InvoiceExtractionResult } from '@/types'

// The existing invoice surfaced on a duplicate-number conflict, used to drive
// the resolution dialog (open it / uncredit-and-retry).
export interface ExistingSupplierInvoice {
  id: string
  supplier_invoice_number: string
  status: string
  credit_note_id: string | null
}

// Canonical create/convert response. On failure `error` is the structured
// envelope's inner object ({ code, message, details }); a few legacy convert
// paths still return a flat string, so accept both.
export interface CreateResult {
  data?: {
    id: string
    arrival_number: number
    /** Set when the invoice was booked as an utlägg (a person paid). */
    expense_claim?: { id: string; claimant_name: string; liability_account: string } | null
  }
  warnings?: Array<{ code: string; message: string }>
  error?:
    | string
    | {
        code?: string
        message?: string
        message_en?: string
        details?: { existing?: ExistingSupplierInvoice | null }
      }
}

interface UseSupplierInvoiceSubmitParams {
  t: ReturnType<typeof useTranslations>
  ta: ReturnType<typeof useTranslations>
  toast: ReturnType<typeof useToast>['toast']
  isEF: boolean
  /** Inbox item to convert (route chooser + best-effort field sync-back). */
  inboxItemId: string | null
  originalExtracted: InvoiceExtractionResult | null
  buildPayload: (data: SupplierInvoiceFormData) => unknown
  reset: (data: SupplierInvoiceFormData) => void
  finishCreate: (invoiceId?: string) => void
  documentUploadInProgress: boolean
  documentUploadFailed: boolean
  showNoPeriodWarning: boolean
  canUseAccrual: boolean
  invoiceNumberInputRef: RefObject<HTMLInputElement | null>
  /** After an utlägg booked: the host refreshes server data (the Utlägg nav gate). */
  onExpenseRegistered?: () => void
  /**
   * Focus router for the always-enabled primary: called instead of a toast
   * when a required field is missing (supplier, invoice number, row account),
   * in the same priority order as the next-step line. Optional so the hook
   * can ship before the shell rebuild wires it.
   */
  onMissingField?: (
    field: 'supplier' | 'invoice_number' | 'rows' | 'row_account',
    rowIndex?: number,
  ) => void
}

/**
 * Submit orchestration for the supplier-invoice editor: endpoint chooser
 * (plain create vs inbox convert), the three submit paths (EF/private direct,
 * AB review, register-and-match), duplicate-number conflict recovery and the
 * best-effort inbox field sync-back. Extracted verbatim from
 * NewSupplierInvoiceForm; both endpoints validate CreateSupplierInvoiceSchema
 * and return the canonical error envelope.
 */
export function useSupplierInvoiceSubmit({
  t,
  ta,
  toast,
  isEF,
  inboxItemId,
  originalExtracted,
  buildPayload,
  reset,
  finishCreate,
  documentUploadInProgress,
  documentUploadFailed,
  showNoPeriodWarning,
  canUseAccrual,
  invoiceNumberInputRef,
  onExpenseRegistered,
  onMissingField,
}: UseSupplierInvoiceSubmitParams) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [pendingData, setPendingData] = useState<SupplierInvoiceFormData | null>(null)

  // Match-on-create state
  const [showBankPicker, setShowBankPicker] = useState(false)
  const [pendingTransactionId, setPendingTransactionId] = useState<string | null>(null)

  // Conflict state for duplicate-supplier-invoice-number
  const [conflict, setConflict] = useState<{
    message: string
    existing: ExistingSupplierInvoice | null
  } | null>(null)
  const [isResolvingConflict, setIsResolvingConflict] = useState(false)

  // Persist user edits back into the inbox item's extracted_data so the
  // inbox stays in sync with what was actually booked. Best-effort: a
  // failed PATCH never blocks the registration.
  async function patchInboxFieldsIfChanged(data: SupplierInvoiceFormData) {
    if (!inboxItemId || !originalExtracted) return
    const supplierField: Record<string, unknown> = {}
    const invoiceField: Record<string, unknown> = {}

    if (originalExtracted.invoice?.invoiceNumber !== data.supplier_invoice_number) {
      invoiceField.invoiceNumber = data.supplier_invoice_number || null
    }
    if (originalExtracted.invoice?.invoiceDate !== data.invoice_date) {
      invoiceField.invoiceDate = data.invoice_date || null
    }
    if (originalExtracted.invoice?.dueDate !== data.due_date) {
      invoiceField.dueDate = data.due_date || null
    }
    if ((originalExtracted.invoice?.paymentReference || null) !== (data.payment_reference || null)) {
      invoiceField.paymentReference = data.payment_reference || null
    }
    if (originalExtracted.invoice?.currency !== data.currency) {
      invoiceField.currency = data.currency
    }

    if (Object.keys(supplierField).length === 0 && Object.keys(invoiceField).length === 0) return

    try {
      await fetch(`/api/extensions/ext/invoice-inbox/items/${inboxItemId}/fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(Object.keys(supplierField).length ? { supplier: supplierField } : {}),
          ...(Object.keys(invoiceField).length ? { invoice: invoiceField } : {}),
        }),
      })
    } catch {
      // Best-effort sync; don't block registration on this.
    }
  }

  // Single submit endpoint chooser: convert when we came from inbox and the
  // company pays, plain POST otherwise (a person paying is an utlägg, which
  // only the core route books). Both endpoints validate the same CreateSupplierInvoiceSchema
  // and return the same canonical error envelope ({ error: { code, message,
  // details } }): including the recoverable duplicate-number 409.
  async function postCreate(data: SupplierInvoiceFormData): Promise<{
    ok: boolean
    status: number
    result: CreateResult
  }> {
    const url = supplierInvoiceCreateUrl(data.payer, inboxItemId)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(data)),
    })
    const result = await res.json()
    if (
      res.ok &&
      (result as CreateResult).warnings?.some((warning) => warning.code === 'DOCUMENT_LINK_FAILED')
    ) {
      toast({
        title: t('document_link_warning_title'),
        description: t('document_link_warning_description'),
        variant: 'destructive',
      })
    }
    return { ok: res.ok, status: res.status, result }
  }

  function onSubmit(data: SupplierInvoiceFormData) {
    if (documentUploadInProgress) {
      toast({
        title: t('document_upload_in_progress_title'),
        description: t('document_upload_in_progress_description'),
        variant: 'destructive',
      })
      return
    }
    if (documentUploadFailed) {
      toast({
        title: t('document_upload_failed_title'),
        description: t('document_upload_failed_description'),
        variant: 'destructive',
      })
      return
    }
    // Hard block: under faktureringsmetoden (and for privately-paid kvitton) a
    // verifikation is posted at registration, and BFL 5 kap kräver att
    // verifikationsnumret ligger i en obruten serie inom ett räkenskapsår. No
    // räkenskapsår for the invoice date → no compliant voucher can exist, so we
    // refuse rather than register an unbooked invoice. Kontantmetoden books at
    // payment, so it is intentionally not blocked here (see showNoPeriodWarning).
    if (showNoPeriodWarning) {
      toast({
        title: t('warning_title'),
        description: t('no_period_warning', { date: data.invoice_date }),
        variant: 'destructive',
      })
      return
    }
    if (!data.supplier_id) {
      if (onMissingField) onMissingField('supplier')
      else toast({ title: t('supplier_missing_title'), description: t('supplier_missing_description'), variant: 'destructive' })
      return
    }
    if (!data.supplier_invoice_number) {
      if (onMissingField) onMissingField('invoice_number')
      else toast({ title: t('invoice_number_missing_title'), description: t('invoice_number_missing_description'), variant: 'destructive' })
      return
    }
    // The dokument-först table starts with zero rows (the ghost entry row is
    // never part of form state): an empty items array must route to the entry
    // input instead of slipping past the per-row account check below.
    if (data.items.length === 0) {
      if (onMissingField) onMissingField('rows')
      else {
        toast({
          title: t('account_missing_title'),
          description: t('account_missing_description', { row: 1 }),
          variant: 'destructive',
        })
      }
      return
    }
    const rowWithoutAccount = data.items.findIndex((item) => !item.account_number)
    if (rowWithoutAccount !== -1) {
      if (onMissingField) onMissingField('row_account', rowWithoutAccount)
      else {
        toast({
          title: t('account_missing_title'),
          description: t('account_missing_description', { row: rowWithoutAccount + 1 }),
          variant: 'destructive',
        })
      }
      return
    }
    // Only 25/12/6/0 % are legal Swedish VAT rates (ML 2023:200). The free-text
    // VatRateCell clamps to [0, 100] but accepts anything in between, so block
    // illegal rates here. Reverse-charge invoices skip this: their line vat_rate
    // is forced to 0 and RcRateSelect already restricts the self-assessed rate.
    if (!data.reverse_charge) {
      const rowWithIllegalRate = findIllegalVatRateRow(data.items)
      if (rowWithIllegalRate !== -1) {
        toast({
          title: t('illegal_vat_rate_title'),
          description: t('illegal_vat_rate_description', {
            row: rowWithIllegalRate + 1,
            rate: rateToPctString(data.items[rowWithIllegalRate].vat_rate),
          }),
          variant: 'destructive',
        })
        return
      }
    }
    // A row with an open periodisering panel must carry a complete period of
    // at least two calendar months before the invoice can be booked.
    const invalidAccrual = canUseAccrual && data.items.some((item) => {
      if (item.accrual_balance_account == null) return false
      if (!item.accrual_period_start || !item.accrual_period_end) return true
      if (item.accrual_period_end < item.accrual_period_start) return true
      return countCalendarMonths(item.accrual_period_start, item.accrual_period_end) < 2
    })
    if (invalidAccrual) {
      toast({
        title: ta('incomplete_toast_title'),
        description: ta('incomplete_toast_description'),
        variant: 'destructive',
      })
      return
    }

    if (data.payer === 'company') {
      // "Företaget" is register-and-match: open the bank-transaction picker;
      // the actual create happens on pick. For AB the review dialog is shown
      // after a transaction is picked.
      setPendingData(data)
      setShowBankPicker(true)
      return
    }

    // A person paying skips the AB review dialog: the answer itself is the
    // explicit user intent, and the resulting verifikat is just expense + VAT
    // against that person's liability account. Same path for EF.
    if (isEF || isPersonPayer(data.payer)) {
      setPendingData(data)
      handleDirectSubmit(data)
    } else {
      setPendingData(data)
      setShowReview(true)
    }
  }

  // EF: create + auto-approve, no review dialog. Privately-paid invoices land
  // here too and skip auto-approve since they're already in status='paid'.
  async function handleDirectSubmit(data: SupplierInvoiceFormData) {
    setIsSubmitting(true)
    await patchInboxFieldsIfChanged(data)
    const { ok, status, result } = await postCreate(data)

    if (!ok) {
      // EF/direct path also hits the duplicate-number 409 (e.g. converting an
      // inbox receipt whose number was already registered): offer recovery
      // instead of a dead-end toast.
      if (!tryHandleDuplicateConflict(status, result)) {
        handleCreateError(status, result)
      }
      setIsSubmitting(false)
      return
    }
    if (!result.data) {
      setIsSubmitting(false)
      return
    }

    // Clear dirty state so useUnsavedChanges doesn't fire the
    // beforeunload prompt while we navigate away on a successful submit.
    reset(data)

    if (isPersonPayer(data.payer)) {
      const claim = result.data.expense_claim
      toast({
        title: t('expense_registered_title'),
        // An enskild firma owner's claim is an egen insättning (2018): no
        // debt, so there is no Att göra row to point at.
        description:
          claim && claim.liability_account !== '2018'
            ? t('expense_registered_description', {
                name: claim.claimant_name,
                number: result.data.arrival_number,
              })
            : t('arrival_number_label', { number: result.data.arrival_number }),
      })
      onExpenseRegistered?.()
      finishCreate()
      setIsSubmitting(false)
      return
    }

    // Auto-approve for EF
    const approveRes = await fetch(`/api/supplier-invoices/${result.data.id}/approve`, { method: 'POST' })
    if (!approveRes.ok) {
      toast({
        title: t('warning_title'),
        description: t('auto_approve_failed_description'),
        variant: 'destructive',
      })
      finishCreate(result.data.id)
    } else {
      toast({ title: t('invoice_registered_title'), description: t('arrival_number_label', { number: result.data.arrival_number }) })
      finishCreate()
    }
    setIsSubmitting(false)
  }

  // AB: create after review dialog. If a bank transaction was picked first
  // (register-and-match flow), also match the new invoice to it.
  async function handleConfirm() {
    if (!pendingData) return
    setIsSubmitting(true)
    await patchInboxFieldsIfChanged(pendingData)
    const { ok, status, result } = await postCreate(pendingData)

    if (ok && result.data) {
      const invoiceId = result.data.id
      const arrivalNumber = result.data.arrival_number
      setShowReview(false)
      // Clear dirty state: see comment in handleDirectSubmit.
      reset(pendingData)

      if (pendingTransactionId) {
        const matchRes = await fetch(`/api/transactions/${pendingTransactionId}/match-supplier-invoice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplier_invoice_id: invoiceId }),
        })
        const matchResult = await matchRes.json()
        setPendingTransactionId(null)

        if (matchRes.ok) {
          toast({
            title: t('invoice_registered_and_matched_title'),
            description: t('invoice_registered_and_matched_description', { number: arrivalNumber }),
          })
        } else {
          toast({
            title: t('invoice_registered_match_failed_title'),
            description: getErrorMessage(matchResult, { context: 'supplier_invoice', statusCode: matchRes.status }),
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: t('invoice_registered_title'), description: t('arrival_number_label', { number: arrivalNumber }) })
      }

      finishCreate(invoiceId)
    } else {
      // Treat duplicate-number as a recoverable conflict; everything else as a hard error.
      if (!tryHandleDuplicateConflict(status, result)) {
        handleCreateError(status, result)
      }
    }
    setIsSubmitting(false)
  }

  // Detect the recoverable duplicate-supplier-invoice-number conflict and open
  // the resolution dialog. Both the inbox `convert` route and the plain create
  // route return the same structured 409 envelope, so this works for every
  // submit path. Returns true when handled (caller should skip the error toast).
  function tryHandleDuplicateConflict(status: number, result: CreateResult): boolean {
    const err = result.error
    if (
      status !== 409 ||
      typeof err !== 'object' ||
      err === null ||
      err.code !== 'SI_CREATE_DUPLICATE_INVOICE_NUMBER'
    ) {
      return false
    }
    // Close the review dialog if it was the path that triggered the conflict;
    // a no-op for the EF/direct paths where it was never opened.
    setShowReview(false)
    setConflict({
      message: err.message || t('duplicate_default_message'),
      existing: err.details?.existing ?? null,
    })
    return true
  }

  // Shared error toast for non-conflict failures.
  function handleCreateError(status: number, result: CreateResult) {
    toast({
      title: t('register_invoice_failed_title'),
      description: getErrorMessage(result, { context: 'supplier_invoice', statusCode: status }),
      variant: 'destructive',
    })
  }

  async function handleUncreditAndRetry() {
    if (!conflict?.existing) return
    const existingId = conflict.existing.id
    const existingNumber = conflict.existing.supplier_invoice_number
    setIsResolvingConflict(true)

    const uncreditRes = await fetch(
      `/api/supplier-invoices/${existingId}/uncredit`,
      { method: 'POST' },
    )
    const uncreditResult = await uncreditRes.json()
    if (!uncreditRes.ok) {
      toast({
        title: t('uncredit_failed_title'),
        description: getErrorMessage(uncreditResult, { context: 'supplier_invoice', statusCode: uncreditRes.status }),
        variant: 'destructive',
      })
      setIsResolvingConflict(false)
      return
    }

    setConflict(null)

    if (!pendingData) {
      setIsResolvingConflict(false)
      return
    }

    const { ok, status, result } = await postCreate(pendingData)
    setIsResolvingConflict(false)

    if (ok && result.data) {
      toast({
        title: t('uncredit_and_register_success_title'),
        description: t('arrival_number_label', { number: result.data.arrival_number }),
      })
      reset(pendingData)
      finishCreate(result.data.id)
      return
    }

    toast({
      title: t('uncredit_but_register_failed_title'),
      description: t('uncredit_but_register_failed_description', {
        number: existingNumber,
        reason: getErrorMessage(result, { context: 'supplier_invoice', statusCode: status }),
      }),
      variant: 'destructive',
    })
  }

  function handlePickNewNumber() {
    setConflict(null)
    setTimeout(() => invoiceNumberInputRef.current?.focus(), 0)
  }

  // Match-on-create: register the invoice, then match the picked transaction.
  // EF goes straight through (auto-approve included). AB stores the picked
  // transaction and routes through the same review dialog as the plain
  // register flow: handleConfirm picks up the match step on confirmation.
  async function handlePickTransaction(transactionId: string) {
    if (!pendingData) return
    setShowBankPicker(false)

    if (!isEF) {
      setPendingTransactionId(transactionId)
      setShowReview(true)
      return
    }

    setIsSubmitting(true)
    await patchInboxFieldsIfChanged(pendingData)
    const { ok, status, result } = await postCreate(pendingData)

    if (!ok || !result.data) {
      if (!tryHandleDuplicateConflict(status, result)) {
        handleCreateError(status, result)
      }
      setIsSubmitting(false)
      return
    }

    const invoiceId = result.data.id
    const arrivalNumber = result.data.arrival_number

    // Auto-approve before matching, so the invoice is in the 'approved' state
    // that match-supplier-invoice expects (it accepts registered too, but
    // EF's expectation is fully-booked).
    await fetch(`/api/supplier-invoices/${invoiceId}/approve`, { method: 'POST' })

    const matchRes = await fetch(`/api/transactions/${transactionId}/match-supplier-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier_invoice_id: invoiceId }),
    })
    const matchResult = await matchRes.json()
    setIsSubmitting(false)

    if (matchRes.ok) {
      toast({
        title: t('invoice_registered_and_matched_title'),
        description: t('invoice_registered_and_matched_description', { number: arrivalNumber }),
      })
    } else {
      toast({
        title: t('invoice_registered_match_failed_title'),
        description: getErrorMessage(matchResult, { context: 'supplier_invoice', statusCode: matchRes.status }),
        variant: 'destructive',
      })
    }
    reset(pendingData)
    finishCreate(invoiceId)
  }

  return {
    isSubmitting,
    showReview,
    setShowReview,
    pendingData,
    showBankPicker,
    setShowBankPicker,
    setPendingTransactionId,
    conflict,
    setConflict,
    isResolvingConflict,
    onSubmit,
    handleConfirm,
    handleUncreditAndRetry,
    handlePickNewNumber,
    handlePickTransaction,
  }
}
