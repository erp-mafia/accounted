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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import BankTransactionPicker from '@/components/transactions/BankTransactionPicker'
import AccrualPeriodControl from '@/components/bookkeeping/AccrualPeriodControl'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import { suggestBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import {
  findReverseChargeAccountWarningRows,
  findUnflaggedForeignZeroVatRows,
} from '@/lib/vat/supplier-invoice-line-checks'
import { SLP_RATE, isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { roundOre } from '@/lib/money'
import {
  buildSupplierInvoicePayload,
  type SupplierInvoiceFormData,
  type SupplierInvoiceLineItem,
} from '@/lib/supplier-invoices/form-payload'
import { plantedRowTouched, snapshotPlantedRow } from '@/lib/supplier-invoices/planted-rows'
import { VatRateCell, RcRateSelect, AmountCell } from '@/components/supplier-invoices/supplier-invoice-cells'
import { useSupplierInvoiceData } from '@/components/supplier-invoices/use-supplier-invoice-data'
import { useInboxPrefill, type InboxItemData } from '@/components/supplier-invoices/use-inbox-prefill'
import { useSupplierInvoiceSubmit } from '@/components/supplier-invoices/use-supplier-invoice-submit'
import { ArrowLeft, Plus, Trash2, ChevronDown, Loader2, Lock, AlertCircle, AlertTriangle, MessageCircle, Link2, CalendarClock, Tags, FileText } from 'lucide-react'
import type { Supplier, InvoiceExtractionResult } from '@/types'

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
  default_expense_account: string
}

function RequiredMark() {
  return <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Accepts sv-SE formatted numbers ("12 345,67" with regular, no-break or
// narrow no-break group separators) as well as plain "12345.67".
function parseFlexibleNumber(s: string): number | null {
  const cleaned = s.replace(/[\s  ]/g, '').replace(',', '.')
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

const EMPTY_NEW_SUPPLIER: NewSupplierForm = {
  name: '',
  supplier_type: 'swedish_business',
  org_number: '',
  vat_number: '',
  address_line1: '',
  bankgiro: '',
  plusgiro: '',
  default_expense_account: '',
}

// Dense in-table inputs: leaf tier inside the Kontering table surface.
const CELL_INPUT_CLASS =
  'h-8 rounded-sm border-transparent bg-transparent px-2 text-[13px] hover:bg-secondary/60 focus-visible:bg-card'
// Row controls: 24x24 hit area (pre-approved dense-row exception to the 40px
// icon-button floor), revealed on hover/focus-within, always on coarse pointers.
const ROW_ICON_BTN_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground'

const UNDERLAG_ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const UNDERLAG_ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.webp'
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
    <div className="mb-3 text-[11px] uppercase tracking-[0.07em] text-muted-foreground">
      {children}
    </div>
  )
}

export interface NewSupplierInvoiceFormProps {
  /** Invoice-inbox item to convert; prefills the form from its AI extraction. */
  inboxItemId?: string | null
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
}

export default function NewSupplierInvoiceForm({
  inboxItemId = null,
  bare = false,
  onCreated,
  onCancel,
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
    oreRounding,
    setOreRounding,
    dimensionsEnabled,
    vatRegistered,
    periods,
    periodsLoaded,
  } = useSupplierInvoiceData()

  const [defaultDims, setDefaultDims] = useState<Record<string, string>>({})
  const [showNewSupplier, setShowNewSupplier] = useState(false)
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false)
  const [pendingSupplierSelect, setPendingSupplierSelect] = useState<string | null>(null)
  const [newSupplier, setNewSupplier] = useState<NewSupplierForm>(EMPTY_NEW_SUPPLIER)
  const [documentFiles, setDocumentFiles] = useState<UploadedFile[]>([])
  const documentFilesRef = useRef<UploadedFile[]>([])
  const createFinishedRef = useRef(false)
  const invoiceNumberInputRef = useRef<HTMLInputElement | null>(null)

  // Dokument-först state: a standalone upload routed through the invoice-inbox
  // pipeline gets an inbox item id (extraction + convert endpoint); a fallback
  // upload through /api/documents stays a plain attached document.
  const [uploadedInboxItemId, setUploadedInboxItemId] = useState<string | null>(null)
  const uploadedInboxItemIdRef = useRef<string | null>(null)
  const [extractionPhase, setExtractionPhase] = useState<'idle' | 'processing' | 'done'>('idle')
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

  // Pre-submit duplicate advisory (change 3): debounced lookup against
  // GET /api/supplier-invoices/exists; the create route's 409 stays the backstop.
  const [duplicateWarning, setDuplicateWarning] = useState<{
    number: string
    existingId: string | null
  } | null>(null)
  const duplicateSeqRef = useRef(0)

  // Total cross-check (change 2): client-only compare, never in the payload.
  const [fakturaTotalStr, setFakturaTotalStr] = useState('')

  // Shell state
  const [forvalOpen, setForvalOpen] = useState(false)
  const [supplierMenuOpen, setSupplierMenuOpen] = useState(false)
  const supplierTriggerRef = useRef<HTMLButtonElement | null>(null)
  const entryInputRef = useRef<HTMLInputElement | null>(null)
  const [entryResetKey, setEntryResetKey] = useState(0)
  const amountInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const [pendingAmountFocus, setPendingAmountFocus] = useState<number | null>(null)
  const accountInputRefs = useRef<Record<number, HTMLInputElement | null>>({})

  const { register, control, handleSubmit, watch, setValue, getValues, reset, formState: { isDirty } } = useForm<FormData>({
    defaultValues: {
      supplier_id: '',
      supplier_invoice_number: '',
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: '',
      delivery_date: '',
      currency: 'SEK',
      exchange_rate: '',
      reverse_charge: false,
      payment_reference: '',
      notes: '',
      paid_with_private_funds: false,
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
    // A standalone upload that went through the inbox pipeline created an
    // inbox item alongside the document: clean up both (same orphan-cleanup
    // contract as the plain path; the item DELETE 409s if it was converted).
    const itemId = uploadedInboxItemIdRef.current
    if (itemId) {
      void fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`, {
        method: 'DELETE',
        keepalive: true,
      })
    }
    for (const file of documentFilesRef.current) {
      if (file.status === 'uploaded' && file.id) {
        void fetch(`/api/documents/${file.id}`, { method: 'DELETE', keepalive: true })
      }
    }
  }, [inboxItemId])

  const { fields, append, remove, replace } = useFieldArray({ control, name: 'items' })
  const watchedItems = watch('items')
  const watchedSupplierId = watch('supplier_id')
  const watchedCurrency = watch('currency')
  const watchedExchangeRate = watch('exchange_rate')
  const watchedPaidPrivately = watch('paid_with_private_funds')
  const watchedReverseCharge = watch('reverse_charge')
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
  } = useInboxPrefill({
    inboxItemId,
    suppliersLoaded,
    suppliers,
    setValue,
    replace,
    reset,
    getValues,
    toast,
    t,
    onFieldPrefilled: handleFieldPrefilled,
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
  // only posted at registration time under the accrual method or when the
  // invoice is marked paid privately: cash method books at payment, so an
  // out-of-period date is fine there and we stay quiet. periodsLoaded gates the
  // warning so it never flashes before the fiscal periods have been fetched.
  const willBookAtRegistration = accountingMethod === 'accrual' || watchedPaidPrivately
  const invoiceDateOutsidePeriod =
    periodsLoaded &&
    !!watchedInvoiceDate &&
    !periods.some((p) => watchedInvoiceDate >= p.period_start && watchedInvoiceDate <= p.period_end)
  const showNoPeriodWarning = willBookAtRegistration && invoiceDateOutsidePeriod

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
    if (supplier.supplier_type === 'eu_business') {
      setValue('reverse_charge', true)
    }

    // No supplier default: fall back to the company's own booking history for
    // this counterparty (the same tiered matcher the booking flows use). Fills
    // empty rows only, never a generic seed, and only from expense-shaped
    // templates (P&L cost on debit, settlement on credit; the 4-8 gate keeps
    // private/balance-sheet templates like 2013 or 1630 out). Best-effort: on
    // any miss the rows simply stay blank, exactly as before.
    if (!supplier.default_expense_account && supplier.name?.trim()) {
      let cancelled = false
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
          if (!debit || !/^[4-8]/.test(debit) || !credit || !credit.startsWith('19')) return
          requestAccountFill(debit, match.template.counterparty_name)
        } catch {
          // Prefill is best-effort; the rows stay blank.
        }
      })()
      return () => { cancelled = true }
    }
    return undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSupplierId, suppliers])

  function computeDueDate(invoiceDate: string, days: number): string {
    const due = new Date(invoiceDate)
    due.setDate(due.getDate() + days)
    return due.toISOString().split('T')[0]
  }

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
      if (invoiceDate) {
        const due = computeDueDate(invoiceDate, days)
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
    if (days && days > 0 && watchedInvoiceDate) {
      const due = computeDueDate(watchedInvoiceDate, days)
      setValue('due_date', due)
      lastAutoDueRef.current = due
      setDueDateCaption({ type: 'terms', days })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedInvoiceDate])

  // Pre-submit duplicate advisory (change 3): debounced, sequence-guarded and
  // purely advisory: the create route's structured 409 stays the enforcement
  // point, and the exists endpoint mirrors the unique index's
  // credited/reversed exclusion so re-issues never warn.
  useEffect(() => {
    const supplierId = watchedSupplierId
    const number = (watchedInvoiceNumber || '').trim()
    if (!supplierId || !number) {
      // Advance the seq so an in-flight exists response cannot resurrect the
      // warning under a field the user just cleared.
      duplicateSeqRef.current += 1
      setDuplicateWarning(null)
      return
    }
    const seq = ++duplicateSeqRef.current
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/supplier-invoices/exists?supplier_id=${encodeURIComponent(supplierId)}&number=${encodeURIComponent(number)}`,
        )
        if (!res.ok) return
        const json = await res.json()
        if (duplicateSeqRef.current !== seq) return
        setDuplicateWarning(
          json?.data?.exists
            ? { number, existingId: json.data.existing?.id ?? null }
            : null,
        )
      } catch {
        // Advisory only; the 409 backstop still catches real duplicates.
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [watchedSupplierId, watchedInvoiceNumber])

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
    if (!currentDesc && accountNumber.length === 4) {
      const desc = getAccountDescription(accountNumber)
      if (desc) setValue(`items.${index}.description`, desc.name)
    }
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
    const description =
      accountNumber.length === 4 ? getAccountDescription(accountNumber)?.name ?? '' : ''
    const index = getValues('items').length
    append({
      description,
      amount: 0,
      account_number: accountNumber,
      vat_rate: vatRate,
      reverse_charge_rate: 0.25,
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
          setValue(`items.${index}.amount`, roundOre(item.amount * (1 + item.vat_rate)))
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
          <Button type="button" variant="ghost" size="sm" onClick={() => setSlp(index, false)}>
            {t('slp_remove_action')}
          </Button>
        </div>
      )
    }
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3"
      >
        <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <p className="flex-1 text-sm">
          {t('slp_hint', { amount: formatAmount(slpAmount) })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setSlp(index, true)}
        >
          {t('slp_add_action')}
        </Button>
      </div>
    )
  }

  // --- Dimension tagging (kostnadsställe/projekt, dimensions PR7) ---
  // Mirrors the accrual pattern: a defined (possibly empty) bag on the item
  // means the row's panel is open; closing clears the bag entirely so the
  // payload never carries a stale override.
  function setDefaultDimension(dimNo: string, code: string | null) {
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
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
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
        idPrefix={idPrefix}
        value={{
          start: item.accrual_period_start ?? '',
          end: item.accrual_period_end ?? '',
          balanceAccount: item.accrual_balance_account || '1790',
        }}
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

  const itemTotals = (watchedItems || []).map((item) => {
    const lineTotal = Math.round((item.amount || 0) * 100) / 100
    // Reverse charge: VAT is self-assessed at reverse_charge_rate (25% default),
    // not the line's vat_rate (which is 0: the supplier charged nothing).
    const effectiveRate = watchedReverseCharge ? (item.reverse_charge_rate ?? 0.25) : (item.vat_rate || 0)
    const vatAmount = Math.round(lineTotal * effectiveRate * 100) / 100
    return { lineTotal, vatAmount }
  })
  const subtotal = itemTotals.reduce((sum, t) => sum + t.lineTotal, 0)
  const totalVat = itemTotals.reduce((sum, t) => sum + t.vatAmount, 0)
  // Reverse charge: supplier never invoices VAT, so it doesn't roll into the
  // payable total. The VAT is still accounted for via 2614 / 2645 in
  // bookkeeping: the line stays in the breakdown for transparency.
  const payableVat = watchedReverseCharge ? 0 : totalVat
  const total = Math.round((subtotal + payableVat) * 100) / 100

  // Öresavrundning live preview: same helper as the detail page. Display-only;
  // the registered amount and the booked verifikat keep the exact öre.
  const displayRounding = getDisplayTotal(
    { total, currency: watchedCurrency || 'SEK', ore_rounding: oreRounding },
    { ore_rounding: false },
  )

  // Total cross-check (change 2): client-only compare against the displayed
  // payable; a mismatch renders field-adjacent, never blocks, never travels.
  const enteredFakturaTotal = parseFlexibleNumber(fakturaTotalStr)
  const crosscheckDiff =
    enteredFakturaTotal == null ? null : roundOre(enteredFakturaTotal - displayRounding.displayed)
  const crosscheckMatches = crosscheckDiff != null && Math.abs(crosscheckDiff) <= 0.005

  // Show the AI-suggested supplier card when we have an extraction, the AI
  // surfaced a supplier name, and we couldn't match it to an existing record.
  const showAISupplierHint =
    !!extractedData?.supplier?.name &&
    !hasMatchedSupplier &&
    !watchedSupplierId

  function openSupplierDialogPrefilled() {
    setNewSupplier({
      name: extractedData?.supplier?.name || '',
      supplier_type: 'swedish_business',
      org_number: extractedData?.supplier?.orgNumber || '',
      vat_number: extractedData?.supplier?.vatNumber || '',
      address_line1: extractedData?.supplier?.address || '',
      bankgiro: extractedData?.supplier?.bankgiro || '',
      plusgiro: extractedData?.supplier?.plusgiro || '',
      default_expense_account: '',
    })
    setShowNewSupplier(true)
  }

  function openSupplierDialogBlank() {
    setNewSupplier(EMPTY_NEW_SUPPLIER)
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
    if (newSupplier.default_expense_account) payload.default_expense_account = newSupplier.default_expense_account

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

  function afterUploadExtraction(extracted: InvoiceExtractionResult | null) {
    setExtractionPhase('done')
    if (extracted?.totals?.total != null) {
      setFakturaTotalStr(formatAmount(extracted.totals.total))
      markSettled('faktura_total')
    }
  }

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
    afterUploadExtraction(item.extracted_data)
  }

  function applyPendingExtraction() {
    const item = pendingExtraction
    if (!item) return
    setPendingExtraction(null)
    applyInboxItem(item)
    afterUploadExtraction(item.extracted_data)
  }

  async function pollExtraction(itemId: string, documentId: string) {
    const token = ++extractionPollTokenRef.current
    const startedAt = Date.now()
    while (Date.now() - startedAt < 90_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (extractionPollTokenRef.current !== token) return
      try {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`)
        if (!res.ok) break
        const { data } = await res.json()
        if (extractionPollTokenRef.current !== token) return
        if (data?.status !== 'processing') {
          if (hasExtractionContent(data?.extracted_data)) {
            applyExtractionIfPristine({
              id: itemId,
              extracted_data: data.extracted_data,
              matched_supplier_id: data.matched_supplier_id ?? null,
              document_id: documentId,
            })
          } else {
            // Extraction failed or read nothing: keep the plain attachment.
            setExtractionPhase('idle')
          }
          return
        }
      } catch {
        break
      }
    }
    if (extractionPollTokenRef.current === token) setExtractionPhase('idle')
  }

  async function uploadPlainDocument(entry: UploadedFile) {
    const formData = new FormData()
    formData.append('file', entry.file)
    formData.append('upload_source', 'file_upload')
    try {
      const res = await fetch('/api/documents', { method: 'POST', body: formData })
      let result: { data?: { id?: string }; error?: unknown } = {}
      try {
        result = await res.json()
      } catch {
        setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_upload_failed') }])
        return
      }
      if (!res.ok || result.error || !result.data?.id) {
        setDocumentFiles([{ ...entry, status: 'error', error: t('underlag_upload_failed') }])
        return
      }
      setDocumentFiles([{ ...entry, status: 'uploaded', id: result.data.id }])
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
    if (!UNDERLAG_ACCEPTED_TYPES.includes(file.type)) {
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

    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
        method: 'POST',
        body: formData,
      })
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
    })
  }

  // An upload that went through the inbox pipeline submits through the same
  // convert endpoint as an inbox arrival: document linking and the item's
  // created_supplier_invoice_id stamp come for free, and the inbox never
  // shows an already-registered document as pending.
  const effectiveInboxItemId = inboxItemId ?? uploadedInboxItemId

  function focusMissingField(
    field: 'supplier' | 'invoice_number' | 'rows' | 'row_account',
    rowIndex?: number,
  ) {
    if (field === 'supplier') {
      setSupplierMenuOpen(true)
      supplierTriggerRef.current?.focus()
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
    setPendingTransactionId,
    submitModeRef,
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
    onMissingField: focusMissingField,
  })

  async function discardUploadedDocument() {
    extractionPollTokenRef.current += 1
    const itemId = uploadedInboxItemId
    if (itemId) {
      try {
        await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}`, { method: 'DELETE' })
      } catch {
        // Best-effort cleanup.
      }
    }
    const ids = documentFiles
      .filter((file) => file.status === 'uploaded' && file.id)
      .map((file) => file.id as string)
    await Promise.allSettled(
      ids.map((documentId) => fetch(`/api/documents/${documentId}`, { method: 'DELETE' })),
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
  const underlagAttached = Boolean(inboxItemId || uploadedDocumentId)

  const detailsFilled = Boolean((watchedInvoiceNumber || '').trim() && watchedInvoiceDate)

  // Next-step line (the page's ONLY ochre line): same predicates and order as
  // the submit-time checks in useSupplierInvoiceSubmit, so the always-enabled
  // primary's focus routing and this line always agree.
  type MissingField = 'supplier' | 'invoice_number' | 'rows' | 'row_account'
  const nextStep = ((): { field: MissingField; rowIndex?: number; label: string } | null => {
    if (!watchedSupplierId) {
      return { field: 'supplier', label: t('next_step_supplier') }
    }
    if (!(watchedInvoiceNumber || '').trim()) {
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
    return null
  })()
  const readyLineText =
    watchedPaidPrivately || isEF
      ? willBookAtRegistration
        ? t('ready_line_register')
        : t('ready_line_register_cash')
      : t('ready_line_review')

  const forvalChips: string[] = [
    willBookAtRegistration ? t('forval_books_at_registration') : t('forval_books_at_payment'),
  ]
  if (watchedPaidPrivately) forvalChips.push(t('chip_paid_privately'))
  if (watchedReverseCharge) forvalChips.push(t('reverse_charge_label'))
  if ((watchedCurrency || 'SEK') !== 'SEK') {
    forvalChips.push(
      watchedExchangeRate
        ? t('chip_currency_rate', { currency: watchedCurrency, rate: watchedExchangeRate })
        : watchedCurrency,
    )
  }
  if ((watchedCurrency || 'SEK') === 'SEK' && !oreRounding) forvalChips.push(t('chip_ore_rounding_off'))
  if (watchedDeliveryDate) forvalChips.push(t('chip_delivery_date', { date: formatDate(watchedDeliveryDate) }))
  if ((watchedNotes || '').trim()) forvalChips.push(t('chip_notes'))
  if (dimensionsEnabled && defaultDimsSummary) forvalChips.push(defaultDimsSummary)

  const underlagCaption = inboxItemId
    ? null
    : extractionPhase === 'done'
      ? t('underlag_caption_done')
      : underlagFile?.status === 'uploaded' && extractionPhase === 'idle'
        ? t('underlag_caption_attached')
        : t('underlag_caption_default')

  const primaryLabel = watchedPaidPrivately
    ? t('register_expense')
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
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display text-2xl leading-8 tracking-tight">{t('page_title')}</h1>
          </div>
        </div>
      )}

      {isLoadingInbox && (
        <Card className="mb-6">
          <CardContent className="py-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('loading_inbox')}
          </CardContent>
        </Card>
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="divide-y divide-border">
          {/* ── Underlag (first: dokument-först) ─────────────────── */}
          <section className="pb-6">
            <SectionLabel>
              {t('section_underlag')}
              <span className="ml-2 normal-case tracking-normal">({t('underlag_recommended')})</span>
              {underlagAttached && (
                <span className="ml-2 normal-case tracking-normal text-success">
                  {'✓'} {t('mark_attached')}
                </span>
              )}
            </SectionLabel>
            {inboxItemId ? (
              <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-[13px] text-muted-foreground">
                <FileText className="h-4 w-4 shrink-0" />
                {t('underlag_caption_inbox')}
              </div>
            ) : underlagFile ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px]">{underlagFile.fileName}</p>
                    {(underlagFile.status === 'uploading' || extractionPhase === 'processing') && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {underlagFile.status === 'uploading'
                          ? t('underlag_uploading')
                          : t('underlag_processing')}
                      </p>
                    )}
                    {underlagFile.status === 'error' && (
                      <p className="text-xs text-destructive">{underlagFile.error}</p>
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
                  accept={UNDERLAG_ACCEPT_ATTR}
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
              <RequiredMark />
              {watchedSupplierId && (
                <span className="ml-2 normal-case tracking-normal text-success">
                  {'✓'} {t('mark_selected')}
                </span>
              )}
            </SectionLabel>

            {showAISupplierHint && (
              <div className="mb-3 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <MessageCircle className="h-5 w-5 text-primary shrink-0 mt-0.5" />
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
                  <Button type="button" size="sm" onClick={openSupplierDialogPrefilled}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('create_and_select')}
                  </Button>
                </div>
              </div>
            )}

            <DropdownMenu open={supplierMenuOpen} onOpenChange={setSupplierMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  ref={supplierTriggerRef}
                  className={cn(
                    'w-full rounded-lg border border-border px-4 py-4 text-left transition-colors hover:bg-secondary/60',
                    settledFields.has('supplier_id') && 'prefill-settle',
                  )}
                  aria-haspopup="menu"
                  aria-expanded={supplierMenuOpen}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span
                      className={cn(
                        'font-display text-lg leading-snug',
                        selectedSupplier ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {selectedSupplier?.name ?? t('supplier_placeholder')}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </span>
                  {selectedSupplier?.org_number && (
                    <span className="mt-1 block text-[13px] text-muted-foreground">
                      {t('org_number_prefix', { number: selectedSupplier.org_number })}
                    </span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-80 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
                onCloseAutoFocus={(e) => {
                  // Picking a supplier routes focus to the invoice-number
                  // field; the menu's default close behavior would yank it
                  // back to the trigger.
                  e.preventDefault()
                }}
              >
                {suppliers.length === 0 && (
                  <div className="px-2 py-2 text-[13px] text-muted-foreground">
                    {t('no_suppliers_yet')}
                  </div>
                )}
                {suppliers.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => {
                      setValue('supplier_id', s.id, { shouldDirty: true })
                      requestAnimationFrame(() => invoiceNumberInputRef.current?.focus())
                    }}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{s.name}</div>
                      {s.org_number && (
                        <div className="text-xs text-muted-foreground">
                          {t('org_number_prefix', { number: s.org_number })}
                        </div>
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
                {/* No separator over an empty list: it reads as a stray line. */}
                {suppliers.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={openSupplierDialogBlank} className="text-muted-foreground">
                  {t('add_new_supplier')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </section>

          {/* ── Fakturauppgifter ─────────────────────────────────── */}
          <section className="py-6">
            <SectionLabel>
              {t('section_details')}
              <RequiredMark />
              {detailsFilled && (
                <span className="ml-2 normal-case tracking-normal text-success">
                  {'✓'} {t('mark_filled')}
                </span>
              )}
            </SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-invoice-number" className="text-xs font-normal text-muted-foreground">
                    {t('supplier_invoice_number_label')}
                    <RequiredMark />
                  </Label>
                  <AiFilledIndicator active={aiFlags.invoiceNumber} label="AI-fyllt" />
                </div>
                {(() => {
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
                })()}
                {duplicateWarning && (
                  <p className="text-xs text-destructive" data-ph-mask="">
                    {t('duplicate_warning_line', { number: duplicateWarning.number })}
                    {duplicateWarning.existingId && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="underline underline-offset-2"
                          onClick={() => router.push(`/supplier-invoices/${duplicateWarning.existingId}`)}
                        >
                          {t('duplicate_warning_link')}
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-invoice-date" className="text-xs font-normal text-muted-foreground">
                    {t('invoice_date_label')}
                    <RequiredMark />
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
                    {supplierHasGiro && (
                      <p className="text-xs text-muted-foreground">{t('ocr_payment_file_caption')}</p>
                    )}
                  </div>
                </>
              )}
            </div>

            {showNoPeriodWarning && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
              >
                <AlertCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 text-sm text-destructive">
                  <p className="font-medium">{t('no_period_warning', { date: watchedInvoiceDate })}</p>
                  <p className="mt-0.5">{t('no_period_help')}</p>
                </div>
              </div>
            )}
          </section>

          {/* ── Kontering ────────────────────────────────────────── */}
          <section className="py-6">
            <SectionLabel>
              {t('section_accounting')}
              <RequiredMark />
              {fields.length > 0 && (
                <span className="ml-2 normal-case tracking-normal">
                  {t('rows_count', { count: fields.length })}
                </span>
              )}
            </SectionLabel>

            {templateAccountNote &&
              (watchedItems ?? []).some((r) => r.account_number === templateAccountNote.account) && (
                <p className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
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
                className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3"
              >
                <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
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
                className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3"
              >
                <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
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
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b border-border text-left">
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
                            slpRowVisible(index)
                            ? 'border-0'
                            : 'border-b border-border',
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
                              {watchedReverseCharge ? (
                                <Controller
                                  name={`items.${index}.reverse_charge_rate`}
                                  control={control}
                                  render={({ field: f }) => (
                                    <RcRateSelect value={f.value ?? 0.25} onChange={f.onChange} />
                                  )}
                                />
                              ) : (
                                <Controller
                                  name={`items.${index}.vat_rate`}
                                  control={control}
                                  render={({ field: f }) => (
                                    <VatRateCell value={f.value} onChange={f.onChange} />
                                  )}
                                />
                              )}
                            </td>
                            <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                              {formatAmount(itemTotals[index]?.vatAmount ?? 0)}
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
                                <Tags
                                  className={cn(
                                    'h-3.5 w-3.5',
                                    isDimOpen(index) ? 'text-foreground' : undefined,
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
                                <CalendarClock
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
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </td>
                      </tr>
                      {canUseAccrual && isAccrualOpen(index) && (
                        <tr className={cn(dimensionsEnabled && isDimOpen(index) ? 'border-0' : 'border-b border-border')}>
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderAccrualPanel(index, `accrual-${index}`)}
                          </td>
                        </tr>
                      )}
                      {dimensionsEnabled && isDimOpen(index) && (
                        <tr className={cn(slpRowVisible(index) ? 'border-0' : 'border-b border-border')}>
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderDimensionsPanel(index)}
                          </td>
                        </tr>
                      )}
                      {slpRowVisible(index) && (
                        <tr className="border-b border-border">
                          <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                            {renderSlpPanel(index)}
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
                    <td className="py-2 pr-2 italic text-muted-foreground/50">
                      {t('ghost_description')}
                    </td>
                    <td className="py-2 pr-2 text-right italic tabular-nums text-muted-foreground/50">
                      0
                    </td>
                    {vatColsVisible && (
                      <>
                        <td className="py-2 pr-2 italic tabular-nums text-muted-foreground/50">
                          25 %
                        </td>
                        <td className="py-2 pr-2 text-right italic text-muted-foreground/50">-</td>
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
            {forvalOpen && (
              <div className="mt-4 border-t border-border">
                <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]">
                  <label htmlFor="paid_with_private_funds" className="cursor-pointer">
                    {t('paid_privately_label')}
                    <span className="block text-xs text-muted-foreground">
                      {isEF ? t('paid_privately_help_ef') : t('paid_privately_help_ab')}
                    </span>
                  </label>
                  <Controller
                    name="paid_with_private_funds"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="paid_with_private_funds"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]">
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
                      <Switch id="reverse_charge" checked={field.value} onCheckedChange={field.onChange} />
                    )}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]">
                  <span>{t('currency_label')}</span>
                  <Controller
                    name="currency"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
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
                  <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]">
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
                  <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]">
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
                <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]">
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
                {dimensionsEnabled && (
                  <div className="border-b border-border py-3 text-[13px]">
                    <span>{t('row_dimensions_title')}</span>
                    <div className="mt-2 max-w-md">
                      <LineDimensionFields
                        dimensions={defaultDims}
                        onChange={setDefaultDimension}
                        inputClassName="h-8"
                      />
                    </div>
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
                <div className="flex items-baseline justify-between border-b border-border py-2 text-[13px]">
                  <span className="text-muted-foreground">{t('net_excl_vat')}</span>
                  <span className="tabular-nums">{formatCurrency(subtotal, watchedCurrency)}</span>
                </div>
                <div className="flex items-baseline justify-between border-b border-border py-2 text-[13px]">
                  <span className="text-muted-foreground">
                    {watchedReverseCharge ? t('vat_reverse_charge') : t('vat_label_short')}
                  </span>
                  <span className="tabular-nums">{formatCurrency(totalVat, watchedCurrency)}</span>
                </div>
              </>
            )}
            {displayRounding.applies && (
              <div className="flex items-baseline justify-between border-b border-border py-2 text-[13px]">
                <span className="text-muted-foreground">{t('ore_rounding_label')}</span>
                <span className="tabular-nums">
                  {formatCurrency(displayRounding.roundingDelta, watchedCurrency)}
                </span>
              </div>
            )}
            <div className="flex items-baseline justify-between pt-4">
              <span className="font-display text-lg">{t('total_payable_label')}</span>
              <span className="font-display text-xl tabular-nums">
                {formatCurrency(displayRounding.displayed, watchedCurrency)}
              </span>
            </div>

            {/* Total cross-check (client-only, never sent) */}
            <div className="mt-4 flex items-center justify-between gap-4">
              <Label htmlFor="si-faktura-total" className="text-[13px] font-normal text-muted-foreground">
                {t('crosscheck_label')}{' '}
                <span className="text-muted-foreground">({t('crosscheck_optional')})</span>
              </Label>
              <Input
                id="si-faktura-total"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                className={cn(
                  'h-8 w-32 text-right tabular-nums',
                  settledFields.has('faktura_total') && 'prefill-settle',
                )}
                value={fakturaTotalStr}
                onChange={(e) => setFakturaTotalStr(e.target.value)}
                onBlur={() => {
                  const parsed = parseFlexibleNumber(fakturaTotalStr)
                  if (parsed != null) setFakturaTotalStr(formatAmount(parsed))
                }}
              />
            </div>
            {crosscheckDiff != null && (
              <p
                className={cn(
                  'mt-2 text-right text-xs',
                  crosscheckMatches ? 'text-success' : 'text-destructive',
                )}
              >
                {crosscheckMatches
                  ? t('crosscheck_match')
                  : t('crosscheck_diff', {
                      diff:
                        (crosscheckDiff > 0 ? '+' : '') +
                        formatCurrency(crosscheckDiff, watchedCurrency),
                    })}
              </p>
            )}

            {/* AI totals comparison: only when extracted */}
            {extractedData?.totals && (extractedData.totals.subtotal != null || extractedData.totals.total != null) && (
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <span className="text-muted-foreground">{t('ai_totals_label')}</span>
                {extractedData.totals.subtotal != null && (
                  <span className="px-2 py-1 rounded-sm bg-muted tabular-nums">
                    {t('ai_net', { amount: formatAmount(extractedData.totals.subtotal) })}
                  </span>
                )}
                {extractedData.totals.vatAmount != null && (
                  <span className="px-2 py-1 rounded-sm bg-muted tabular-nums">
                    {t('ai_vat', { amount: formatAmount(extractedData.totals.vatAmount) })}
                  </span>
                )}
                {extractedData.totals.total != null && (
                  <span className="px-2 py-1 rounded-sm bg-muted tabular-nums">
                    {t('ai_total', { amount: formatAmount(extractedData.totals.total) })}
                  </span>
                )}
              </div>
            )}

            {/* The page's single ochre line: what stands between the user and
                a registered invoice, sage once nothing does. */}
            <p
              aria-live="polite"
              className={cn('pt-6 text-[12.5px]', nextStep ? 'text-attn' : 'text-success')}
            >
              {nextStep ? (
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
              ) : (
                readyLineText
              )}
            </p>
          </section>
        </div>

        {/* ── Sticky action bar (binds to the dialog scroll container in bare
            mode, to the page panel scroll on the standalone page) ── */}
        <div
          className={cn(
            'sticky bottom-0 z-10 mt-6 border-t border-border bg-background',
            bare && '-mx-6 -mb-6 rounded-b-xl px-6',
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="whitespace-nowrap text-[13px] text-muted-foreground">
              {t('total_label')}
              <strong className="ml-2 text-[15px] font-semibold tabular-nums text-foreground">
                {formatCurrency(displayRounding.displayed, watchedCurrency)}
              </strong>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                className={cn(QUIET_LINK_CLASS, 'disabled:opacity-50')}
                onClick={handleCancel}
                disabled={isSubmitting || documentUploadInProgress}
              >
                {t('cancel')}
              </button>
              {!watchedPaidPrivately && (
                <Button
                  type="submit"
                  variant="outline"
                  disabled={isSubmitting || !canWrite}
                  onClick={() => { submitModeRef.current = 'register_and_match' }}
                  title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                >
                  <Link2 className="mr-2 h-4 w-4" />
                  {t('register_and_mark_paid')}
                </Button>
              )}
              {/* Always enabled pre-click for writable users: clicking with
                  something missing routes focus to the first missing field
                  (submit-time hard blocks stay in onSubmit). Viewers keep the
                  disabled + lock treatment: authorization, not validation. */}
              <Button
                type="submit"
                disabled={isSubmitting || !canWrite}
                onClick={() => { submitModeRef.current = 'register' }}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('registering')}
                  </>
                ) : !canWrite ? (
                  <>
                    <Lock className="mr-2 h-4 w-4" />
                    {primaryLabel}
                  </>
                ) : (
                  primaryLabel
                )}
              </Button>
            </div>
          </div>
        </div>
      </form>

      {/* Review dialog (AB only: also shown after a bank transaction is picked
          in the register-and-match flow). */}
      {pendingData && !isEF && showReview && (() => {
        const reviewSupplier = suppliers.find((s) => s.id === pendingData.supplier_id)
        if (!reviewSupplier) return null
        return (
          <ConfirmationDialog
            open={showReview}
            onOpenChange={setShowReview}
            onConfirm={handleConfirm}
            isSubmitting={isSubmitting}
            title={t('review_dialog_title')}
            warningText={t('review_dialog_warning')}
            confirmLabel={t('review_dialog_confirm')}
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
              paymentReference={pendingData.payment_reference || undefined}
              items={pendingData.items}
              subtotal={subtotal}
              totalVat={totalVat}
              total={total}
            />
          </ConfirmationDialog>
        )
      })()}

      {/* Bank transaction picker for "Registrera & markera som betald" */}
      <BankTransactionPicker
        open={showBankPicker}
        onOpenChange={(open) => {
          setShowBankPicker(open)
          if (!open) {
            submitModeRef.current = 'register'
            setPendingTransactionId(null)
          }
        }}
        targetAmount={total}
        targetCurrency={watchedCurrency}
        onPick={handlePickTransaction}
      />

      {/* New supplier dialog */}
      <Dialog open={showNewSupplier} onOpenChange={setShowNewSupplier}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('new_supplier_dialog_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('new_supplier_name_label')}<RequiredMark /></Label>
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
            <Button onClick={handleCreateSupplier} disabled={isCreatingSupplier}>
              {isCreatingSupplier ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('creating')}
                </>
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
              <AlertCircle className="h-5 w-5 text-destructive" />
              {t('duplicate_dialog_title')}
            </DialogTitle>
            {/* data-ph-mask: the conflict message carries the invoice number */}
            <DialogDescription data-ph-mask="">{conflict?.message}</DialogDescription>
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
