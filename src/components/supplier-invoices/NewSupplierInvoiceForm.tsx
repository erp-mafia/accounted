'use client'

import { Fragment, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm, Controller, useFieldArray } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import AiFilledIndicator from '@/components/ui/ai-filled-indicator'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import { chartVatTreatmentsOf } from '@/lib/bookkeeping/vat-entries'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import { supplierInvoiceBookingMoment, supplierInvoiceRegistrationDate } from '@/lib/bookkeeping/booking-mode'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { accountNameForRow } from '@/lib/bookkeeping/account-descriptions'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-template-format'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { exceedsHostedUploadLimit } from '@/lib/documents/upload-size'
import { postDocumentForm, uploadViaSignedUrl } from '@/lib/documents/direct-upload'
import { INBOX_UPLOAD_ACCEPT, isAllowedInboxFile } from '@/lib/documents/upload-types'
import { cn, formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import {
  invoiceTotalsCrosscheck,
  invoiceVatIsBooked,
  rowNetFromInvoiceTotals,
  rowsAgainstInvoiceTotals,
  totalFirstFill,
} from '@/lib/supplier-invoices/total-first'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFiledVatPeriod } from '@/lib/hooks/use-filed-vat-period'
import BankTransactionPicker from '@/components/transactions/BankTransactionPicker'
import AccrualPeriodControl from '@/components/bookkeeping/AccrualPeriodControl'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import {
  DEFAULT_PREPAID_EXPENSE_ACCOUNT,
  suggestBalanceAccount,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import {
  findReverseChargeAccountWarningRows,
  findUnflaggedForeignZeroVatRows,
  isForeignSupplierType,
} from '@/lib/vat/supplier-invoice-line-checks'
import { SLP_RATE, isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { roundOre, parseAmountInput } from '@/lib/money'
import {
  buildSupplierInvoicePayload,
  statedVatFromInvoiceField,
  reverseChargeKindMissing,
  type SupplierInvoiceFormData,
  type SupplierInvoiceLineItem,
} from '@/lib/supplier-invoices/form-payload'
import { plantedRowTouched, snapshotPlantedRow } from '@/lib/supplier-invoices/planted-rows'
import { reverseChargeRateDefault, reverseChargeRateOf } from '@/lib/supplier-invoices/reverse-charge-rate'
import {
  bookLimitedDeduction,
  deductibleRowVat,
  invoicedRowVat,
  limitedDeductionApplies,
} from '@/lib/supplier-invoices/limited-deduction'
import { rememberedReverseChargeKind } from '@/lib/supplier-invoices/remembered-kind'
import { VatRateCell, RcRateSelect, AmountCell } from '@/components/supplier-invoices/supplier-invoice-cells'
import { useSupplierInvoiceData } from '@/components/supplier-invoices/use-supplier-invoice-data'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { isInvoiceTypeEnabled } from '@/lib/invoices/invoice-type-toggles'
import { useInboxPrefill, type InboxItemData } from '@/components/supplier-invoices/use-inbox-prefill'
import { accrualFrameworkOf, accrualThresholdSek } from '@/components/bookkeeping/accrual-k2-hint'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import {
  PLAIN_DOCUMENT_UPLOAD_URL,
  documentIdFromPlainUpload,
  plainDocumentUploadForm,
  underlagUploadRoute,
} from '@/lib/documents/underlag-upload-route'
import { regionOfCountry, sellerCountry, supplierTypeForRegion } from '@/lib/vat/seller-country'
import { useSupplierInvoiceSubmit } from '@/components/supplier-invoices/use-supplier-invoice-submit'
import { useSupplierInvoiceDuplicates } from '@/components/supplier-invoices/use-supplier-invoice-duplicates'
import {
  DuplicateNumberLine,
  ReusedReferenceLine,
  ReusedReferenceSentence,
  duplicateNumberSentence,
} from '@/components/supplier-invoices/DuplicateWarnings'
import { PayerChoiceSelect } from '@/components/expenses/PayerChoiceSelect'
import { ExpenseClaimantFields } from '@/components/expenses/ExpenseClaimantFields'
import { isPersonPayer } from '@/lib/expenses/payer'
import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  PercentBadgeIcon,
  ChatBubbleOvalLeftIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  HashtagIcon,
  LockClosedIcon,
  PlusIcon,
  SpinnerIcon,
  TrashIcon,
} from '@/components/icons'
import type { Supplier, InvoiceExtractionResult } from '@/types'
import { todayIsoStockholm, invoiceDueDate } from '@/lib/dates/iso'
import { isIsoDateShaped } from '@/lib/invariants/iso-date'

// The form's line/field shapes live in lib/supplier-invoices/form-payload.ts
// next to the payload builder they feed, pinned there by parity tests.
type FormData = SupplierInvoiceFormData

interface NewSupplierForm {
  name: string
  supplier_type: string
  org_number: string
  vat_number: string
  address_line1: string
  bankgiro: string
  plusgiro: string
  iban: string
  bic: string
  default_expense_account: string
  /** The country the reading names (lib/vat/seller-country.ts); sent while the type agrees with it. */
  country: string
}

const EMPTY_NEW_SUPPLIER: NewSupplierForm = {
  name: '',
  supplier_type: 'swedish_business',
  org_number: '',
  vat_number: '',
  address_line1: '',
  bankgiro: '',
  plusgiro: '',
  iban: '',
  bic: '',
  default_expense_account: '',
  country: '',
}

// Dense in-table inputs: leaf tier inside the Kontering table surface.
const CELL_INPUT_CLASS =
  'h-8 rounded-sm border-transparent bg-transparent px-2 text-[13px] hover:bg-secondary/60 focus-visible:bg-card'
// Row controls: 24x24 hit area (pre-approved dense-row exception to the 40px
// icon-button floor), revealed on hover/focus-within, always on coarse pointers.
const ROW_ICON_BTN_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground'

const UNDERLAG_MAX_SIZE = 10 * 1024 * 1024

// A deferred web upload returns an empty extraction skeleton (confidence 0)
// while processing; only apply a prefill that actually carries content.
function hasExtractionContent(e: InvoiceExtractionResult | null | undefined): boolean {
  if (!e) return false
  return Boolean(
    e.supplier?.name ||
      e.invoice?.invoiceNumber ||
      e.invoice?.invoiceDate ||
      (e.lineItems && e.lineItems.length > 0) ||
      e.totals?.total != null,
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/** The bank row an inbox invoice was paid by, when the Inkorg found it on arrival. */
export interface SettleWithBankRow {
  transactionId: string
  date: string
  /** As the bank row carries it: signed, in `currency`. */
  amount: number
  currency: string
  counterparty: string | null
}

export interface NewSupplierInvoiceFormProps {
  /** Invoice-inbox item to convert; prefills the form from its AI extraction. */
  inboxItemId?: string | null
  /**
   * With an inbox item: the bank row that paid it. "Vem betalade?" starts on
   * Företaget, and Registrera registers the invoice and settles it against
   * this row in one step instead of asking for the row.
   */
  settleWith?: SettleWithBankRow | null
  /**
   * Render without page chrome (back button + h1) for use inside
   * NewSupplierInvoiceDialog: the same convention as JournalEntryForm's
   * `bare`.
   */
  bare?: boolean
  /**
   * Called after a successful create instead of the standalone page's
   * navigation, so a dialog host can close itself and refresh in place.
   * Receives the new invoice id when the natural next step is its detail
   * page, undefined when the flow is fully done (e.g. expense registered).
   */
  onCreated?: (invoiceId?: string) => void
  /** Called by the Avbryt button instead of navigating (dialog mode). */
  onCancel?: () => void
  /**
   * With an inbox item: the cost account of what was bought (the Inkorg's
   * booking plan), put on every line the reading gives instead of leaving
   * the account empty.
   */
  prefillAccount?: string | null
  /**
   * Dialog mode, without an inbox item: told the document id of the file
   * dropped into Underlag once it is stored (null when it is removed), so
   * the dialog can show it beside the form. Pass a stable function.
   */
  onUnderlagDocument?: (documentId: string | null) => void
}

export default function NewSupplierInvoiceForm({
  inboxItemId = null,
  settleWith = null,
  bare = false,
  onCreated,
  onCancel,
  prefillAccount = null,
  onUnderlagDocument,
}: NewSupplierInvoiceFormProps = {}) {
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_editor')
  // Loads the BAS chart chunk after mount and re-renders once names and
  // descriptions for non-hardcoded accounts are available.
  useBasReference()
  const ta = useTranslations('accruals')

  // When opened from an invoice-inbox item, every redirect should land the
  // user back in the inbox so they can pick the next document. Outside the
  // inbox flow, preserve the original behavior (detail page when we have an
  // invoice id, otherwise the list).
  const afterCreate = (invoiceId?: string) =>
    inboxItemId
      ? '/e/general/invoice-inbox'
      : invoiceId
        ? `/supplier-invoices/${invoiceId}`
        : '/supplier-invoices'

  // After a successful create: hand control back to the host when mounted
  // with onCreated (dialog mode), otherwise navigate like the old standalone
  // page did.
  const finishCreate = (invoiceId?: string) => {
    createFinishedRef.current = true
    if (onCreated) onCreated(invoiceId)
    else router.push(afterCreate(invoiceId))
  }

  const {
    suppliers,
    refreshSuppliers,
    suppliersLoaded,
    accounts,
    entityType,
    accountingMethod,
    bookingMoment,
    oreRoundingChoice,
    setOreRounding,
    dimensionsEnabled,
    vatRegistered,
    periods,
    periodsLoaded,
  } = useSupplierInvoiceData()
  const { settings: companySettingsRow } = useCompanySettings()

  /** The fiscal year a date is booked in, when the periods are known. */
  const fiscalYearOf = (date: string | null | undefined) =>
    (date ? periods.find((p) => date >= p.period_start && date <= p.period_end) : undefined) ?? null
  /** The start of the fiscal year a date is booked in, when the periods are known. */
  const fiscalYearStartOf = (date: string | null | undefined): string | null =>
    fiscalYearOf(date)?.period_start ?? null
  // The accrual limit follows the framework too (K3: none).
  const accrualFramework = accrualFrameworkOf(useCompanyOptional()?.company)
  const underlagRoute = underlagUploadRoute({ hasAiCapability: useCapability(CAPABILITY.ai) })

  const [defaultDims, setDefaultDims] = useState<Record<string, string>>({})
  // The invoice-level tags start as the supplier's default (accounted#144)
  // until the user picks one: a supplier switch then swaps in the new
  // supplier's default, a pick of their own is kept.
  const defaultDimsPickedRef = useRef(false)
  const [defaultDimsFromSupplier, setDefaultDimsFromSupplier] = useState(false)
  const [showNewSupplier, setShowNewSupplier] = useState(false)
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false)
  const [pendingSupplierSelect, setPendingSupplierSelect] = useState<string | null>(null)
  const [newSupplier, setNewSupplier] = useState<NewSupplierForm>(EMPTY_NEW_SUPPLIER)
  const [documentFiles, setDocumentFiles] = useState<UploadedFile[]>([])
  const documentFilesRef = useRef<UploadedFile[]>([])
  const createFinishedRef = useRef(false)
  // The uploads Avbryt has already removed itself, so the unmount cleanup
  // below does not delete them a second time (each second delete was a 404).
  const discardedUploadIdsRef = useRef(new Set<string>())
  const invoiceNumberInputRef = useRef<HTMLInputElement | null>(null)

  // Dokument-först state: a standalone upload routed through the invoice-inbox
  // pipeline gets an inbox item id (extraction + convert endpoint); a fallback
  // upload through /api/documents stays a plain attached document.
  const [uploadedInboxItemId, setUploadedInboxItemId] = useState<string | null>(null)
  const uploadedInboxItemIdRef = useRef<string | null>(null)
  const [extractionPhase, setExtractionPhase] = useState<'idle' | 'processing' | 'slow' | 'done' | 'failed'>('idle')
  const extractionPollTokenRef = useRef(0)
  const underlagInputRef = useRef<HTMLInputElement | null>(null)
  const [isDraggingUnderlag, setIsDraggingUnderlag] = useState(false)
  // Deferred tolkning that landed while the user was already typing: buffered
  // instead of applied, surfaced as a quiet click-to-apply line (see
  // applyExtractionIfPristine below).
  const [pendingExtraction, setPendingExtraction] = useState<InboxItemData | null>(null)

  // Fields the tolkning just filled: they get the brief settle tint (the CSS
  // animation is gated on prefers-reduced-motion in globals.css).
  const [settledFields, setSettledFields] = useState<Set<string>>(() => new Set())

  // Terms-based due date (change 4): auto-filled from the supplier's
  // default_payment_terms until the user (or the AI) sets it explicitly.
  const dueDateManualRef = useRef(false)
  const lastAutoDueRef = useRef<string | null>(null)
  const [dueDateCaption, setDueDateCaption] = useState<
    { type: 'terms'; days: number } | { type: 'on_invoice' } | null
  >(null)

  // Fakturabelopp and Moms as the invoice states them (total-first): they
  // fill a single empty row, switch öresavrundning on when the gap is
  // whole-krona rounding, and otherwise cross-check. Never in the payload.
  const [fakturaTotalStr, setFakturaTotalStr] = useState('')
  const [fakturaVatStr, setFakturaVatStr] = useState('')
  // The net the total-first fill last put on the single row: a row amount
  // still equal to it is the fill's to update, any other amount is the
  // person's and is never overwritten.
  const totalFillRef = useRef<number | null>(null)
  // Whether a reading made the rows: under reverse charge the fill leaves
  // such a row as read (totalFirstFill).
  const readingRowsRef = useRef(false)

  // Shell state
  const [forvalOpen, setForvalOpen] = useState(false)
  const supplierInputRef = useRef<HTMLInputElement | null>(null)
  const entryInputRef = useRef<HTMLInputElement | null>(null)
  const reverseChargeKindRef = useRef<HTMLButtonElement | null>(null)
  const [entryResetKey, setEntryResetKey] = useState(0)
  const amountInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const [pendingAmountFocus, setPendingAmountFocus] = useState<number | null>(null)
  const accountInputRefs = useRef<Record<number, HTMLInputElement | null>>({})

  const { register, control, handleSubmit, watch, setValue, getValues, reset, formState: { isDirty } } = useForm<FormData>({
    defaultValues: {
      supplier_id: '',
      supplier_invoice_number: '',
      invoice_date: todayIsoStockholm(),
      due_date: '',
      delivery_date: '',
      currency: 'SEK',
      exchange_rate: '',
      reverse_charge: false,
      reverse_charge_kind: '',
      payment_reference: '',
      notes: '',
      payer: settleWith && inboxItemId ? 'company' : 'unpaid',
      claimant_name: '',
      employee_id: '',
      is_self_billed: false,
      // The table starts empty: the ghost entry row (never part of form
      // state) is the only way rows are born, so no silent prefilled expense
      // account can ever reach a verifikat unnoticed.
      items: [],
    },
  })

  useUnsavedChanges(isDirty)

  // Live dirty flag for long-lived closures (the 90 s extraction poll):
  // the destructured `isDirty` in that closure is frozen at poll start.
  const isDirtyRef = useRef(false)
  useEffect(() => {
    isDirtyRef.current = isDirty
  }, [isDirty])

  useEffect(() => {
    documentFilesRef.current = documentFiles
  }, [documentFiles])

  useEffect(() => {
    uploadedInboxItemIdRef.current = uploadedInboxItemId
  }, [uploadedInboxItemId])

  // Stop any in-flight extraction poll on unmount.
  useEffect(() => () => {
    extractionPollTokenRef.current += 1
  }, [])

  useEffect(() => () => {
    if (inboxItemId || createFinishedRef.current) return
    const discarded = discardedUploadIdsRef.current
    // A standalone upload that went through the inbox pipeline created an
    // inbox item alongside the document: clean up both (same orphan-cleanup
    // contract as the plain path; the item DELETE 409s if it was converted).
    const itemId = uploadedInboxItemIdRef.current
    if (itemId && !discarded.has(itemId)) {
      void fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`, {
        method: 'DELETE',
        keepalive: true,
      })
    }
    for (const file of documentFilesRef.current) {
      if (file.status === 'uploaded' && file.id && !discarded.has(file.id)) {
        void fetch(`/api/documents/${file.id}`, { method: 'DELETE', keepalive: true })
      }
    }
  }, [inboxItemId])

  const { fields, append, remove, replace } = useFieldArray({ control, name: 'items' })
  const watchedItems = watch('items')
  const watchedSupplierId = watch('supplier_id')
  const watchedCurrency = watch('currency')
  const watchedExchangeRate = watch('exchange_rate')
  const watchedPayer = watch('payer')
  const watchedClaimantName = watch('claimant_name')
  const watchedEmployeeId = watch('employee_id')
  // A person paid: the invoice is an utlägg (cost + moms against that
  // person's liability, an open claim on Hem) instead of a 2440 payable.
  const watchedPaidPrivately = isPersonPayer(watchedPayer)
  const watchedReverseCharge = watch('reverse_charge')
  const watchedSelfBilled = watch('is_self_billed') === true
  // The Moms field only exists where an invoice moms can be booked.
  const fakturaVatVisible = invoiceVatIsBooked(vatRegistered, watchedReverseCharge)
  const enteredFakturaTotal = parseAmountInput(fakturaTotalStr)
  const enteredFakturaVat = fakturaVatVisible ? parseAmountInput(fakturaVatStr) : null
  // The net a single row takes from the totals at a moms sats, or null
  // without a Fakturabelopp.
  function totalFirstNetAt(rate: number): number | null {
    if (enteredFakturaTotal == null) return null
    return rowNetFromInvoiceTotals({
      total: enteredFakturaTotal,
      vat: enteredFakturaVat,
      rate,
      reverseCharge: watchedReverseCharge,
    })
  }
  const watchedReverseChargeKind = watch('reverse_charge_kind')
  // An EU supplier's reverse charge books goods (ruta 20) or services
  // (ruta 21): the form asks which, and sends it only then (crm#1323).
  const euSupplier = suppliers.find((s) => s.id === watchedSupplierId)?.supplier_type === 'eu_business'
  const asksReverseChargeKind = watchedReverseCharge && euSupplier
  const reverseChargeKindUnanswered = reverseChargeKindMissing(
    { reverse_charge: watchedReverseCharge, reverse_charge_kind: watchedReverseChargeKind },
    euSupplier,
  )
  // Watched values used to decide whether the AI-filled indicator should
  // still be visible. Once the user edits a field, its value no longer
  // matches what the extractor wrote, and the dot fades out.
  const watchedInvoiceNumber = watch('supplier_invoice_number')
  const watchedInvoiceDate = watch('invoice_date')
  const watchedDueDate = watch('due_date')
  const watchedPaymentReference = watch('payment_reference')
  const watchedDeliveryDate = watch('delivery_date')
  const watchedNotes = watch('notes')
  const documentUploadInProgress = documentFiles.some((file) => file.status === 'uploading')
  const documentUploadFailed = documentFiles.some((file) => file.status === 'error')
  const uploadedDocumentId = documentFiles.find((file) => file.status === 'uploaded')?.id
  useEffect(() => {
    onUnderlagDocument?.(uploadedDocumentId ?? null)
  }, [uploadedDocumentId, onUnderlagDocument])

  // Settle-tint bookkeeping: applyInboxItem reports every field it fills.
  const markSettled = useCallback((field: string) => {
    setSettledFields((prev) => {
      const next = new Set(prev)
      next.add(field)
      return next
    })
  }, [])

  const handleFieldPrefilled = useCallback(
    (field: string) => {
      if (field === 'due_date') {
        // An AI-extracted due date is an explicit value: the terms-based
        // auto-update must never overwrite it.
        dueDateManualRef.current = true
        setDueDateCaption(null)
      }
      markSettled(field)
    },
    [markSettled],
  )

  const handleInvoiceTotalPrefilled = useCallback(
    (total: number) => {
      setFakturaTotalStr(formatAmount(total))
      markSettled('faktura_total')
    },
    [markSettled],
  )

  const handleInvoiceVatPrefilled = useCallback(
    (vat: number | null) => {
      setFakturaVatStr(vat == null ? '' : formatAmount(vat))
      if (vat != null) markSettled('faktura_vat')
    },
    [markSettled],
  )

  // The rows a reading proposes: a single row holding the total-first net is
  // the fill's to keep in step with the totals, any other rows stand as read.
  const replaceRowsFromReading = useCallback(
    (items: SupplierInvoiceLineItem[], filledNet: number | null) => {
      totalFillRef.current = filledNet
      readingRowsRef.current = true
      replace(items)
    },
    [replace],
  )

  useEffect(() => {
    if (settledFields.size === 0) return
    const timer = setTimeout(() => setSettledFields(new Set()), 1200)
    return () => clearTimeout(timer)
  }, [settledFields])

  const {
    extractedData,
    originalExtracted,
    hasMatchedSupplier,
    setHasMatchedSupplier,
    isLoadingInbox,
    applyCount: prefillApplyCount,
    applyInboxItem,
    readingRowsChoice,
    toggleReadingRows,
  } = useInboxPrefill({
    inboxItemId,
    suppliersLoaded,
    suppliers,
    setValue,
    replace: replaceRowsFromReading,
    reset,
    getValues,
    toast,
    t,
    onFieldPrefilled: handleFieldPrefilled,
    onInvoiceTotal: handleInvoiceTotalPrefilled,
    onInvoiceVat: handleInvoiceVatPrefilled,
    prefillAccount,
    vatRegistered,
    reverseCharge: watchedReverseCharge,
    items: watchedItems,
    accounts,
    accrualThresholdFor: (invoiceDate) =>
      accrualThresholdSek({
        entityType,
        framework: accrualFramework,
        fiscalYearStart: fiscalYearStartOf(invoiceDate),
        fiscalYearEnd: fiscalYearOf(invoiceDate)?.period_end ?? null,
      }),
  })

  // Returns true when the field currently matches whatever the AI wrote
  // when the form first loaded. Edits diverge it, hiding the dot.
  function stillFromAi(value: string | null | undefined, original: string | null | undefined): boolean {
    if (!original) return false
    return (value ?? '') === (original ?? '')
  }
  const aiFlags = {
    invoiceNumber: stillFromAi(watchedInvoiceNumber, originalExtracted?.invoice?.invoiceNumber ?? null),
    invoiceDate: stillFromAi(watchedInvoiceDate, originalExtracted?.invoice?.invoiceDate ?? null),
    dueDate: stillFromAi(watchedDueDate, originalExtracted?.invoice?.dueDate ?? null),
    paymentReference: stillFromAi(
      watchedPaymentReference,
      originalExtracted?.invoice?.paymentReference ?? null,
    ),
  }

  const isEF = entityType === 'enskild_firma'

  // Out-of-period guard (mirrors the manual voucher form). A registration JE is
  // only posted at registration time when the booking moment is 'issue' or the
  // invoice is marked paid privately (the same rule as create.ts): cash method
  // books at payment and deferred booking at the Bokför step, so an
  // out-of-period date is fine there and we stay quiet. periodsLoaded gates the
  // warning so it never flashes before the fiscal periods have been fetched.
  // Registered and settled against the bank row in one request (the Inkorg's
  // register-and-settle): a company that books supplier invoices in a
  // separate Bokför step gets the registration verifikat booked now, first,
  // by the settlement (lib/supplier-invoices/registration-first.ts), so the
  // form says what happens, not "when you choose Bokför".
  // Under kontantmetoden an EU goods acquisition is booked at registration
  // too (ML 7 kap. 26 §), by the rule create.ts posts by.
  const settlesNow = !!(settleWith && inboxItemId && watchedPayer === 'company')
  const watchedSupplierType = suppliers.find((s) => s.id === watchedSupplierId)?.supplier_type
  const invoiceBookingMomentHere = supplierInvoiceBookingMoment(
    bookingMoment,
    { reverse_charge: watchedReverseCharge, reverse_charge_kind: watchedReverseChargeKind || null },
    watchedSupplierType,
  )
  const effectiveBookingMoment = settlesNow && invoiceBookingMomentHere === 'manual' ? 'issue' : invoiceBookingMomentHere
  const willBookAtRegistration = effectiveBookingMoment === 'issue' || watchedPaidPrivately
  // The registration verifikat's date, by the rule the builder dates it by:
  // an EU goods acquisition at the latest on the 15th of the month after its
  // delivery (ML 7 kap. 26 §). The utlägg verifikat keeps the invoice date.
  const registrationDateHere = supplierInvoiceRegistrationDate(
    {
      invoice_date: watchedInvoiceDate || '',
      delivery_date: watchedDeliveryDate || null,
      reverse_charge: watchedReverseCharge,
      reverse_charge_kind: watchedReverseChargeKind || null,
    },
    watchedSupplierType,
  )
  const registrationDateCapped = !watchedPaidPrivately && !!watchedInvoiceDate && registrationDateHere !== watchedInvoiceDate
  const bookedDateHere = watchedPaidPrivately ? watchedInvoiceDate : registrationDateHere
  const invoiceDateOutsidePeriod =
    periodsLoaded &&
    !!bookedDateHere &&
    !periods.some((p) => bookedDateHere >= p.period_start && bookedDateHere <= p.period_end)
  const showNoPeriodWarning = willBookAtRegistration && invoiceDateOutsidePeriod
  // The date the registration books on, against the filed momsdeklarationer:
  // a late invoice dated in a filed period books there, and its moms then
  // changes a declaration already filed.
  const bookedDateFiledVat = useFiledVatPeriod(bookedDateHere, willBookAtRegistration && !invoiceDateOutsidePeriod)

  // Advisory nudge (#863 item 2): reverse charge purchases are normally booked
  // on cost accounts (4xxx/5xxx), so flag lines sitting on a class 1 or 6
  // account while omvand skattskyldighet is on. Never blocks submission: class
  // 6 has legitimate reverse charge uses (e.g. 6540 for EU cloud services).
  const rcAccountWarningRows = watchedReverseCharge
    ? findReverseChargeAccountWarningRows(watchedItems ?? [])
    : []

  // Advisory nudge (#1042): a foreign supplier charging no Swedish VAT is
  // normally omvand skattskyldighet. With the switch off no 26x4 leg and no
  // 44xx/45xx basis is booked, so ruta 20-24, 30-32 and 48 stay empty. Silent
  // for Swedish suppliers, where 0 % is a genuine exemption. Never blocks:
  // a non-EU goods purchase cleared at customs is legitimately 0 % without
  // reverse charge, and forcing the switch there would book a wrong verifikat.
  const foreignZeroVatRows = findUnflaggedForeignZeroVatRows(
    watchedItems ?? [],
    watchedReverseCharge,
    suppliers.find((s) => s.id === watchedSupplierId)?.supplier_type,
  )

  // Auto-fill defaults when supplier is selected: but never overwrite a value
  // the AI already filled in for us.
  const [templateAccountNote, setTemplateAccountNote] = useState<{ account: string; counterparty: string } | null>(null)
  // Rows planted by a supplier default or the counterparty-history prefill, so
  // a supplier SWITCH can un-plant them: without this, supplier A's account
  // survives into supplier B's invoice and silently blocks B's own
  // default_expense_account (the fill branches only touch empty rows). Each
  // row carries a plant-time snapshot (dirtyFields is unreliable for appended
  // array rows: they are born all-dirty) plus whether the plant created the
  // row, so un-planting can tell an untouched planted row from one the user
  // has edited.
  const plantedRef = useRef<{
    account: string
    rows: { index: number; appended: boolean; snapshot: SupplierInvoiceLineItem }[]
  } | null>(null)
  // Automatic fill is requested, not applied inline: handleAccountChange
  // needs the loaded BAS chart to apply the konto's default moms, and the
  // requests originate in closures (the supplier effect and its async
  // template fetch) that may hold a stale empty `accounts`. The applying
  // effect below re-runs on both the request tick and the chart load with
  // fresh closures, so whichever arrives last triggers the fill. Filling
  // early would leave a VAT-free konto on the 25% row default, the exact
  // mis-booking the fill exists to prevent.
  const pendingAccountFillRef = useRef<{ account: string; counterparty?: string } | null>(null)
  const [accountFillTick, setAccountFillTick] = useState(0)

  function requestAccountFill(account: string, counterparty?: string) {
    pendingAccountFillRef.current = { account, counterparty }
    setAccountFillTick((t) => t + 1)
  }

  useEffect(() => {
    if (accounts.length === 0 || !pendingAccountFillRef.current) return
    const { account, counterparty } = pendingAccountFillRef.current
    pendingAccountFillRef.current = null
    const items = getValues('items')
    const appliedRows: { index: number; appended: boolean }[] = []
    if (items.length === 0) {
      // Dokument-först model: the table starts with no rows, so a supplier
      // default (or history) account plants the first row instead of filling
      // an empty one. Same side effects as a manual pick (konto default moms,
      // description from the account name).
      appliedRows.push({ index: appendRowForAccount(account), appended: true })
    } else {
      items.forEach((row, i) => {
        if (!row.account_number) {
          // Same path as a manual pick: konto default moms rides along.
          handleAccountChange(i, account)
          appliedRows.push({ index: i, appended: false })
        }
      })
    }
    // Every plant registers in plantedRef: default_expense_account plants must
    // follow the same un-plant rules on a supplier switch as history plants
    // (only the history plant gets the counterparty note).
    if (appliedRows.length > 0) {
      plantedRef.current = {
        account,
        rows: appliedRows.map(({ index, appended }) => ({
          index,
          appended,
          snapshot: snapshotPlantedRow(getValues(`items.${index}`)),
        })),
      }
      if (counterparty) setTemplateAccountNote({ account, counterparty })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, accountFillTick])

  useEffect(() => {
    if (!watchedSupplierId) return
    const supplier = suppliers.find((s) => s.id === watchedSupplierId)
    if (!supplier) return
    setTemplateAccountNote(null)
    pendingAccountFillRef.current = null
    if (plantedRef.current) {
      const { account, rows } = plantedRef.current
      const planted = getValues('items')
      // Rows the plant itself created and the user never touched since
      // (snapshot compare: belopp, beskrivning, moms, periodisering,
      // dimensioner, SLP) are removed outright: in the empty-start table a
      // planted row IS the row, not just an account on one. Any user edit,
      // not just an amount, keeps the row's data and only the stale account
      // is cleared (handleAccountChange reapplies konto defaults on the next
      // fill or manual pick). Rows that existed before the fill are never
      // removed, only un-planted. Descending order keeps the remaining
      // indices valid while removing.
      ;[...rows].sort((a, b) => b.index - a.index).forEach(({ index, appended, snapshot }) => {
        const row = planted[index]
        if (row?.account_number !== account) return
        if (appended && !plantedRowTouched(row, snapshot)) {
          remove(index)
        } else {
          setValue(`items.${index}.account_number`, '')
        }
      })
      plantedRef.current = null
    }

    applySupplierTerms(supplier)

    if (!defaultDimsPickedRef.current) {
      const supplierDims = supplier.default_dimensions ?? {}
      setDefaultDims(supplierDims)
      setDefaultDimsFromSupplier(Object.keys(supplierDims).length > 0)
    }

    if (supplier.default_expense_account) {
      // Fill every row the user hasn't assigned yet (or plant the first row
      // when the table is empty): an empty account is the only signal needed.
      // Routed through the fill request so it waits for the BAS chart and the
      // konto's default moms comes along exactly like a manual pick.
      requestAccountFill(supplier.default_expense_account)
    }
    if (supplier.default_currency && watch('currency') === 'SEK') {
      setValue('currency', supplier.default_currency)
    }
    // A foreign supplier's service is omvänd betalningsskyldighet, from the EU or outside it.
    if (isForeignSupplierType(supplier.supplier_type)) {
      setValue('reverse_charge', true)
    }
    // Goods or services is never carried over from the previous supplier: it
    // starts unanswered, and an EU supplier's own latest answer fills it (a
    // supplier usually sells one or the other). Without one it stays empty
    // and registration asks: a silent "services" booked EU goods in ruta 21
    // (crm#1323). Best-effort: on any miss the question stays open.
    setValue('reverse_charge_kind', '')
    let cancelled = false
    if (supplier.supplier_type === 'eu_business') {
      ;(async () => {
        try {
          const res = await fetch(`/api/supplier-invoices?supplier_id=${encodeURIComponent(supplier.id)}`)
          if (!res.ok) return
          const json = await res.json()
          if (cancelled || getValues('reverse_charge_kind')) return
          const kind = rememberedReverseChargeKind(Array.isArray(json?.data) ? json.data : [])
          if (kind) setValue('reverse_charge_kind', kind)
        } catch {
          // Prefill is best-effort; the question stays open.
        }
      })()
    }

    // No supplier default: fall back to the company's own booking history for
    // this counterparty (the same tiered matcher the booking flows use). Fills
    // empty rows only, never a generic seed, and only from expense-shaped
    // templates (P&L cost on debit, settlement on credit; the 4-8 gate keeps
    // private/balance-sheet templates like 2013 or 1630 out). Best-effort: on
    // any miss the rows simply stay blank, exactly as before.
    if (!supplier.default_expense_account && supplier.name?.trim()) {
      ;(async () => {
        try {
          const res = await fetch(
            `/api/settings/counterparty-templates?counterparty=${encodeURIComponent(supplier.name.trim())}`
          )
          if (!res.ok) return
          const json = await res.json()
          if (cancelled) return
          const match = json?.data
          const debit: string | undefined = match?.template?.debit_account
          const credit: string | undefined = match?.template?.credit_account
          if (!match || (match.confidence ?? 0) < 0.5) return
          // Settled on a bank or on a company card's liability account.
          if (!debit || !/^[4-8]/.test(debit) || !credit || !(credit.startsWith('19') || isCardLedgerAccount(credit))) return
          requestAccountFill(debit, match.template.counterparty_name)
        } catch {
          // Prefill is best-effort; the rows stay blank.
        }
      })()
    }
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSupplierId, suppliers])

  // Terms-based förfallodatum (change 4). Auto-set from the supplier's
  // default_payment_terms with an honest caption; stops updating the moment
  // the user (or the AI extraction) supplies an explicit date.
  function applySupplierTerms(supplier: Supplier) {
    if (dueDateManualRef.current) return
    const invoiceDate = watch('invoice_date')
    const currentDue = watch('due_date')
    // Never overwrite a due date we did not auto-set ourselves (the AI
    // prefill flips the manual flag, but keep the value guard as defense
    // in depth).
    if (currentDue && currentDue !== lastAutoDueRef.current) return
    const days = supplier.default_payment_terms
    if (days && days > 0) {
      // Pure calendar-date arithmetic: parsing as UTC, shifting with local
      // setDate and reading back as UTC lost a day across the March DST
      // change (accounted#58).
      if (isIsoDateShaped(invoiceDate)) {
        const due = invoiceDueDate(invoiceDate, days)
        setValue('due_date', due)
        lastAutoDueRef.current = due
      }
      setDueDateCaption({ type: 'terms', days })
    } else {
      // default_payment_terms is non-null in the DB (default 30), so 30 IS
      // terms; only an explicit 0 means the supplier has none and the due
      // date stands on the invoice.
      if (currentDue) setValue('due_date', '')
      lastAutoDueRef.current = null
      setDueDateCaption({ type: 'on_invoice' })
    }
  }

  // Re-derive an auto-set due date when the invoice date changes: manual or
  // AI-set dates are left alone via the same guards as applySupplierTerms.
  useEffect(() => {
    if (!watchedSupplierId || dueDateManualRef.current) return
    const supplier = suppliers.find((s) => s.id === watchedSupplierId)
    if (!supplier) return
    const currentDue = getValues('due_date')
    if (currentDue && currentDue !== lastAutoDueRef.current) return
    const days = supplier.default_payment_terms
    if (days && days > 0 && isIsoDateShaped(watchedInvoiceDate)) {
      const due = invoiceDueDate(watchedInvoiceDate, days)
      setValue('due_date', due)
      lastAutoDueRef.current = due
      setDueDateCaption({ type: 'terms', days })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedInvoiceDate])

  // Pre-submit duplicate advisory: the number (the create route's structured
  // 409 stays the enforcement point) and the payment reference, which no
  // door refuses.
  const { found: duplicates, check: checkDuplicates } = useSupplierInvoiceDuplicates({
    supplier_id: watchedSupplierId,
    supplier_invoice_number: watchedInvoiceNumber,
    payment_reference: watchedPaymentReference,
    payer: watchedPayer,
  })
  // On one other invoice of the supplier only: acknowledged in the review dialog.
  const reuseToAcknowledge = duplicates?.reference?.needs_acknowledgement ? duplicates.reference : null

  // Auto-fetch Riksbanken exchange rate when currency switches to non-SEK and
  // the user hasn't typed a custom rate yet. Re-fetches when the invoice
  // date changes too. Never overwrites a user-entered rate. Reuses the
  // watchedInvoiceDate declared above for the AI-filled-indicator flag.
  // The "user has manually edited the rate" flag is scoped *per currency*.
  // Switching from EUR (rate 11.8 edited by hand) to USD must re-fetch: the
  // EUR rate is meaningless for a USD invoice. Tracking last-fetched currency
  // lets us reset the touched flag on a currency switch while still honoring
  // a manual edit when only the invoice date changes within the same currency.
  const userTouchedRateRef = useRef(false)
  const lastFxCurrencyRef = useRef<string | null>(null)
  useEffect(() => {
    if (watchedCurrency === 'SEK') {
      setValue('exchange_rate', '')
      userTouchedRateRef.current = false
      lastFxCurrencyRef.current = null
      return
    }
    if (lastFxCurrencyRef.current !== watchedCurrency) {
      // Currency switched: drop the previous currency's manual-edit flag.
      userTouchedRateRef.current = false
      lastFxCurrencyRef.current = watchedCurrency
    }
    if (userTouchedRateRef.current) return
    let cancelled = false
    ;(async () => {
      try {
        const url = `/api/currency/rate?currency=${watchedCurrency}${
          watchedInvoiceDate ? `&date=${watchedInvoiceDate}` : ''
        }`
        const res = await fetch(url)
        if (!res.ok) return
        const { data } = await res.json()
        if (cancelled || !data?.rate) return
        // Don't clobber a value the user typed while we were fetching.
        if (userTouchedRateRef.current) return
        setValue('exchange_rate', String(Math.round(data.rate * 10000) / 10000))
      } catch {
        // Non-critical: user can type the rate manually.
      }
    })()
    return () => { cancelled = true }
  }, [watchedCurrency, watchedInvoiceDate, setValue])

  // Auto-select newly created supplier once it shows up in the list
  useEffect(() => {
    if (pendingSupplierSelect && suppliers.find((s) => s.id === pendingSupplierSelect)) {
      setValue('supplier_id', pendingSupplierSelect, { shouldDirty: true, shouldValidate: true })
      setPendingSupplierSelect(null)
    }
  }, [suppliers, pendingSupplierSelect, setValue])

  function handleAccountChange(index: number, accountNumber: string) {
    setValue(`items.${index}.account_number`, accountNumber)
    const currentDesc = watch(`items.${index}.description`)
    const accountName = accountNameForRow(accountNumber, accounts)
    if (!currentDesc && accountName) setValue(`items.${index}.description`, accountName)
    // Auto-fill the rad's moms from the konto's configured default (e.g.
    // öresavrundning 3740 = ingen moms), so a rounding line stops inheriting
    // the 25 % rad-default. Only when the konto carries an explicit default;
    // otherwise the user's current rate stands. Reverse charge uses its own
    // rate field, so leave that flow untouched. PostgREST serialises numeric
    // columns as strings, so coerce: strict === comparisons on vat_rate
    // (inferVatTreatment) expect a number.
    const acct = accounts.find((a) => a.account_number === accountNumber)
    const defaultRate = acct?.default_vat_rate == null ? null : Number(acct.default_vat_rate)
    if (vatRegistered && !watchedReverseCharge && defaultRate != null && Number.isFinite(defaultRate)) {
      setValue(`items.${index}.vat_rate`, defaultRate, { shouldDirty: true })
    }
    // Särskild löneskatt only applies to 741x pension premiums: leaving the
    // range clears the flag so a stale opt-in can never reach the API.
    if (watch(`items.${index}.apply_slp`) && !isSlpPensionAccount(accountNumber)) {
      setValue(`items.${index}.apply_slp`, undefined, { shouldDirty: true })
    }
  }

  // Append a new kontering row for a committed account: the same side effects
  // as a manual pick on an existing row (description from the account name,
  // konto default moms), used by the ghost entry row and the supplier-default
  // plant. Returns the new row's index.
  function appendRowForAccount(accountNumber: string): number {
    const acct = accounts.find((a) => a.account_number === accountNumber)
    const defaultRate = acct?.default_vat_rate == null ? null : Number(acct.default_vat_rate)
    const vatRate = !vatRegistered
      ? 0
      : !watchedReverseCharge && defaultRate != null && Number.isFinite(defaultRate)
        ? defaultRate
        : 0.25
    const description = accountNameForRow(accountNumber, accounts)
    const index = getValues('items').length
    // Total-first: the first row is born with the net the invoice totals
    // give, so the amount cell that takes focus already shows it.
    const net = index === 0 ? totalFirstNetAt(vatRate) : null
    if (net != null) totalFillRef.current = net
    // A first row typed by hand is no reading's row.
    if (index === 0) readingRowsRef.current = false
    append({
      description,
      amount: net ?? 0,
      account_number: accountNumber,
      vat_rate: vatRate,
      // Under reverse charge the row self-assesses at its default sats; a
      // row added without it gets one when reverse charge is switched on.
      ...(watchedReverseCharge ? { reverse_charge_rate: reverseChargeRateDefault(vatRate) } : {}),
    })
    return index
  }

  // Ghost entry row commit: append the row, clear the entry input (remount)
  // and move focus to the new row's amount cell.
  function commitEntryAccount(accountNumber: string) {
    if (!accountNumber) return
    const index = appendRowForAccount(accountNumber)
    setEntryResetKey((k) => k + 1)
    // Focus hand-off via effect, not requestAnimationFrame: the entry input
    // remounts on commit while focused, and the dialog's focus scope
    // re-parks focus before any frame callback can win. The effect below
    // runs after the new row's input is mounted, deterministically.
    setPendingAmountFocus(index)
  }

  useEffect(() => {
    if (pendingAmountFocus === null) return
    const el = amountInputRefs.current[pendingAmountFocus]
    if (!el) return
    el.focus()
    el.select()
    setPendingAmountFocus(null)
  }, [pendingAmountFocus, fields.length])

  // Periodisering per rad: kräver faktureringsmetoden; eget utlägg bokar
  // kostnaden direkt mot ägarkontot och kan inte periodiseras. Omvänd
  // skattskyldighet kan inte heller periodiseras: kostnadsraden utgör
  // momsunderlaget (ruta 20-32) och får inte flyttas till ett interimskonto.
  const canUseAccrual =
    accountingMethod === 'accrual' && !watchedPaidPrivately && !watchedReverseCharge

  // When reverse charge is switched on, clear any per-line periodisering so a
  // stale AI prefill (or fields set before the toggle) can never reach the
  // API, which rejects the combination with SI_CREATE_ACCRUAL_REVERSE_CHARGE.
  useEffect(() => {
    if (!watchedReverseCharge) return
    const items = getValues('items') ?? []
    items.forEach((item, index) => {
      if (
        item.accrual_period_start !== undefined ||
        item.accrual_period_end !== undefined ||
        item.accrual_balance_account !== undefined
      ) {
        setValue(`items.${index}.accrual_period_start`, undefined, { shouldDirty: true })
        setValue(`items.${index}.accrual_period_end`, undefined, { shouldDirty: true })
        setValue(`items.${index}.accrual_balance_account`, undefined, { shouldDirty: true })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedReverseCharge])

  // When reverse charge is switched on, every row on screen without a
  // reverse-charge sats of its own gets its default (reverseChargeRateOf): a
  // sats chosen under reverse charge earlier stands. Rows added or read in
  // under reverse charge already carry it, so a row self-assesses at the same
  // sats whichever came first.
  useEffect(() => {
    if (!watchedReverseCharge) return
    const items = getValues('items') ?? []
    items.forEach((item, index) => {
      const rate = reverseChargeRateOf(item)
      if (item.reverse_charge_rate !== rate) setValue(`items.${index}.reverse_charge_rate`, rate)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedReverseCharge])

  // Force every line to 0 % moms for icke momsregistrerade companies: the
  // default line, AI prefills and konto defaults all assume 25 % otherwise.
  // Re-runs after EVERY applied extraction (prefillApplyCount bumps per
  // apply), not just the first: a remove + re-upload applies a fresh
  // extraction whose 25 % rates would otherwise reach the convert endpoint
  // silently, with the moms columns hidden.
  //
  // The amount is grossed up in the same pass: an amount paired with a
  // non-zero rate is a NET amount (AI line totals are exkl moms, and the
  // visible column said "Belopp (exkl.)" while the rate stood). For a company
  // with no deduction right the moms is part of the cost, so net at 25 %
  // becomes gross at 0 %; zeroing the rate alone would understate both the
  // expense and 2440 by exactly the moms.
  useEffect(() => {
    if (vatRegistered) return
    const items = getValues('items') ?? []
    items.forEach((item, index) => {
      if (item.vat_rate !== 0) {
        if (item.amount) {
          setValue(`items.${index}.amount`, roundOre(item.amount + netVat(item.amount, item.vat_rate)))
        }
        setValue(`items.${index}.vat_rate`, 0)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatRegistered, prefillApplyCount])

  function isAccrualOpen(index: number): boolean {
    return watchedItems?.[index]?.accrual_balance_account != null
  }

  function toggleAccrual(index: number) {
    if (isAccrualOpen(index)) {
      setValue(`items.${index}.accrual_period_start`, undefined, { shouldDirty: true })
      setValue(`items.${index}.accrual_period_end`, undefined, { shouldDirty: true })
      setValue(`items.${index}.accrual_balance_account`, undefined, { shouldDirty: true })
    } else {
      const account = watch(`items.${index}.account_number`) || ''
      setValue(`items.${index}.accrual_period_start`, watch('invoice_date') || '', { shouldDirty: true })
      setValue(`items.${index}.accrual_period_end`, '', { shouldDirty: true })
      setValue(
        `items.${index}.accrual_balance_account`,
        suggestBalanceAccount('expense', account),
        { shouldDirty: true },
      )
      // Periodisering + särskild löneskatt on the same row is rejected by the
      // API (SI_CREATE_SLP_ACCRUAL): opening the accrual panel wins and the
      // SLP opt-in is cleared (its confirmation row disappears with it).
      if (watch(`items.${index}.apply_slp`)) {
        setValue(`items.${index}.apply_slp`, undefined, { shouldDirty: true })
      }
    }
  }

  // --- Särskild löneskatt på pensionskostnader (SLP, 24,26 %) ---
  // A 741x pension-premium row gets an advisory hint (add the 7533/2514
  // pair) or, once opted in, a quiet confirmation line. The pair nets to
  // zero, so the totals box below is untouched: the invoice total IS the
  // payable. Hidden while the row's periodisering panel is open (the API
  // rejects the combination).
  function slpRowVisible(index: number): boolean {
    const item = watchedItems?.[index]
    if (!item) return false
    if (!isSlpPensionAccount(item.account_number || '')) return false
    if (canUseAccrual && isAccrualOpen(index)) return false
    return true
  }

  function setSlp(index: number, value: boolean) {
    setValue(`items.${index}.apply_slp`, value ? true : undefined, { shouldDirty: true })
  }

  function renderSlpPanel(index: number) {
    const item = watchedItems?.[index]
    if (!item) return null
    const slpAmount = roundOre((item.amount || 0) * SLP_RATE)
    if (item.apply_slp) {
      return (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('slp_applied_line', { amount: formatAmount(slpAmount) })}
          </p>
          <Button type="button" variant="ghost" onClick={() => setSlp(index, false)}>
            {t('slp_remove_action')}
          </Button>
        </div>
      )
    }
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg p-3 bg-control shadow-raised"
      >
        <ExclamationTriangleIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <p className="flex-1 text-sm">
          {t('slp_hint', { amount: formatAmount(slpAmount) })}
        </p>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => setSlp(index, true)}
        >
          {t('slp_add_action')}
        </Button>
      </div>
    )
  }

  // --- Begränsat momsavdrag (personbil, representation; crm#1617) ---
  // The row keeps the invoice's net and moms sats; the panel says how much of
  // that moms is deducted. The rest is booked on the row's cost account
  // (bookLimitedDeduction), so the payable stays the invoice total.
  function limitedDeductionAvailable(index: number): boolean {
    const item = watchedItems?.[index]
    if (!item || !vatRegistered) return false
    if (!limitedDeductionApplies({ reverse_charge: watchedReverseCharge, is_self_billed: watchedSelfBilled })) return false
    return invoicedRowVat(item) > 0
  }

  function isLimitedDeductionOpen(index: number): boolean {
    return limitedDeductionAvailable(index) && watchedItems?.[index]?.vat_deduction_share != null
  }

  function toggleLimitedDeduction(index: number) {
    const item = watchedItems?.[index]
    if (!item) return
    // Opens at half the row's moms, the personbil rule; the person adjusts it.
    const next = item.vat_deduction_share != null ? undefined : 0.5
    setValue(`items.${index}.vat_deduction_share`, next, { shouldDirty: true })
  }

  function renderLimitedDeductionPanel(index: number) {
    const item = watchedItems?.[index]
    if (!item) return null
    const invoiced = invoicedRowVat(item)
    return (
      <div className="rounded-lg p-3 space-y-2 bg-control shadow-raised">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor={`deductible-vat-${index}`} className="text-sm font-normal">
            {t('deductible_vat_label')}
          </Label>
          {/* Shown and typed in kronor, kept as a share of the row's moms
              so a corrected amount or moms sats keeps it in proportion. */}
          <Controller
            name={`items.${index}.vat_deduction_share`}
            control={control}
            render={({ field }) => (
              <AmountCell
                value={deductibleRowVat(item, field.value ?? 1)}
                onChange={(kronor) => field.onChange(invoiced > 0 ? kronor / invoiced : 0)}
                id={`deductible-vat-${index}`}
                className="h-8 w-28 text-right tabular-nums"
              />
            )}
          />
          <span className="text-muted-foreground tabular-nums">
            {t('deductible_vat_of', {
              vat: formatAmount(invoiced),
              cost: formatAmount(nonDeductibleVat[index] ?? 0),
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto"
            onClick={() => toggleLimitedDeduction(index)}
          >
            {t('deductible_vat_remove')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('deductible_vat_hint')}</p>
      </div>
    )
  }

  // --- Dimension tagging (kostnadsställe/projekt, dimensions PR7) ---
  // Mirrors the accrual pattern: a defined (possibly empty) bag on the item
  // means the row's panel is open; closing clears the bag entirely so the
  // payload never carries a stale override.
  function setDefaultDimension(dimNo: string, code: string | null) {
    defaultDimsPickedRef.current = true
    setDefaultDimsFromSupplier(false)
    setDefaultDims((prev) => {
      const next = { ...prev }
      const trimmed = code?.trim()
      if (trimmed) next[dimNo] = trimmed
      else delete next[dimNo]
      return next
    })
  }

  function isDimOpen(index: number): boolean {
    return watchedItems?.[index]?.dimensions != null
  }

  function toggleDimensions(index: number) {
    if (isDimOpen(index)) {
      setValue(`items.${index}.dimensions`, undefined, { shouldDirty: true })
    } else {
      setValue(`items.${index}.dimensions`, {}, { shouldDirty: true })
    }
  }

  function updateItemDimension(index: number, dimNo: string, code: string | null) {
    const current = { ...(getValues(`items.${index}.dimensions`) ?? {}) }
    const trimmed = code?.trim()
    if (trimmed) current[dimNo] = trimmed
    else delete current[dimNo]
    setValue(`items.${index}.dimensions`, current, { shouldDirty: true })
  }

  // Compact display of the invoice default, e.g. "KS01 · P001" (dim-number order).
  const defaultDimsSummary = Object.entries(defaultDims)
    .filter(([, v]) => v)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, v]) => v)
    .join(' · ')

  function renderDimensionsPanel(index: number) {
    const item = watchedItems?.[index]
    if (!item || item.dimensions == null) return null
    return (
      <div className="rounded-lg p-3 space-y-1 bg-control shadow-raised">
        <div className="max-w-md">
          <LineDimensionFields
            dimensions={item.dimensions}
            onChange={(dimNo, code) => updateItemDimension(index, dimNo, code)}
            inputClassName="h-8"
          />
        </div>
        {defaultDimsSummary && (
          <p className="text-xs text-muted-foreground">
            {t('row_dimensions_inherit_hint', { dims: defaultDimsSummary })}
          </p>
        )}
      </div>
    )
  }

  function renderAccrualPanel(index: number, idPrefix: string) {
    const item = watchedItems?.[index]
    if (!item || item.accrual_balance_account == null) return null
    const accrualValue = {
      start: item.accrual_period_start ?? '',
      end: item.accrual_period_end ?? '',
      balanceAccount: item.accrual_balance_account || DEFAULT_PREPAID_EXPENSE_ACCOUNT,
    }
    return (
      <AccrualPeriodControl
        direction="expense"
        // Entity type picks the regelverk the 5 000 kr hint cites: K1 for
        // enskild firma, K2 for aktiebolag.
        entityType={entityType}
        amount={item.amount || 0}
        // Line amounts are in the invoice's currency; the K2 5 000 kr limit is
        // in SEK. The rate is the Riksbanken/manual one already on the form.
        // An empty field parses to NaN, which the control reads as "unknown"
        // and then hides the hint instead of comparing the wrong unit.
        currency={watchedCurrency}
        exchangeRate={parseFloat(watchedExchangeRate)}
        invoiceDate={watchedInvoiceDate}
        // K2's limit follows the fiscal year: 7 000 kr from a year starting 2026.
        fiscalYearStart={fiscalYearStartOf(watchedInvoiceDate)}
        fiscalYearEnd={fiscalYearOf(watchedInvoiceDate)?.period_end ?? null}
        idPrefix={idPrefix}
        value={accrualValue}
        targetAccount={item.account_number}
        onChange={(next) => {
          setValue(`items.${index}.accrual_period_start`, next.start, { shouldDirty: true })
          setValue(`items.${index}.accrual_period_end`, next.end, { shouldDirty: true })
          setValue(`items.${index}.accrual_balance_account`, next.balanceAccount, { shouldDirty: true })
        }}
        onRemove={() => toggleAccrual(index)}
      />
    )
  }

  // Reverse charge keeps its rate controls even for icke momsregistrerade
  // (self-assessment is a separate obligation from deduction); everything
  // else moms-related disappears when the company isn't VAT-registered.
  const vatColsVisible = vatRegistered || watchedReverseCharge

  // Öresavrundning follows the invoice until the person flips the switch:
  // a Fakturabelopp that is the rows' exact total rounded to whole kronor
  // turns it on, so the 3740 line books the difference with its sign.
  // The Moms field is the invoice's own VAT: on a single-rate invoice it is
  // what the registration books when the lines take it (crm#1367).
  // Begränsat momsavdrag: the amounts are those the registration books (the
  // non-deductible moms on the cost row); the figures shown add it back so
  // they read as the invoice does.
  const { items: bookedItems, nonDeductibleVat } = bookLimitedDeduction(
    watchedItems || [],
    limitedDeductionApplies({ reverse_charge: watchedReverseCharge, is_self_billed: watchedSelfBilled }),
  )
  const {
    statedVat,
    oreRounding,
    amounts: { itemTotals, subtotal: bookedSubtotal, totalVat: deductibleVat, figures },
  } = rowsAgainstInvoiceTotals({
    items: bookedItems,
    currency: watchedCurrency || 'SEK',
    reverseCharge: watchedReverseCharge,
    invoiceTotal: enteredFakturaTotal,
    invoiceVat: enteredFakturaVat,
    oreRoundingChoice,
  })
  const totalNonDeductibleVat = roundOre(nonDeductibleVat.reduce((sum, vat) => sum + vat, 0))
  const subtotal = roundOre(bookedSubtotal - totalNonDeductibleVat)
  const totalVat = roundOre(deductibleVat + totalNonDeductibleVat)

  // Total-first fill: a single row whose amount is still empty, or still the
  // one this fill put there, takes its net from Fakturabelopp and Moms (and
  // follows a later change of either, or of the row's moms sats). With
  // several rows the fields only cross-check.
  const singleRow = watchedItems?.length === 1 ? watchedItems[0] : null
  const singleRowAmount = singleRow ? singleRow.amount || 0 : null
  const singleRowNet = singleRow ? totalFirstNetAt(singleRow.vat_rate || 0) : null
  useEffect(() => {
    if (singleRowAmount == null) return
    const net = totalFirstFill({
      amount: singleRowAmount,
      net: singleRowNet,
      filled: totalFillRef.current,
      fromReading: readingRowsRef.current,
      reverseCharge: watchedReverseCharge,
    })
    if (net == null) return
    totalFillRef.current = net
    setValue('items.0.amount', net, { shouldDirty: true })
  }, [singleRowAmount, singleRowNet, watchedReverseCharge, setValue])

  // Cross-check: client-only compare against the displayed payable and the
  // rows' moms; a mismatch renders field-adjacent, never blocks, never travels.
  const {
    totalDiff: crosscheckDiff,
    totalMatches: crosscheckMatches,
    vatDiff: vatCrosscheckDiff,
    vatMatches: vatCrosscheckMatches,
  } = invoiceTotalsCrosscheck({
    invoiceTotal: enteredFakturaTotal,
    invoiceVat: enteredFakturaVat,
    toPay: figures.toPay,
    totalVat,
  })
  const signedAmount = (amount: number) =>
    (amount > 0 ? '+' : '') + formatCurrency(amount, watchedCurrency)

  // Show the AI-suggested supplier card when we have an extraction, the AI
  // surfaced a supplier name, and we couldn't match it to an existing record.
  const showAISupplierHint =
    !!extractedData?.supplier?.name &&
    !hasMatchedSupplier &&
    !watchedSupplierId

  function openSupplierDialogPrefilled() {
    // Where the seller is, read as the Inkorg's one click reads it: Sweden unless the document names elsewhere.
    const seller = sellerCountry(extractedData?.supplier)
    setNewSupplier({
      name: extractedData?.supplier?.name || '',
      supplier_type: seller.region ? supplierTypeForRegion(seller.region) : 'swedish_business',
      country: seller.country ?? '',
      org_number: extractedData?.supplier?.orgNumber || '',
      vat_number: extractedData?.supplier?.vatNumber || '',
      address_line1: extractedData?.supplier?.address || '',
      bankgiro: extractedData?.supplier?.bankgiro || '',
      plusgiro: extractedData?.supplier?.plusgiro || '',
      iban: extractedData?.supplier?.iban || '',
      bic: extractedData?.supplier?.bic || '',
      default_expense_account: '',
    })
    setShowNewSupplier(true)
  }

  /** "Skapa leverantör" from the supplier picker, with what was typed as the name. */
  function openSupplierDialogNamed(name: string) {
    setNewSupplier({ ...EMPTY_NEW_SUPPLIER, name })
    setShowNewSupplier(true)
  }

  async function handleCreateSupplier() {
    if (!newSupplier.name.trim()) {
      toast({ title: t('name_missing_title'), description: t('name_missing_description'), variant: 'destructive' })
      return
    }
    setIsCreatingSupplier(true)

    const payload: Record<string, unknown> = {
      name: newSupplier.name,
      supplier_type: newSupplier.supplier_type,
    }
    if (newSupplier.org_number) payload.org_number = newSupplier.org_number
    if (newSupplier.vat_number) payload.vat_number = newSupplier.vat_number
    if (newSupplier.address_line1) payload.address_line1 = newSupplier.address_line1
    if (newSupplier.bankgiro) payload.bankgiro = newSupplier.bankgiro
    if (newSupplier.plusgiro) payload.plusgiro = newSupplier.plusgiro
    if (newSupplier.iban) payload.iban = newSupplier.iban
    if (newSupplier.bic) payload.bic = newSupplier.bic
    if (newSupplier.default_expense_account) payload.default_expense_account = newSupplier.default_expense_account
    // The country the reading named, while the type still agrees with it.
    if (newSupplier.country && supplierTypeForRegion(regionOfCountry(newSupplier.country)) === newSupplier.supplier_type) {
      payload.country = newSupplier.country
    }

    const res = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await res.json()

    if (!res.ok) {
      toast({ title: t('create_supplier_failed_title'), description: getErrorMessage(result, { context: 'supplier' }), variant: 'destructive' })
    } else {
      const created = result.data as Supplier
      // The shared supplier list feeds every picker: refresh it (awaited, so
      // the pending selection below finds the new row).
      await refreshSuppliers()
      setPendingSupplierSelect(created.id)
      setHasMatchedSupplier(true)
      setShowNewSupplier(false)
      setNewSupplier(EMPTY_NEW_SUPPLIER)
      toast({ title: t('supplier_created_title'), description: created.name })
    }

    setIsCreatingSupplier(false)
  }

  // --- Dokument-först upload (change 1) ---
  // The standalone form's upload tries the invoice-inbox pipeline (upload +
  // AI tolkning) over plain HTTP first: core never imports the extension, so
  // a disabled extension just 404s and the upload degrades to the plain
  // /api/documents path with no extraction. Manual entry is never blocked.

  // Standalone-path guard: an extraction can land up to 90 s after upload,
  // and applyInboxItem overwrites scalars and replaces ALL rows. Auto-apply
  // only while the form is still pristine; once the user has typed, buffer
  // the result and offer a quiet click-to-apply line instead of silently
  // wiping their input. The inbox-arrival path (?inbox_item_id) never routes
  // through here: there the prefill IS the entry state.
  function applyExtractionIfPristine(item: InboxItemData) {
    if (isDirtyRef.current) {
      setPendingExtraction(item)
      setExtractionPhase('done')
      return
    }
    applyInboxItem(item)
    setExtractionPhase('done')
  }

  function applyPendingExtraction() {
    const item = pendingExtraction
    if (!item) return
    setPendingExtraction(null)
    applyInboxItem(item)
    setExtractionPhase('done')
  }

  // A finished reading: fill the form, or say it could not be read and offer
  // another try instead of going quiet (the provider may have been down). A
  // document that was never sent for reading (extraction_skipped: no AI,
  // unsupported file) stays quiet: another try would read nothing either.
  function settleReading(
    itemId: string,
    documentId: string,
    data: { extracted_data?: InvoiceExtractionResult | null; matched_supplier_id?: string | null; extraction_skipped?: boolean } | null,
  ) {
    if (hasExtractionContent(data?.extracted_data)) {
      applyExtractionIfPristine({
        id: itemId,
        extracted_data: data?.extracted_data ?? null,
        matched_supplier_id: data?.matched_supplier_id ?? null,
        document_id: documentId,
      })
      return
    }
    setExtractionPhase(data?.extraction_skipped ? 'idle' : 'failed')
  }

  // "Läs igen" on the uploaded underlag: the inbox's own retry-extraction,
  // then the item as it now stands.
  async function retryUnderlagReading() {
    const itemId = uploadedInboxItemId
    const documentId = documentFiles[0]?.id
    if (!itemId || !documentId) return
    const token = ++extractionPollTokenRef.current
    setExtractionPhase('processing')
    try {
      const retry = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/retry-extraction`, { method: 'POST' })
      if (retry.ok) {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`)
        const json = res.ok ? await res.json().catch(() => null) : null
        if (extractionPollTokenRef.current !== token) return
        if (json?.data) {
          settleReading(itemId, documentId, json.data)
          return
        }
      }
    } catch {
      // Falls through to the failed state: the user can try again or type.
    }
    if (extractionPollTokenRef.current === token) setExtractionPhase('failed')
  }

  async function pollExtraction(itemId: string, documentId: string) {
    const token = ++extractionPollTokenRef.current
    const startedAt = Date.now()
    // A reading may run to its 250 s deadline: one still running when the
    // poll gives up is said as such, with a way to look again, not dropped.
    let stillReading = true
    while (Date.now() - startedAt < 90_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (extractionPollTokenRef.current !== token) return
      try {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`)
        if (!res.ok) {
          stillReading = false
          break
        }
        const { data } = await res.json()
        if (extractionPollTokenRef.current !== token) return
        if (data?.status !== 'processing') {
          settleReading(itemId, documentId, data)
          return
        }
      } catch {
        stillReading = false
        break
      }
    }
    if (extractionPollTokenRef.current === token) setExtractionPhase(stillReading ? 'slow' : 'idle')
  }

  // "Kolla igen" after a slow reading: the same poll, for the same item.
  function checkReadingAgain() {
    const itemId = uploadedInboxItemId
    const documentId = documentFiles[0]?.id
    if (!itemId || !documentId) return
    setExtractionPhase('processing')
    void pollExtraction(itemId, documentId)
  }

  async function uploadPlainDocument(entry: UploadedFile) {
    try {
      const res = await postDocumentForm(
        PLAIN_DOCUMENT_UPLOAD_URL,
        plainDocumentUploadForm(),
        entry.file,
      )
      const id = res.ok ? documentIdFromPlainUpload(await res.json().catch(() => null)) : null
      if (!id) {
        setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_upload_failed') }])
        return
      }
      setDocumentFiles([{ ...entry, status: 'uploaded', id }])
    } catch {
      setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_upload_failed') }])
    }
  }

  async function handleUnderlagFile(file: File) {
    const uploadKey = `underlag-${Date.now()}`
    const entry: UploadedFile = {
      file,
      status: 'uploading',
      fileName: file.name,
      fileSize: file.size,
      uploadKey,
    }
    if (!isAllowedInboxFile(file)) {
      setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_unsupported_type') }])
      return
    }
    if (file.size > UNDERLAG_MAX_SIZE) {
      setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_too_large') }])
      return
    }
    setDocumentFiles([entry])
    setExtractionPhase('idle')
    setPendingExtraction(null)

    // Without the AI capability the document inbox refuses the upload, so
    // the file goes straight to the plain upload (which also carries a file
    // over the hosted body limit) instead of there after a refused request.
    if (underlagRoute === 'documents') {
      await uploadPlainDocument(entry)
      return
    }

    // Above the hosted request-body limit the platform refuses a multipart
    // body before the route runs (a plain 413, nothing in the logs), so the
    // bytes go straight to Storage through a signed URL instead. Same
    // response shape either way.
    const directToStorage = exceedsHostedUploadLimit(file.size)
    try {
      let res: Response
      if (directToStorage) {
        res = await uploadViaSignedUrl(file)
      } else {
        const formData = new FormData()
        formData.append('file', file)
        res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
          method: 'POST',
          body: formData,
        })
      }
      if (res.ok) {
        const json = await res.json().catch(() => null)
        const data = json?.data as
          | {
              document_id?: string
              inbox_item_id?: string
              status?: string
              extracted_data?: InvoiceExtractionResult | null
              matched_supplier_id?: string | null
            }
          | undefined
        if (data?.document_id && data.inbox_item_id) {
          setDocumentFiles([{ ...entry, status: 'uploaded', id: data.document_id }])
          setUploadedInboxItemId(data.inbox_item_id)
          if (data.status === 'processing') {
            setExtractionPhase('processing')
            void pollExtraction(data.inbox_item_id, data.document_id)
          } else if (hasExtractionContent(data.extracted_data)) {
            applyExtractionIfPristine({
              id: data.inbox_item_id,
              extracted_data: data.extracted_data ?? null,
              matched_supplier_id: data.matched_supplier_id ?? null,
              document_id: data.document_id,
            })
          }
          return
        }
      }
    } catch {
      // Extension unreachable: fall through to the plain upload below.
    }
    if (directToStorage) {
      // The plain fallback posts a multipart body to /api/documents, which
      // the platform would refuse the same way: nothing left to try.
      setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_upload_failed') }])
      return
    }
    await uploadPlainDocument(entry)
  }

  function handleRemoveUnderlag() {
    extractionPollTokenRef.current += 1
    const itemId = uploadedInboxItemId
    const docIds = documentFiles
      .filter((file) => file.status === 'uploaded' && file.id)
      .map((file) => file.id as string)
    setDocumentFiles([])
    setUploadedInboxItemId(null)
    setExtractionPhase('idle')
    setPendingExtraction(null)
    void (async () => {
      // Delete the inbox item first (it references the document), then the
      // document. Both best-effort: the same orphan-cleanup contract as before.
      if (itemId) {
        try {
          await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`, { method: 'DELETE' })
        } catch {
          // Best-effort cleanup.
        }
      }
      await Promise.allSettled(
        docIds.map((documentId) => fetch(`/api/documents/${documentId}`, { method: 'DELETE' })),
      )
    })()
  }

  function buildPayload(data: FormData) {
    return buildSupplierInvoicePayload(data, {
      inboxItemId: effectiveInboxItemId,
      uploadedDocumentId,
      oreRounding,
      defaultDims,
      canUseAccrual,
      euSupplier,
      statedVat,
    })
  }

  // An upload that went through the inbox pipeline submits through the same
  // convert endpoint as an inbox arrival: document linking and the item's
  // created_supplier_invoice_id stamp come for free, and the inbox never
  // shows an already-registered document as pending.
  const effectiveInboxItemId = inboxItemId ?? uploadedInboxItemId

  function focusMissingField(
    field: 'supplier' | 'invoice_number' | 'rows' | 'row_account' | 'reverse_charge_kind',
    rowIndex?: number,
  ) {
    if (field === 'reverse_charge_kind') {
      reverseChargeKindRef.current?.focus()
    } else if (field === 'supplier') {
      // Focusing the supplier combobox opens its list.
      supplierInputRef.current?.focus()
    } else if (field === 'invoice_number') {
      invoiceNumberInputRef.current?.focus()
    } else if (field === 'rows') {
      entryInputRef.current?.focus()
    } else if (field === 'row_account' && rowIndex != null) {
      accountInputRefs.current[rowIndex]?.focus()
    }
  }

  const {
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
  } = useSupplierInvoiceSubmit({
    t,
    ta,
    toast,
    isEF,
    inboxItemId: effectiveInboxItemId,
    originalExtracted,
    buildPayload,
    reset,
    finishCreate,
    documentUploadInProgress,
    documentUploadFailed,
    showNoPeriodWarning,
    canUseAccrual,
    invoiceNumberInputRef,
    // The Utlägg nav row is gated on existing claims in the server layout.
    onExpenseRegistered: () => router.refresh(),
    onMissingField: focusMissingField,
    settleTransactionId: inboxItemId ? (settleWith?.transactionId ?? null) : null,
    euSupplier,
    acknowledgesInReview: async (data) => (await checkDuplicates(data))?.reference?.needs_acknowledgement === true,
  })

  // Gone, or never there: nothing is left for the unmount cleanup to remove.
  // A delete that failed (offline, a server error) is left for it to retry.
  const deleteSettled = (res: Response) => res.ok || res.status === 404

  async function discardUploadedDocument() {
    extractionPollTokenRef.current += 1
    const itemId = uploadedInboxItemId
    if (itemId) {
      try {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`, { method: 'DELETE' })
        if (deleteSettled(res)) discardedUploadIdsRef.current.add(itemId)
      } catch {
        // Best-effort cleanup: the unmount cleanup tries once more.
      }
    }
    const ids = documentFiles
      .filter((file) => file.status === 'uploaded' && file.id)
      .map((file) => file.id as string)
    await Promise.allSettled(
      ids.map(async (documentId) => {
        const res = await fetch(`/api/documents/${documentId}`, { method: 'DELETE' })
        if (deleteSettled(res)) discardedUploadIdsRef.current.add(documentId)
      }),
    )
  }

  function handleCancel() {
    void discardUploadedDocument().finally(() => {
      if (onCancel) onCancel()
      else router.push(inboxItemId ? '/e/general/invoice-inbox' : '/supplier-invoices')
    })
  }

  // --- Derived shell state ---

  const selectedSupplier = suppliers.find((s) => s.id === watchedSupplierId)
  const supplierHasGiro = Boolean(selectedSupplier?.bankgiro || selectedSupplier?.plusgiro)
  const underlagFile = documentFiles[0]
  // Självfaktura (crm#1367): offered for a supplier the company has a
  // self-billing agreement with, on a fresh invoice (not one read from an
  // underlag), while the company shows självfakturor at all.
  const selfBillingOffered =
    !inboxItemId &&
    !settleWith &&
    isInvoiceTypeEnabled(companySettingsRow, 'self_billing_enabled') &&
    Boolean(selectedSupplier?.self_billing_agreement_ref)
  const selfBilled = selfBillingOffered && watchedSelfBilled
  // A supplier without an agreement (or an underlag-driven invoice) takes no
  // självfaktura: drop a choice made for another supplier.
  useEffect(() => {
    if (!selfBillingOffered && watchedSelfBilled) setValue('is_self_billed', false)
  }, [selfBillingOffered, watchedSelfBilled, setValue])

  // Next-step line (the page's ONLY ochre line): same predicates and order as
  // the submit-time checks in useSupplierInvoiceSubmit, so the always-enabled
  // primary's focus routing and this line always agree.
  type MissingField = 'supplier' | 'invoice_number' | 'rows' | 'row_account' | 'reverse_charge_kind'
  const nextStep = ((): { field: MissingField; rowIndex?: number; label: string } | null => {
    if (!watchedSupplierId) {
      return { field: 'supplier', label: t('next_step_supplier') }
    }
    if (!selfBilled && !(watchedInvoiceNumber || '').trim()) {
      return { field: 'invoice_number', label: t('next_step_invoice_number') }
    }
    if (!watchedItems || watchedItems.length === 0) {
      return { field: 'rows', label: t('next_step_add_row') }
    }
    const rowMissingAccount = watchedItems.findIndex((item) => !item.account_number)
    if (rowMissingAccount !== -1) {
      return {
        field: 'row_account',
        rowIndex: rowMissingAccount,
        label: t('next_step_row_account', { row: rowMissingAccount + 1 }),
      }
    }
    if (reverseChargeKindUnanswered) {
      return { field: 'reverse_charge_kind', label: t('next_step_reverse_charge_kind') }
    }
    return null
  })()
  const reverseChargeKindRow = (
    <div className="flex items-center justify-between gap-4 border-b-hairline py-3 text-[13px]">
      <span>
        {t('reverse_charge_kind_label')}
        <span className="block text-xs text-muted-foreground">
          {t('reverse_charge_kind_help')}
        </span>
      </span>
      <Controller
        name="reverse_charge_kind"
        control={control}
        render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger ref={reverseChargeKindRef} className="h-8 w-28" aria-label={t('reverse_charge_kind_label')}>
              <SelectValue placeholder={t('reverse_charge_kind_placeholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eu_services">{t('reverse_charge_kind_services')}</SelectItem>
              <SelectItem value="eu_goods">{t('reverse_charge_kind_goods')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      />
    </div>
  )
  const forvalChips: string[] = [
    willBookAtRegistration
      ? t('forval_books_at_registration')
      : effectiveBookingMoment === 'payment'
        ? t('forval_books_at_payment')
        : t('forval_books_on_book_step'),
  ]
  if (watchedReverseCharge) {
    forvalChips.push(
      asksReverseChargeKind && watchedReverseChargeKind
        ? t(watchedReverseChargeKind === 'eu_goods' ? 'reverse_charge_chip_goods' : 'reverse_charge_chip_services')
        : t('reverse_charge_label'),
    )
  }
  if ((watchedCurrency || 'SEK') !== 'SEK') {
    forvalChips.push(
      watchedExchangeRate
        ? t('chip_currency_rate', { currency: watchedCurrency, rate: watchedExchangeRate })
        : watchedCurrency,
    )
  }
  if ((watchedCurrency || 'SEK') === 'SEK' && oreRounding) forvalChips.push(t('ore_rounding_label'))
  if (watchedDeliveryDate) forvalChips.push(t('chip_delivery_date', { date: formatDate(watchedDeliveryDate) }))
  if ((watchedNotes || '').trim()) forvalChips.push(t('chip_notes'))
  if (dimensionsEnabled && defaultDimsSummary) forvalChips.push(defaultDimsSummary)

  // Only a finished tolkning earns a caption: before it the drop zone and the
  // file row say what is going on.
  const underlagCaption = !inboxItemId && extractionPhase === 'done' ? t('underlag_caption_done') : null

  // The primary action follows "Vem betalade?": a person -> book the utlägg,
  // the company -> register and match the bank line, no one yet -> register.
  const primaryLabel = watchedPaidPrivately
    ? t('register_expense')
    : watchedPayer === 'company'
      ? t('register_and_mark_paid')
      : isEF
        ? t('register_invoice')
        : t('review_and_register')

  // min-w-0 on the root: DialogContent is display:grid; without it this grid
  // item's min-width:auto lets the kontering table's min-w force the whole
  // column wider than small viewports and the dialog clips it.
  return (
    <div className={bare ? 'relative min-w-0' : 'relative min-w-0 max-w-2xl'}>
      {/* In bare (dialog) mode the dialog renders the title. */}
      {!bare && (
        <div className="mb-6 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push(inboxItemId ? '/e/general/invoice-inbox' : '/supplier-invoices')}
            aria-label={inboxItemId ? t('back_aria_inbox') : t('back_aria')}
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl leading-8">{t('page_title')}</h1>
          </div>
        </div>
      )}

      {isLoadingInbox && (
        <Card className="mb-6">
          <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            {t('loading_inbox')}
          </CardContent>
        </Card>
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="divide-y divide-border">
          {/* ── Underlag (first: dokument-först) ─────────────────── */}
          <section className="pb-6">
            <SectionLabel>{t('section_underlag')}</SectionLabel>
            {inboxItemId ? (
              <div className="flex items-center gap-3 rounded-lg px-4 py-3 text-[13px] text-muted-foreground bg-control shadow-raised">
                <DocumentTextIcon className="h-4 w-4 shrink-0" />
                {t('underlag_caption_inbox')}
              </div>
            ) : selfBilled ? (
              // Our own document: the server refuses an uploaded underlag on a
              // självfaktura, so none is offered (crm#1367).
              <div className="flex items-center gap-3 rounded-lg px-4 py-3 text-[13px] text-muted-foreground bg-control shadow-raised">
                <DocumentTextIcon className="h-4 w-4 shrink-0" />
                {t('underlag_caption_self_billed')}
              </div>
            ) : underlagFile ? (
              <div className="flex items-center justify-between gap-3 rounded-lg px-4 py-3 bg-control shadow-raised">
                <div className="flex min-w-0 items-center gap-3">
                  <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px]">{underlagFile.fileName}</p>
                    {(underlagFile.status === 'uploading' || extractionPhase === 'processing') && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <SpinnerIcon className="h-3 w-3 animate-spin" />
                        {underlagFile.status === 'uploading'
                          ? t('underlag_uploading')
                          : t('underlag_processing')}
                      </div>
                    )}
                    {underlagFile.status === 'error' && (
                      <p className="text-xs text-destructive">{underlagFile.error}</p>
                    )}
                    {underlagFile.status === 'uploaded' && extractionPhase === 'slow' && (
                      <p className="text-xs text-muted-foreground">
                        {t('underlag_read_slow')}{' '}
                        <button type="button" className={QUIET_LINK_CLASS} onClick={checkReadingAgain}>
                          {t('underlag_read_check_again')}
                        </button>
                      </p>
                    )}
                    {underlagFile.status === 'uploaded' && extractionPhase === 'failed' && (
                      <p className="text-xs text-muted-foreground">
                        {t('underlag_read_failed')}{' '}
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => void retryUnderlagReading()}>
                          {t('underlag_read_retry')}
                        </button>
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className={cn(QUIET_LINK_CLASS, 'shrink-0 disabled:opacity-50')}
                  onClick={handleRemoveUnderlag}
                  disabled={underlagFile.status === 'uploading'}
                  aria-label={t('underlag_remove_aria')}
                >
                  {t('underlag_remove')}
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground transition-colors hover:bg-secondary/60',
                    isDraggingUnderlag && 'border-foreground/40 bg-secondary/60',
                  )}
                  onClick={() => underlagInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setIsDraggingUnderlag(true)
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault()
                    setIsDraggingUnderlag(false)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setIsDraggingUnderlag(false)
                    const file = e.dataTransfer.files?.[0]
                    if (file) void handleUnderlagFile(file)
                  }}
                >
                  {t('underlag_drop_prompt')}
                </button>
                <input
                  ref={underlagInputRef}
                  type="file"
                  accept={INBOX_UPLOAD_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void handleUnderlagFile(file)
                    if (underlagInputRef.current) underlagInputRef.current.value = ''
                  }}
                />
              </>
            )}
            {pendingExtraction ? (
              // Deferred tolkning landed after the user started typing: never
              // auto-overwrite; offer the fill as a quiet choice instead.
              <p className="mt-2 text-xs text-muted-foreground">
                {t('extraction_ready_line')}{' '}
                <button type="button" className={QUIET_LINK_CLASS} onClick={applyPendingExtraction}>
                  {t('extraction_ready_apply')}
                </button>
              </p>
            ) : underlagCaption ? (
              <p className="mt-2 text-xs text-muted-foreground">{underlagCaption}</p>
            ) : null}
          </section>

          {/* ── Leverantör ───────────────────────────────────────── */}
          <section className="py-6">
            <SectionLabel>
              {t('section_supplier')}
            </SectionLabel>

            {showAISupplierHint && (
              <div className="mb-3 rounded-lg p-4 bg-control shadow-raised">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <ChatBubbleOvalLeftIcon className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">
                        {t('ai_suggested_supplier', { name: extractedData?.supplier?.name ?? '' })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {extractedData?.supplier?.orgNumber
                          ? t('ai_org_number', { orgNumber: extractedData.supplier.orgNumber })
                          : t('ai_no_org_number')}
                        {t('ai_supplier_not_in_system')}
                      </p>
                    </div>
                  </div>
                  <Button type="button" onClick={openSupplierDialogPrefilled}>
                    <PlusIcon className="h-4 w-4" />
                    {t('create_and_select')}
                  </Button>
                </div>
              </div>
            )}

            <CustomerCombobox
              kind="supplier"
              value={watchedSupplierId ?? ''}
              customers={suppliers}
              onChange={(supplierId) => {
                setValue('supplier_id', supplierId, { shouldDirty: true })
                requestAnimationFrame(() => invoiceNumberInputRef.current?.focus())
              }}
              inputRef={supplierInputRef}
              className={cn('h-11 text-[15px]', settledFields.has('supplier_id') && 'prefill-settle')}
              aria-required
              loading={!suppliersLoaded}
              emptyLabel={t('no_suppliers_yet')}
              onCreateCustomer={openSupplierDialogNamed}
            />
            {selectedSupplier?.org_number && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('org_number_prefix', { number: selectedSupplier.org_number })}
              </p>
            )}
            {selfBillingOffered && (
              <div className="mt-3 flex items-start justify-between gap-4 rounded-lg px-4 py-3 bg-control shadow-raised">
                <div className="min-w-0">
                  <Label htmlFor="si-self-billed" className="text-sm font-medium">
                    {t('self_billing_toggle_label')}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('self_billing_toggle_help', { agreement: selectedSupplier?.self_billing_agreement_ref ?? '' })}
                  </p>
                </div>
                <Switch
                  id="si-self-billed"
                  checked={watchedSelfBilled}
                  onCheckedChange={(next) => {
                    setValue('is_self_billed', next, { shouldDirty: true })
                    if (next) {
                      // What a självfaktura can carry today: SEK, Swedish VAT,
                      // paid by the company (the server refuses anything else).
                      setValue('currency', 'SEK', { shouldDirty: true })
                      setValue('reverse_charge', false, { shouldDirty: true })
                      setValue('payer', 'unpaid', { shouldDirty: true })
                    }
                  }}
                />
              </div>
            )}
          </section>

          {/* ── Fakturauppgifter ─────────────────────────────────── */}
          <section className="py-6">
            <SectionLabel>
              {t('section_details')}
            </SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-invoice-number" className="text-xs font-normal text-muted-foreground">
                    {t('supplier_invoice_number_label')}
                  </Label>
                  <AiFilledIndicator active={aiFlags.invoiceNumber} label="AI-fyllt" />
                </div>
                {selfBilled ? (
                  <p className="flex h-9 items-center text-sm text-muted-foreground">{t('self_billing_number_note')}</p>
                ) : (
                  (() => {
                    const { ref: rhfRef, ...rest } = register('supplier_invoice_number')
                    return (
                      <Input
                        id="si-invoice-number"
                        placeholder={t('supplier_invoice_number_placeholder')}
                        autoComplete="off"
                        className={cn('h-9', settledFields.has('supplier_invoice_number') && 'prefill-settle')}
                        {...rest}
                        ref={(el) => {
                          rhfRef(el)
                          invoiceNumberInputRef.current = el
                        }}
                      />
                    )
                  })()
                )}
                {duplicates?.number && (
                  <DuplicateNumberLine number={(watchedInvoiceNumber || '').trim()} invoice={duplicates.number} />
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-invoice-date" className="text-xs font-normal text-muted-foreground">
                    {t('invoice_date_label')}
                  </Label>
                  <AiFilledIndicator active={aiFlags.invoiceDate} label="AI-fyllt" />
                </div>
                <Input
                  id="si-invoice-date"
                  type="date"
                  className={cn('h-9 tabular-nums', settledFields.has('invoice_date') && 'prefill-settle')}
                  {...register('invoice_date')}
                />
              </div>
              {/* Vem betalade? The same control as the Underlag pane: the
                  answer decides the credit account (2440, the bank line or a
                  person's liability) and the primary action in the footer. */}
              <Controller
                name="payer"
                control={control}
                render={({ field }) => (
                  <PayerChoiceSelect
                    id="si-payer"
                    value={field.value}
                    onChange={field.onChange}
                    accountingMethod={accountingMethod}
                    disabled={selfBilled}
                    labelClassName="text-xs font-normal text-muted-foreground"
                  />
                )}
              />
              {settleWith && inboxItemId && watchedPayer === 'company' && (
                <p data-ph-mask="" className="text-xs text-muted-foreground">
                  {t('settle_with_bank_row', {
                    date: formatDate(settleWith.date),
                    amount: formatCurrency(Math.abs(settleWith.amount), settleWith.currency),
                    counterparty: settleWith.counterparty ?? t('settle_with_bank_row_unknown'),
                  })}
                </p>
              )}
              {isPersonPayer(watchedPayer) && (
                <ExpenseClaimantFields
                  payer={watchedPayer}
                  ownerName={watchedClaimantName}
                  onOwnerNameChange={(name) => setValue('claimant_name', name, { shouldDirty: true })}
                  employeeId={watchedEmployeeId}
                  onEmployeeChange={(id) => setValue('employee_id', id, { shouldDirty: true })}
                  idPrefix="si"
                  className="space-y-2"
                  labelClassName="text-xs font-normal text-muted-foreground"
                  inputClassName="h-9"
                />
              )}
              {!watchedPaidPrivately && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="si-due-date" className="text-xs font-normal text-muted-foreground">
                        {t('due_date_label')}
                      </Label>
                      <AiFilledIndicator active={aiFlags.dueDate} label="AI-fyllt" />
                    </div>
                    <Input
                      id="si-due-date"
                      type="date"
                      className={cn('h-9 tabular-nums', settledFields.has('due_date') && 'prefill-settle')}
                      {...register('due_date', {
                        onChange: () => {
                          dueDateManualRef.current = true
                          setDueDateCaption(null)
                        },
                      })}
                    />
                    {dueDateCaption && (
                      <p className="text-xs text-muted-foreground">
                        {dueDateCaption.type === 'terms'
                          ? t('due_from_terms_caption', { days: dueDateCaption.days })
                          : t('due_on_invoice_caption')}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="si-payment-reference" className="text-xs font-normal text-muted-foreground">
                        {t('payment_reference_label')}
                      </Label>
                      <AiFilledIndicator active={aiFlags.paymentReference} label="AI-fyllt" />
                    </div>
                    <Input
                      id="si-payment-reference"
                      placeholder={t('payment_reference_placeholder')}
                      autoComplete="off"
                      className={cn('h-9', settledFields.has('payment_reference') && 'prefill-settle')}
                      {...register('payment_reference')}
                    />
                    {duplicates?.reference && <ReusedReferenceLine reuse={duplicates.reference} />}
                    {supplierHasGiro && (
                      <p className="text-xs text-muted-foreground">{t('ocr_payment_file_caption')}</p>
                    )}
                  </div>
                </>
              )}
              <div className="space-y-2">
                <Label htmlFor="si-faktura-total" className="text-xs font-normal text-muted-foreground">
                  {t('invoice_total_label')}
                </Label>
                <Input
                  id="si-faktura-total"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0,00"
                  className={cn('h-9 text-right tabular-nums', settledFields.has('faktura_total') && 'prefill-settle')}
                  value={fakturaTotalStr}
                  onChange={(e) => setFakturaTotalStr(e.target.value)}
                  onBlur={() => {
                    const parsed = parseAmountInput(fakturaTotalStr)
                    if (parsed != null) setFakturaTotalStr(formatAmount(parsed))
                  }}
                />
              </div>
              {fakturaVatVisible && (
                <div className="space-y-2">
                  <Label htmlFor="si-faktura-vat" className="text-xs font-normal text-muted-foreground">
                    {t('invoice_vat_label')}
                  </Label>
                  <Input
                    id="si-faktura-vat"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0,00"
                    className={cn('h-9 text-right tabular-nums', settledFields.has('faktura_vat') && 'prefill-settle')}
                    value={fakturaVatStr}
                    onChange={(e) => setFakturaVatStr(e.target.value)}
                    onBlur={() => {
                      const parsed = parseAmountInput(fakturaVatStr)
                      if (parsed != null) setFakturaVatStr(formatAmount(parsed))
                    }}
                  />
                </div>
              )}
            </div>

            {/* Total-first cross-check (client-only, never sent): quiet until
                the kontering has a row to compare with. */}
            {fields.length > 0 && (crosscheckDiff != null || vatCrosscheckDiff != null) && (
              <div className="mt-3 space-y-1 text-right text-xs">
                {crosscheckDiff != null && (
                  <p className={crosscheckMatches ? 'text-success' : 'text-destructive'}>
                    {!crosscheckMatches
                      ? t('crosscheck_diff', { diff: signedAmount(crosscheckDiff) })
                      : figures.rounding.applies
                        ? t('crosscheck_match_rounded', { amount: signedAmount(figures.rounding.roundingDelta) })
                        : t('crosscheck_match')}
                  </p>
                )}
                {vatCrosscheckDiff != null && !vatCrosscheckMatches && (
                  <p className="text-destructive">
                    {t('crosscheck_vat_diff', { diff: signedAmount(vatCrosscheckDiff) })}
                  </p>
                )}
                {/* Less moms than the rows carry is often a limited deduction
                    typed into the invoice's Moms field (crm#1617): point at
                    the row control that books it. */}
                {vatCrosscheckDiff != null && !vatCrosscheckMatches && vatCrosscheckDiff < 0 && totalNonDeductibleVat === 0 && (
                  <p className="text-muted-foreground">{t('crosscheck_vat_limited_hint')}</p>
                )}
              </div>
            )}

            {showNoPeriodWarning && (
              <div
                role="alert"
                className="bg-destructive/8 mt-4 flex items-start gap-3 rounded-lg p-3"
              >
                <ExclamationCircleIcon className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 text-sm text-destructive">
                  <p className="font-medium">{t('no_period_warning', { date: bookedDateHere })}</p>
                  <p className="mt-0.5">{t('no_period_help')}</p>
                </div>
              </div>
            )}
            {bookedDateFiledVat && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t('booked_date_filed_vat', {
                  booked: formatDate(bookedDateHere),
                  period: bookedDateFiledVat.tax_period,
                  date: formatDate(bookedDateFiledVat.filed_on),
                })}
              </p>
            )}
          </section>

          {/* ── Kontering ────────────────────────────────────────── */}
          <section className="py-6">
            <SectionLabel>
              {t('section_accounting')}
              {fields.length > 0 && (
                <span className="ml-2 normal-case tracking-normal">
                  {t('rows_count', { count: fields.length })}
                </span>
              )}
            </SectionLabel>

            {/* The invoice's own lines beside the rows the reading opened
                with: one quiet choice, gone once the person has changed a row. */}
            {readingRowsChoice && (
              <p className="mb-3 text-xs text-muted-foreground">
                {t(readingRowsChoice.split ? 'reading_rows_split_line' : 'reading_rows_combined_line', {
                  count: readingRowsChoice.lineCount,
                })}{' '}
                <button type="button" className={QUIET_LINK_CLASS} onClick={toggleReadingRows}>
                  {t(readingRowsChoice.split ? 'reading_rows_combine' : 'reading_rows_split')}
                </button>
              </p>
            )}

            {templateAccountNote &&
              (watchedItems ?? []).some((r) => r.account_number === templateAccountNote.account) && (
                <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                  {t('account_from_history', {
                    account: templateAccountNote.account,
                    counterparty: formatCounterpartyName(templateAccountNote.counterparty),
                  })}
                </p>
              )}

            {/* Non-blocking account-range hint for reverse charge (#863 item 2) */}
            {rcAccountWarningRows.length > 0 && (
              <div
                role="status"
                className="mb-3 flex items-start gap-2 rounded-lg p-3 bg-control shadow-raised"
              >
                <ExclamationTriangleIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-sm text-muted-foreground">
                  {t('rc_account_warning', {
                    count: rcAccountWarningRows.length,
                    rows: rcAccountWarningRows.map((i) => i + 1).join(', '),
                  })}
                </p>
              </div>
            )}

            {/* Non-blocking omvand-skattskyldighet hint for foreign suppliers
                invoiced at 0 % VAT (#1042). Mutually exclusive with the banner
                above: that one needs the switch on, this one needs it off. */}
            {foreignZeroVatRows.length > 0 && (
              <div
                role="status"
                className="mb-3 flex items-start gap-2 rounded-lg p-3 bg-control shadow-raised"
              >
                <ExclamationTriangleIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-sm text-muted-foreground">
                  {t('foreign_zero_vat_warning', {
                    count: foreignZeroVatRows.length,
                    rows: foreignZeroVatRows.map((i) => i + 1).join(', '),
                  })}
                </p>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-[13px]">
                <thead className="[&_th]:font-medium [&_th]:text-xs [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b-hairline text-left">
                    <th className="w-28 pb-2 pr-2">{t('col_account')}</th>
                    <th className="pb-2 pr-2">{t('col_description')}</th>
                    <th className="w-28 pb-2 pr-2 text-right">
                      {vatColsVisible ? t('col_amount_excl') : t('col_amount')}
                    </th>
                    {vatColsVisible && (
                      <>
                        <th className="w-32 pb-2 pr-2">
                          {watchedReverseCharge ? t('col_rc_vat_rate') : t('col_vat_rate')}
                        </th>
                        <th className="w-24 pb-2 pr-2 text-right">
                          {watchedReverseCharge ? t('col_rc_vat') : t('col_vat')}
                        </th>
                      </>
                    )}
                    <th className="w-20 pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <Fragment key={field.id}>
                      <tr
                        className={cn(
                          'group align-middle',
                          (canUseAccrual && isAccrualOpen(index)) ||
                            (dimensionsEnabled && isDimOpen(index)) ||
                            slpRowVisible(index) ||
                            isLimitedDeductionOpen(index)
                            ? 'border-0'
                            : 'border-b-hairline',
                          settledFields.has('items') && 'prefill-settle',
                        )}
                      >
                        <td className="py-1 pr-2">
                          <Controller
                            name={`items.${index}.account_number`}
                            control={control}
                            render={({ field: f }) => (
                              <AccountCombobox
                                value={f.value}
                                accounts={accounts}
                                onChange={(val) => handleAccountChange(index, val)}
                                className="h-8 px-2 text-[13px]"
                                inputRef={(el) => {
                                  accountInputRefs.current[index] = el
                                }}
                              />
                            )}
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Controller
                            name={`items.${index}.description`}
                            control={control}
                            render={({ field }) => (
                              <Input
                                placeholder={t('description_placeholder')}
                                className={CELL_INPUT_CLASS}
                                ref={field.ref}
                                value={field.value ?? ''}
                                onChange={field.onChange}
                                onBlur={field.onBlur}
                              />
                            )}
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Controller
                            name={`items.${index}.amount`}
                            control={control}
                            render={({ field }) => (
                              <AmountCell
                                value={field.value}
                                onChange={field.onChange}
                                className={cn(CELL_INPUT_CLASS, 'text-right tabular-nums')}
                                inputRef={(el) => {
                                  amountInputRefs.current[index] = el
                                }}
                              />
                            )}
                          />
                        </td>
                        {vatColsVisible && (
                          <>
                            <td className="py-1 pr-2">
                              {/* One Controller per field, each with its own key:
                                  a Controller whose name changes hands the new
                                  field the value the cell was first shown with. */}
                              {watchedReverseCharge ? (
                                <Controller
                                  key="reverse_charge_rate"
                                  name={`items.${index}.reverse_charge_rate`}
                                  control={control}
                                  render={({ field: f }) => (
                                    <RcRateSelect
                                      value={reverseChargeRateOf({
                                        vat_rate: watchedItems?.[index]?.vat_rate,
                                        reverse_charge_rate: f.value,
                                      })}
                                      onChange={f.onChange}
                                    />
                                  )}
                                />
                              ) : (
                                <Controller
                                  key="vat_rate"
                                  name={`items.${index}.vat_rate`}
                                  control={control}
                                  render={({ field: f }) => (
                                    <VatRateCell value={f.value} onChange={f.onChange} />
                                  )}
                                />
                              )}
                            </td>
                            <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                              {formatAmount(roundOre((itemTotals[index]?.vatAmount ?? 0) + (nonDeductibleVat[index] ?? 0)))}
                            </td>
                          </>
                        )}
                        <td className="py-1 text-right whitespace-nowrap">
                          <span className={cn('inline-flex items-center justify-end gap-1', HOVER_REVEAL_CLASS)}>
                            {dimensionsEnabled && (
                              <button
                                type="button"
                                onClick={() => toggleDimensions(index)}
                                aria-label={t('row_dimensions_aria', { index: index + 1 })}
                                aria-pressed={isDimOpen(index)}
                                title={t('row_dimensions_title')}
                                className={ROW_ICON_BTN_CLASS}
                              >
                                <HashtagIcon
                                  className={cn(
                                    'h-3.5 w-3.5',
                                    isDimOpen(index) ? 'text-foreground' : undefined,
                                  )}
                                />
                              </button>
                            )}
                            {limitedDeductionAvailable(index) && (
                              <button
                                type="button"
                                onClick={() => toggleLimitedDeduction(index)}
                                aria-label={t('row_deductible_vat_aria', { index: index + 1 })}
                                aria-pressed={isLimitedDeductionOpen(index)}
                                title={t('row_deductible_vat_title')}
                                className={ROW_ICON_BTN_CLASS}
                              >
                                <PercentBadgeIcon
                                  className={cn(
                                    'h-4 w-4',
                                    isLimitedDeductionOpen(index) ? 'text-foreground' : undefined,
                                  )}
                                />
                              </button>
                            )}
                            {canUseAccrual && (
                              <button
                                type="button"
                                onClick={() => toggleAccrual(index)}
                                aria-label={ta('row_toggle_aria', { index: index + 1 })}
                                aria-pressed={isAccrualOpen(index)}
                                title={ta('row_toggle')}
                                className={ROW_ICON_BTN_CLASS}
                              >
                                <CalendarDaysIcon
                                  className={cn(
                                    'h-3.5 w-3.5',
                                    isAccrualOpen(index) ? 'text-foreground' : undefined,
                                  )}
                                />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => remove(index)}
                              aria-label={t('remove_row_named_aria', {
                                index: index + 1,
                                description:
                                  watchedItems?.[index]?.description || t('row_no_description'),
                              })}
                              className={cn(ROW_ICON_BTN_CLASS, 'hover:text-destructive')}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </td>
                      </tr>
                      {canUseAccrual && isAccrualOpen(index) && (
                        <tr className={cn((dimensionsEnabled && isDimOpen(index)) || slpRowVisible(index) || isLimitedDeductionOpen(index) ? 'border-0' : 'border-b-hairline')}>
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderAccrualPanel(index, `accrual-${index}`)}
                          </td>
                        </tr>
                      )}
                      {dimensionsEnabled && isDimOpen(index) && (
                        <tr className={cn(slpRowVisible(index) || isLimitedDeductionOpen(index) ? 'border-0' : 'border-b-hairline')}>
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderDimensionsPanel(index)}
                          </td>
                        </tr>
                      )}
                      {slpRowVisible(index) && (
                        <tr className={cn(isLimitedDeductionOpen(index) ? 'border-0' : 'border-b-hairline')}>
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderSlpPanel(index)}
                          </td>
                        </tr>
                      )}
                      {isLimitedDeductionOpen(index) && (
                        <tr className="border-b-hairline">
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderLimitedDeductionPanel(index)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  {/* Ghost entry row: never part of form state until committed.
                      The autocomplete opens on focus; Enter (or a full 4-digit
                      number) commits and moves focus to the new row's amount. */}
                  <tr>
                    <td className="py-2 pr-2">
                      <AccountCombobox
                        key={entryResetKey}
                        value=""
                        accounts={accounts}
                        onChange={() => {}}
                        onCommit={commitEntryAccount}
                        className="h-8 px-2 text-[13px]"
                        inputRef={(el) => {
                          entryInputRef.current = el
                        }}
                      />
                    </td>
                    <td className="py-2 pr-2 italic text-muted-foreground">
                      {t('ghost_description')}
                    </td>
                    <td className="py-2 pr-2 text-right italic tabular-nums text-muted-foreground">
                      0
                    </td>
                    {vatColsVisible && (
                      <>
                        <td className="py-2 pr-2 italic tabular-nums text-muted-foreground">
                          25 %
                        </td>
                        <td className="py-2 pr-2 text-right italic text-muted-foreground">-</td>
                      </>
                    )}
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ── Förval ───────────────────────────────────────────── */}
          <section className="py-6">
            <SectionLabel>{t('section_forval')}</SectionLabel>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
              <span>{forvalChips.join(' · ')}</span>
              <span aria-hidden="true">{'·'}</span>
              <button
                type="button"
                className="whitespace-nowrap rounded-sm text-foreground underline underline-offset-[3px] transition-colors hover:bg-secondary/60"
                aria-expanded={forvalOpen}
                onClick={() => setForvalOpen((open) => !open)}
              >
                {forvalOpen ? `${t('forval_toggle_close')} ▴` : `${t('forval_toggle_open')} ▾`}
              </button>
            </div>
            {/* Goods or services stays in plain view for an EU supplier:
                behind Ändra förval it was missed (crm#1323). */}
            {asksReverseChargeKind && !forvalOpen && (
              <div className="mt-4 border-t-hairline">{reverseChargeKindRow}</div>
            )}
            {forvalOpen && (
              <div className="mt-4 border-t-hairline">
                <div className="flex items-center justify-between gap-4 border-b-hairline py-3 text-[13px]">
                  <label htmlFor="reverse_charge" className="cursor-pointer">
                    {t('reverse_charge_label')}
                    <span className="block text-xs text-muted-foreground">
                      {t('reverse_charge_help')}
                    </span>
                  </label>
                  <Controller
                    name="reverse_charge"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="reverse_charge"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={selfBilled}
                      />
                    )}
                  />
                </div>
                {asksReverseChargeKind && reverseChargeKindRow}
                <div className="flex items-center justify-between gap-4 border-b-hairline py-3 text-[13px]">
                  <span>{t('currency_label')}</span>
                  <Controller
                    name="currency"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange} disabled={selfBilled}>
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="SEK">SEK</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                          <SelectItem value="NOK">NOK</SelectItem>
                          <SelectItem value="DKK">DKK</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                {watchedCurrency !== 'SEK' && (
                  <div className="flex items-center justify-between gap-4 border-b-hairline py-3 text-[13px]">
                    <span>
                      {t('exchange_rate_label')}{' '}
                      <span className="text-muted-foreground">{t('exchange_rate_to_sek')}</span>
                    </span>
                    <Input
                      type="number"
                      step="0.0001"
                      inputMode="decimal"
                      placeholder={t('exchange_rate_placeholder')}
                      className="h-8 w-36 text-right tabular-nums"
                      {...register('exchange_rate', {
                        onChange: () => { userTouchedRateRef.current = true },
                      })}
                    />
                  </div>
                )}
                {(watchedCurrency || 'SEK') === 'SEK' && (
                  <div className="flex items-center justify-between gap-4 border-b-hairline py-3 text-[13px]">
                    <label htmlFor="ore-rounding" className="cursor-pointer">
                      {t('ore_rounding_label')}
                      <span className="block text-xs text-muted-foreground">{t('ore_rounding_help')}</span>
                    </label>
                    <Switch
                      id="ore-rounding"
                      checked={oreRounding}
                      onCheckedChange={setOreRounding}
                      aria-label={t('ore_rounding_label')}
                    />
                  </div>
                )}
                <div className="flex items-center justify-between gap-4 border-b-hairline py-3 text-[13px]">
                  <Label htmlFor="si-delivery-date" className="text-[13px] font-normal">
                    {t('delivery_date_label')}
                  </Label>
                  <Input
                    id="si-delivery-date"
                    type="date"
                    className="h-8 w-40 tabular-nums"
                    {...register('delivery_date')}
                  />
                </div>
                {registrationDateCapped && (
                  <p className="border-b-hairline py-2 text-xs text-muted-foreground">
                    {t('eu_goods_registration_date_hint', { date: formatDate(registrationDateHere) })}
                  </p>
                )}
                {dimensionsEnabled && (
                  <div className="border-b-hairline py-3 text-[13px]">
                    <span>{t('row_dimensions_title')}</span>
                    <div className="mt-2 max-w-md">
                      <LineDimensionFields
                        dimensions={defaultDims}
                        onChange={setDefaultDimension}
                        inputClassName="h-8"
                      />
                    </div>
                    {defaultDimsFromSupplier && (
                      <p className="mt-1.5 text-xs text-muted-foreground">{t('default_dims_from_supplier')}</p>
                    )}
                  </div>
                )}
                <div className="py-3 text-[13px]">
                  <Label htmlFor="si-notes" className="text-[13px] font-normal">
                    {t('notes_label')}
                  </Label>
                  <Textarea
                    id="si-notes"
                    placeholder={t('notes_placeholder')}
                    className="mt-2"
                    {...register('notes')}
                  />
                </div>
              </div>
            )}
          </section>

          {/* ── Summering ────────────────────────────────────────── */}
          <section className="pt-6">
            <SectionLabel>{t('section_summary')}</SectionLabel>
            {vatColsVisible && (
              <>
                <div className="flex items-baseline justify-between border-b-hairline py-2 text-[13px]">
                  <span className="text-muted-foreground">{t('net_excl_vat')}</span>
                  <span className="tabular-nums">{formatCurrency(subtotal, watchedCurrency)}</span>
                </div>
                <div className="flex items-baseline justify-between border-b-hairline py-2 text-[13px]">
                  <span className="text-muted-foreground">
                    {watchedReverseCharge ? t('vat_reverse_charge') : t('vat_label_short')}
                  </span>
                  <span className="tabular-nums">{formatCurrency(totalVat, watchedCurrency)}</span>
                </div>
                {totalNonDeductibleVat !== 0 && (
                  <div className="flex items-baseline justify-between border-b-hairline py-2 text-[13px]">
                    <span className="text-muted-foreground">{t('non_deductible_vat_label')}</span>
                    <span className="tabular-nums">{formatCurrency(totalNonDeductibleVat, watchedCurrency)}</span>
                  </div>
                )}
              </>
            )}
            {figures.rounding.applies && (
              <div className="flex items-baseline justify-between border-b-hairline py-2 text-[13px]">
                <span className="text-muted-foreground">{t('ore_rounding_label')}</span>
                <span className="tabular-nums">{signedAmount(figures.rounding.roundingDelta)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between pt-4">
              <span className="text-[15px] font-medium text-strong">{t('total_payable_label')}</span>
              <span className="font-display text-xl tabular-nums">
                {formatCurrency(figures.toPay, watchedCurrency)}
              </span>
            </div>

            {/* The page's single ochre line: what stands between the user and
                a registered invoice. Gone once nothing does: the Förval line
                names the booking moment and the confirm dialog the outcome
                (convention 10). The live region stays mounted so the change
                is announced. */}
            <p aria-live="polite" className={cn('text-xs text-attn', nextStep && 'pt-6')}>
              {nextStep && (
                <>
                  {t('next_step_prefix')}
                  <button
                    type="button"
                    className="underline underline-offset-[3px] hover:opacity-80"
                    onClick={() => focusMissingField(nextStep.field, nextStep.rowIndex)}
                  >
                    {nextStep.label}
                  </button>
                  .
                </>
              )}
            </p>
          </section>
        </div>

        {/* ── Sticky action bar (binds to the dialog scroll container in bare
            mode, to the page panel scroll on the standalone page) ── */}
        <div
          className={cn(
            'sticky bottom-0 z-10 mt-6 border-t-hairline bg-background',
            bare && '-mx-6 -mb-6 rounded-b-xl px-6',
          )}
        >
          {/* The total lives once, as the Summering headline above. */}
          <div className="flex flex-wrap items-center justify-end gap-3 py-3">
            <button
              type="button"
              className={cn(QUIET_LINK_CLASS, 'disabled:opacity-50')}
              onClick={handleCancel}
              disabled={isSubmitting || documentUploadInProgress}
            >
              {t('cancel')}
            </button>
            {/* Always enabled pre-click for writable users: clicking with
                something missing routes focus to the first missing field
                (submit-time hard blocks stay in onSubmit). Viewers keep the
                disabled + lock treatment: authorization, not validation. */}
            <Button
              type="submit"
              disabled={!canWrite}
              loading={isSubmitting}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {isSubmitting ? (
                t('registering')
              ) : !canWrite ? (
                <>
                  <LockClosedIcon className="h-4 w-4" />
                  {primaryLabel}
                </>
              ) : (
                primaryLabel
              )}
            </Button>
          </div>
        </div>
      </form>

      {/* Review dialog (AB: also shown after a bank transaction is picked in
          the register-and-match flow. EF only when a reused payment reference
          is acknowledged here). */}
      {pendingData && showReview && (() => {
        const reviewSupplier = suppliers.find((s) => s.id === pendingData.supplier_id)
        if (!reviewSupplier) return null
        return (
          <ConfirmationDialog
            open={showReview}
            onOpenChange={setShowReview}
            onConfirm={handleConfirm}
            isSubmitting={isSubmitting}
            title={t('review_dialog_title')}
            // One attention sentence: a reference to acknowledge takes its
            // place, right above the button that acknowledges it.
            warningText={
              reuseToAcknowledge ? (
                <span data-ph-mask="">
                  <ReusedReferenceSentence reuse={reuseToAcknowledge} />
                </span>
              ) : effectiveBookingMoment === 'issue'
                ? t('review_dialog_warning')
                : effectiveBookingMoment === 'payment'
                  ? t('review_dialog_warning_cash')
                  : t('review_dialog_warning_deferred')
            }
            confirmLabel={reuseToAcknowledge ? t('review_dialog_confirm_anyway') : t('review_dialog_confirm')}
          >
            <SupplierInvoiceReviewContent
              supplier={reviewSupplier}
              invoiceNumber={pendingData.supplier_invoice_number}
              invoiceDate={pendingData.invoice_date}
              dueDate={pendingData.due_date}
              deliveryDate={pendingData.delivery_date || undefined}
              currency={pendingData.currency}
              exchangeRate={pendingData.exchange_rate || undefined}
              reverseCharge={pendingData.reverse_charge}
              reverseChargeKind={pendingData.reverse_charge && euSupplier ? pendingData.reverse_charge_kind || undefined : undefined}
              paymentReference={pendingData.payment_reference || undefined}
              items={bookLimitedDeduction(pendingData.items, limitedDeductionApplies(pendingData)).items}
              oreRounding={oreRounding}
              bookingMoment={effectiveBookingMoment}
              chartVatTreatments={chartVatTreatmentsOf(accounts)}
              defaultDimensions={defaultDims}
              statedVat={statedVatFromInvoiceField(
                bookLimitedDeduction(pendingData.items, limitedDeductionApplies(pendingData)).items,
                enteredFakturaVat,
                pendingData.reverse_charge,
              )}
            />
          </ConfirmationDialog>
        )
      })()}

      {/* Bank transaction picker for "Registrera & markera som betald". The
          target is the payable including the invoice rounding item. */}
      <BankTransactionPicker
        open={showBankPicker}
        onOpenChange={setShowBankPicker}
        targetAmount={figures.toPay}
        targetCurrency={watchedCurrency}
        onPick={handlePickTransaction}
      />

      {/* New supplier dialog */}
      <Dialog open={showNewSupplier} onOpenChange={setShowNewSupplier}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t('new_supplier_dialog_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('new_supplier_name_label')}</Label>
              <Input
                placeholder={t('new_supplier_name_placeholder')}
                value={newSupplier.name}
                onChange={(e) => setNewSupplier((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('new_supplier_type_label')}</Label>
              <Select
                value={newSupplier.supplier_type}
                onValueChange={(v) => setNewSupplier((p) => ({ ...p, supplier_type: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="swedish_business">{t('supplier_type_swedish')}</SelectItem>
                  <SelectItem value="eu_business">{t('supplier_type_eu')}</SelectItem>
                  <SelectItem value="non_eu_business">{t('supplier_type_non_eu')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('new_supplier_org_number_label')}</Label>
                <Input
                  placeholder="XXXXXX-XXXX"
                  value={newSupplier.org_number}
                  onChange={(e) => setNewSupplier((p) => ({ ...p, org_number: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('new_supplier_vat_number_label')}</Label>
                <Input
                  placeholder="SE..."
                  value={newSupplier.vat_number}
                  onChange={(e) => setNewSupplier((p) => ({ ...p, vat_number: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('new_supplier_address_label')}</Label>
              <Input
                placeholder={t('new_supplier_address_placeholder')}
                value={newSupplier.address_line1}
                onChange={(e) => setNewSupplier((p) => ({ ...p, address_line1: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('new_supplier_bankgiro_label')}</Label>
                <Input
                  placeholder="XXX-XXXX"
                  value={newSupplier.bankgiro}
                  onChange={(e) => setNewSupplier((p) => ({ ...p, bankgiro: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('new_supplier_plusgiro_label')}</Label>
                <Input
                  placeholder="XXXXXX-X"
                  value={newSupplier.plusgiro}
                  onChange={(e) => setNewSupplier((p) => ({ ...p, plusgiro: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('new_supplier_default_account_label')}</Label>
              <Input
                placeholder={t('new_supplier_default_account_placeholder')}
                value={newSupplier.default_expense_account}
                onChange={(e) => setNewSupplier((p) => ({ ...p, default_expense_account: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewSupplier(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleCreateSupplier} loading={isCreatingSupplier}>
              {isCreatingSupplier ? (
                t('creating')
              ) : (
                t('create_supplier_button')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicate-number conflict dialog */}
      <Dialog open={!!conflict} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ExclamationCircleIcon className="h-5 w-5 text-destructive" />
              {t('duplicate_dialog_title')}
            </DialogTitle>
            {/* data-ph-mask: the conflict message carries the invoice number */}
            <DialogDescription data-ph-mask="">
              {duplicates?.number?.voucher
                ? duplicateNumberSentence(t, (watchedInvoiceNumber || '').trim(), duplicates.number)
                : conflict?.message}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {conflict?.existing && (
              <Button
                variant="outline"
                onClick={() => router.push(`/supplier-invoices/${conflict.existing!.id}`)}
                disabled={isResolvingConflict}
              >
                {t('show_existing_invoice')}
              </Button>
            )}
            {conflict?.existing?.status === 'credited' && (
              <Button onClick={handleUncreditAndRetry} disabled={isResolvingConflict}>
                {isResolvingConflict ? t('processing') : t('uncredit_and_retry')}
              </Button>
            )}
            <Button variant="ghost" onClick={handlePickNewNumber} disabled={isResolvingConflict}>
              {t('use_different_number')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
