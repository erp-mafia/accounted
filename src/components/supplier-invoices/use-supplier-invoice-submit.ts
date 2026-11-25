'use client'

import { useReducer, useState, type RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { invoiceMonthOnlyAccrualRows } from '@/lib/bookkeeping/accruals/compute'
import { findIllegalVatRateRow } from '@/lib/vat/supplier-invoice-line-checks'
import {
  rateToPctString,
  reverseChargeKindMissing,
  supplierInvoiceCreateUrl,
  type SupplierInvoiceFormData,
} from '@/lib/supplier-invoices/form-payload'
import { isPersonPayer } from '@/lib/expenses/payer'
import { registrationPassesReview } from '@/lib/supplier-invoices/duplicate-lookup-query'
import { pendingRegistrationReducer } from '@/lib/supplier-invoices/pending-registration'
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

/** What POST /api/inkorg/items/:id/register-and-settle answers. */
interface RegisterAndSettleResult extends Omit<CreateResult, 'data'> {
  data?: {
    supplier_invoice_id: string
    arrival_number: number
    settled: boolean
    settlement_error: { code: string; message: string; message_en?: string } | null
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
   * The bank row this inbox invoice was paid by, when the Inkorg already
   * knows it (match on arrival). "Företaget" then needs no picker: the
   * invoice is registered and settled against that row in one request.
   */
  settleTransactionId?: string | null
  /** The supplier is in another EU country: its reverse charge must say goods or services. */
  euSupplier: boolean
  /**
   * Whether this registration has something to acknowledge in the review
   * dialog first: a payment reference another invoice of the supplier already
   * carries, or the same document registered again
   * (lib/supplier-invoices/duplicate-lookup.ts). Asked when the person
   * submits, so a lookup still on its way is waited for.
   */
  acknowledgesInReview?: (data: SupplierInvoiceFormData) => Promise<boolean>
  /**
   * Focus router for the always-enabled primary: called instead of a toast
   * when a required field is missing (supplier, invoice number, row account,
   * goods or services), in the same priority order as the next-step line.
   * Optional so the hook can ship before the shell rebuild wires it.
   */
  onMissingField?: (
    field: 'supplier' | 'invoice_number' | 'rows' | 'row_account' | 'reverse_charge_kind',
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
  settleTransactionId = null,
  euSupplier,
  acknowledgesInReview,
}: UseSupplierInvoiceSubmitParams) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showReview, setShowReview] = useState(false)
  // The submitted form and the bank row it is matched to, as one value: a
  // new submit starts a new one, so a row picked for an earlier submit never
  // comes along (lib/supplier-invoices/pending-registration.ts).
  const [pending, dispatchPending] = useReducer(pendingRegistrationReducer, null)
  const pendingData = pending?.data ?? null
  const pendingTransactionId = pending?.transactionId ?? null

  // Match-on-create state
  const [showBankPicker, setShowBankPicker] = useState(false)

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
    // The invoice states bank details the supplier card lacks: registered,
    // but its payment waits for a person's approval (lib/payments/payee-alerts.ts).
    if (
      res.ok &&
      (result as CreateResult).warnings?.some((warning) => warning.code === 'SUPPLIER_PAYEE_CHANGED' || warning.code === 'SUPPLIER_PAYEE_NEW')
    ) {
      toast({ title: t('payee_alert_toast_title'), description: t('payee_alert_toast_description') })
    }
    return { ok: res.ok, status: res.status, result }
  }

  // Whether the review dialog comes first (registrationPassesReview). Asked
  // on every path, so the dialog opens with the answer already in.
  async function reviewsBeforeRegistering(data: SupplierInvoiceFormData): Promise<boolean> {
    // Busy while it is asked: a second click must not register twice.
    setIsSubmitting(true)
    try {
      const acknowledges = (await acknowledgesInReview?.(data)) ?? false
      return registrationPassesReview({ isEF, personPaid: isPersonPayer(data.payer), acknowledges })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function onSubmit(data: SupplierInvoiceFormData) {
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
    // Hard block: under faktureringsmetoden without deferred booking (and for
    // privately-paid kvitton) a verifikation is posted at registration, and BFL
    // 5 kap kräver att verifikationsnumret ligger i en obruten serie inom ett
    // räkenskapsår. No räkenskapsår for the invoice date → no compliant voucher
    // can exist, so we refuse rather than register an unbooked invoice.
    // Kontantmetoden books at payment and deferred booking at the Bokför step,
    // so neither is blocked here (see showNoPeriodWarning).
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
    // A självfaktura takes its number from the company's series (crm#1367).
    if (!data.supplier_invoice_number && !data.is_self_billed) {
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
    // Goods (ruta 20) or services (ruta 21) has no default: a silent
    // "services" booked EU goods in the wrong box (crm#1323).
    if (reverseChargeKindMissing(data, euSupplier)) {
      if (onMissingField) onMissingField('reverse_charge_kind')
      else toast({ title: t('warning_title'), description: t('reverse_charge_kind_missing'), variant: 'destructive' })
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
    // A row with an open periodisering panel must carry a complete period
    // before the invoice can be booked, and a period lying only in the
    // invoice month moves nothing (the API refuses it).
    const openAccrualItems = canUseAccrual
      ? data.items.filter((item) => item.accrual_balance_account != null)
      : []
    const incompleteAccrual = openAccrualItems.some(
      (item) =>
        !item.accrual_period_start ||
        !item.accrual_period_end ||
        item.accrual_period_end < item.accrual_period_start,
    )
    if (incompleteAccrual) {
      toast({
        title: ta('incomplete_toast_title'),
        description: ta('incomplete_toast_description'),
        variant: 'destructive',
      })
      return
    }
    if (data.invoice_date && invoiceMonthOnlyAccrualRows(data.invoice_date, openAccrualItems).length > 0) {
      toast({
        title: ta('invoice_month_toast_title'),
        description: ta('invoice_month_toast_description'),
        variant: 'destructive',
      })
      return
    }

    dispatchPending({ type: 'submitted', data, knownTransactionId: inboxItemId ? settleTransactionId : null })
    if (data.payer === 'company') {
      if (settleTransactionId && inboxItemId) {
        // The bank row is already known: no picker. AB reviews first, as
        // after a pick; EF goes straight through.
        if (await reviewsBeforeRegistering(data)) setShowReview(true)
        else void handleRegisterAndSettle(data, settleTransactionId)
        return
      }
      // "Företaget" is register-and-match: open the bank-transaction picker;
      // the actual create happens on pick. For AB the review dialog is shown
      // after a transaction is picked.
      setShowBankPicker(true)
      return
    }

    // A person paying skips the AB review dialog: the answer itself is the
    // explicit user intent, and the resulting verifikat is just expense + VAT
    // against that person's liability account. Same path for EF.
    if (await reviewsBeforeRegistering(data)) setShowReview(true)
    else handleDirectSubmit(data)
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

  // Registered and settled against the known bank row in one request
  // (POST /api/inkorg/items/:id/register-and-settle). When the settlement
  // fails the invoice stays registered and unpaid, and the toast says why.
  async function handleRegisterAndSettle(data: SupplierInvoiceFormData, transactionId: string) {
    if (!inboxItemId) return
    setIsSubmitting(true)
    await patchInboxFieldsIfChanged(data)
    const res = await fetch(`/api/inkorg/items/${inboxItemId}/register-and-settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: transactionId, invoice: buildPayload(data) }),
    })
    const result = (await res.json()) as RegisterAndSettleResult
    if (!res.ok || !result.data) {
      setShowReview(false)
      const failure: CreateResult = { error: result.error }
      if (!tryHandleDuplicateConflict(res.status, failure)) handleCreateError(res.status, failure)
      setIsSubmitting(false)
      return
    }
    const answer = result.data
    setShowReview(false)
    // Clear dirty state: see comment in handleDirectSubmit.
    reset(data)
    if (result.warnings?.some((warning) => warning.code === 'SUPPLIER_PAYEE_CHANGED' || warning.code === 'SUPPLIER_PAYEE_NEW')) {
      toast({ title: t('payee_alert_toast_title'), description: t('payee_alert_toast_description') })
    }
    if (answer.settled) {
      toast({
        title: t('invoice_registered_and_matched_title'),
        description: t('invoice_registered_and_matched_description', { number: answer.arrival_number }),
      })
    } else {
      toast({
        title: t('invoice_registered_match_failed_title'),
        description: getErrorMessage({ error: answer.settlement_error }, { context: 'supplier_invoice' }),
        variant: 'destructive',
      })
      // An EF registration is attested at once (handleDirectSubmit); a paid one has nothing left to attest.
      if (isEF) await fetch(`/api/supplier-invoices/${answer.supplier_invoice_id}/approve`, { method: 'POST' }).catch(() => undefined)
    }
    finishCreate(answer.supplier_invoice_id)
    setIsSubmitting(false)
  }

  // AB: create after review dialog. If a bank transaction was picked first
  // (register-and-match flow), also match the new invoice to it.
  async function handleConfirm() {
    if (!pendingData) return
    if (settleTransactionId && pendingTransactionId === settleTransactionId && pendingData.payer === 'company') {
      await handleRegisterAndSettle(pendingData, settleTransactionId)
      return
    }
    // EF and a person's utlägg passed the dialog only to acknowledge
    // (reviewsBeforeRegistering): they register the way they do without it.
    if (isEF || isPersonPayer(pendingData.payer)) {
      setShowReview(false)
      if (pendingTransactionId) await registerAndMatchUnreviewed(pendingData, pendingTransactionId)
      else await handleDirectSubmit(pendingData)
      return
    }
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

    if (await reviewsBeforeRegistering(pendingData)) {
      dispatchPending({ type: 'row_picked', transactionId })
      setShowReview(true)
      return
    }
    await registerAndMatchUnreviewed(pendingData, transactionId)
  }

  // EF's register-and-match: create, attest, then match the picked bank row.
  async function registerAndMatchUnreviewed(pendingData: SupplierInvoiceFormData, transactionId: string) {
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
