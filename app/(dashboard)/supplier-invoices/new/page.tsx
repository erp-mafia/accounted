'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm, Controller, useFieldArray } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AiFilledIndicator from '@/components/ui/ai-filled-indicator'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency } from '@/lib/utils'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import BankTransactionPicker from '@/components/transactions/BankTransactionPicker'
import { ArrowLeft, Plus, Trash2, ChevronDown, Loader2, Lock, AlertCircle, MessageCircle, Link2 } from 'lucide-react'
import type { Supplier, BASAccount, VatTreatment, EntityType, InvoiceExtractionResult, FiscalPeriod } from '@/types'

interface LineItem {
  description: string
  amount: number
  account_number: string
  vat_rate: number
  // Self-assessed VAT rate for omvänd skattskyldighet (0.25/0.12/0.06). Only
  // meaningful when reverse_charge is on; the line's vat_rate is then 0.
  reverse_charge_rate?: number
}

interface FormData {
  supplier_id: string
  supplier_invoice_number: string
  invoice_date: string
  due_date: string
  delivery_date: string
  currency: string
  exchange_rate: string
  reverse_charge: boolean
  payment_reference: string
  notes: string
  paid_with_private_funds: boolean
  items: LineItem[]
}

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

function inferVatTreatment(items: LineItem[], reverseCharge: boolean): VatTreatment {
  if (reverseCharge) return 'reverse_charge'

  const rates = new Set(items.map((i) => i.vat_rate))
  if (rates.size === 1) {
    const rate = rates.values().next().value!
    if (rate === 0.25) return 'standard_25'
    if (rate === 0.12) return 'reduced_12'
    if (rate === 0.06) return 'reduced_6'
    if (rate === 0) return 'exempt'
  }

  return 'standard_25'
}

// AI returns VAT as integer percent (25, 12, 6, 0). The form stores decimals.
function vatRateFromAi(rate: number | null | undefined): number {
  if (rate == null) return 0.25
  if (rate === 25) return 0.25
  if (rate === 12) return 0.12
  if (rate === 6) return 0.06
  return 0
}

function rateToPctString(rate: number): string {
  const pct = Math.round(rate * 10000) / 100
  return Number.isFinite(pct) ? String(pct) : ''
}

const VAT_RATE_PRESETS = [0.25, 0.12, 0.06, 0]

function VatRateCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTranslations('supplier_invoice_editor')
  const inputRef = useRef<HTMLInputElement>(null)
  // Local draft so the user can type "12," or "12." mid-keystroke without the
  // controlled input snapping back to a parsed integer.
  const [draft, setDraft] = useState(() => rateToPctString(value))

  // Re-sync from form value only when the field isn't focused — keeps AI
  // prefill / supplier defaults / dropdown picks flowing in without clobbering
  // active typing.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(rateToPctString(value))
    }
  }, [value])

  return (
    <div className="flex items-center gap-1">
      <div className="relative flex-1">
        <Input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(rateToPctString(value))}
          onChange={(e) => {
            const raw = e.target.value
            // Strict whitelist: digits with at most one decimal separator.
            // Blocks "2-22", "100-2", "1.2.3", letters, signs — the keystroke
            // is dropped before reaching the draft.
            if (raw !== '' && !/^\d*[.,]?\d*$/.test(raw)) return
            const normalized = raw.replace(',', '.')
            if (normalized === '' || normalized === '.') {
              setDraft(raw)
              onChange(0)
              return
            }
            const parsed = parseFloat(normalized)
            if (!Number.isFinite(parsed)) {
              setDraft(raw)
              return
            }
            const clamped = Math.min(100, Math.max(0, parsed))
            // Snap the draft back when the parsed value falls outside [0, 100]
            // so the input can never display a rate the form won't apply.
            setDraft(clamped === parsed ? raw : String(clamped))
            onChange(clamped / 100)
          }}
          className="text-right tabular-nums pr-6"
          aria-label={t('col_vat_rate')}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
          %
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t('vat_rate_presets_aria')}
          >
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[6rem]">
          {VAT_RATE_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset}
              onSelect={() => onChange(preset)}
              className="justify-end tabular-nums"
            >
              {Math.round(preset * 100)} %
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Self-assessment rate picker shown in place of the Momssats cell when an
// invoice is reverse charge. The supplier charges no VAT (the line vat_rate is
// 0); this is the Swedish statutory rate the buyer self-assesses at — 25%
// huvudregeln for EU services, 12%/6% for reduced-rated services (ML 6 kap 34 §).
function RcRateSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTranslations('supplier_invoice_editor')
  return (
    <Select value={String(value ?? 0.25)} onValueChange={(v) => onChange(parseFloat(v))}>
      <SelectTrigger className="h-9 tabular-nums" aria-label={t('col_rc_vat_rate')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0.25" className="tabular-nums">25 %</SelectItem>
        <SelectItem value="0.12" className="tabular-nums">12 %</SelectItem>
        <SelectItem value="0.06" className="tabular-nums">6 %</SelectItem>
      </SelectContent>
    </Select>
  )
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

export default function NewSupplierInvoicePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const inboxItemId = searchParams.get('inbox_item_id')
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_editor')

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

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [suppliersLoaded, setSuppliersLoaded] = useState(false)
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [entityType, setEntityType] = useState<EntityType>('enskild_firma')
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [periodsLoaded, setPeriodsLoaded] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [pendingData, setPendingData] = useState<FormData | null>(null)
  const [showNewSupplier, setShowNewSupplier] = useState(false)
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false)
  const [pendingSupplierSelect, setPendingSupplierSelect] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [newSupplier, setNewSupplier] = useState<NewSupplierForm>(EMPTY_NEW_SUPPLIER)

  // Inbox/AI state
  const [extractedData, setExtractedData] = useState<InvoiceExtractionResult | null>(null)
  const [originalExtracted, setOriginalExtracted] = useState<InvoiceExtractionResult | null>(null)
  const [hasMatchedSupplier, setHasMatchedSupplier] = useState(false)
  const [isLoadingInbox, setIsLoadingInbox] = useState(!!inboxItemId)
  const [hasPrefilled, setHasPrefilled] = useState(false)

  // Match-on-create state
  const [showBankPicker, setShowBankPicker] = useState(false)
  const [pendingTransactionId, setPendingTransactionId] = useState<string | null>(null)
  // The button's onClick and the form's onSubmit run in the same React event
  // batch, so a `useState`-backed submitMode would still hold the previous
  // render's value when onSubmit reads it. A ref bridges the two synchronous
  // handlers; the matching state mirror only drives the review-dialog UI.
  const submitModeRef = useRef<'register' | 'register_and_match'>('register')

  // Conflict state for duplicate-supplier-invoice-number
  const [conflict, setConflict] = useState<{
    message: string
    existing: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string | null } | null
  } | null>(null)
  const [isResolvingConflict, setIsResolvingConflict] = useState(false)
  const invoiceNumberInputRef = useRef<HTMLInputElement | null>(null)

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
      items: [{ description: '', amount: 0, account_number: '5010', vat_rate: 0.25, reverse_charge_rate: 0.25 }],
    },
  })

  useUnsavedChanges(isDirty)

  const { fields, append, remove, replace } = useFieldArray({ control, name: 'items' })
  const watchedItems = watch('items')
  const watchedSupplierId = watch('supplier_id')
  const watchedCurrency = watch('currency')
  const watchedPaidPrivately = watch('paid_with_private_funds')
  const watchedReverseCharge = watch('reverse_charge')
  // Watched values used to decide whether the AI-filled indicator should
  // still be visible. Once the user edits a field, its value no longer
  // matches what the extractor wrote, and the dot fades out.
  const watchedInvoiceNumber = watch('supplier_invoice_number')
  const watchedInvoiceDate = watch('invoice_date')
  const watchedDueDate = watch('due_date')
  const watchedPaymentReference = watch('payment_reference')
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
  // invoice is marked paid privately — cash method books at payment, so an
  // out-of-period date is fine there and we stay quiet. periodsLoaded gates the
  // warning so it never flashes before the fiscal periods have been fetched.
  const willBookAtRegistration = accountingMethod === 'accrual' || watchedPaidPrivately
  const invoiceDateOutsidePeriod =
    periodsLoaded &&
    !!watchedInvoiceDate &&
    !periods.some((p) => watchedInvoiceDate >= p.period_start && watchedInvoiceDate <= p.period_end)
  const showNoPeriodWarning = willBookAtRegistration && invoiceDateOutsidePeriod

  useEffect(() => {
    fetchSuppliers()
    fetchAccounts()
    fetchEntityType()
    fetchPeriods()
  }, [])

  // One-shot: load inbox item and prefill form. Runs after suppliers are
  // loaded so we can resolve matched_supplier_id to a real picker value.
  // Gate on `suppliersLoaded`, not `suppliers.length > 0` — otherwise the
  // effect never fires for users who haven't booked a supplier yet and
  // the "Laddar uppgifter från inkorgen…" spinner sticks forever.
  useEffect(() => {
    if (!inboxItemId || hasPrefilled || !suppliersLoaded) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${inboxItemId}`)
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          toast({
            title: t('inbox_load_failed_title'),
            description: json?.error || t('inbox_load_failed_description'),
            variant: 'destructive',
          })
          setIsLoadingInbox(false)
          return
        }

        const item = json.data as {
          id: string
          extracted_data: InvoiceExtractionResult | null
          matched_supplier_id: string | null
          document_id: string | null
        }
        const extracted = item.extracted_data
        if (!extracted) {
          setIsLoadingInbox(false)
          setHasPrefilled(true)
          return
        }

        setExtractedData(extracted)
        setOriginalExtracted(extracted)

        // Supplier
        if (item.matched_supplier_id && suppliers.find((s) => s.id === item.matched_supplier_id)) {
          setValue('supplier_id', item.matched_supplier_id)
          setHasMatchedSupplier(true)
        }

        // Scalar invoice fields
        if (extracted.invoice?.invoiceNumber) {
          setValue('supplier_invoice_number', extracted.invoice.invoiceNumber)
        }
        if (extracted.invoice?.invoiceDate) {
          setValue('invoice_date', extracted.invoice.invoiceDate)
        }
        if (extracted.invoice?.dueDate) {
          setValue('due_date', extracted.invoice.dueDate)
        }
        if (extracted.invoice?.paymentReference) {
          setValue('payment_reference', extracted.invoice.paymentReference)
        }
        if (extracted.invoice?.currency) {
          setValue('currency', extracted.invoice.currency)
        }

        // Line items: keep the single empty default if AI returned nothing,
        // otherwise replace it with the extracted lines.
        if (extracted.lineItems && extracted.lineItems.length > 0) {
          replace(
            extracted.lineItems.map((li) => ({
              description: li.description || '',
              amount: typeof li.lineTotal === 'number' ? li.lineTotal : 0,
              account_number: '5010',
              vat_rate: vatRateFromAi(li.vatRate),
            })),
          )
        }

        // Treat the AI prefill as the new baseline — otherwise the unsaved-
        // changes prompt fires the moment the user navigates away, even if
        // they didn't touch anything.
        reset(getValues())
        setHasPrefilled(true)
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('inbox_load_failed_title'),
          description: err instanceof Error ? err.message : t('unknown_error'),
          variant: 'destructive',
        })
      } finally {
        if (!cancelled) setIsLoadingInbox(false)
      }
    })()

    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxItemId, suppliersLoaded, suppliers])

  // Auto-fill due date and defaults when supplier is selected — but never
  // overwrite a value the AI already filled in for us.
  useEffect(() => {
    if (!watchedSupplierId) return
    const supplier = suppliers.find((s) => s.id === watchedSupplierId)
    if (!supplier) return

    const invoiceDate = watch('invoice_date')
    const currentDue = watch('due_date')
    if (invoiceDate && !currentDue) {
      const due = new Date(invoiceDate)
      due.setDate(due.getDate() + supplier.default_payment_terms)
      setValue('due_date', due.toISOString().split('T')[0])
    }
    if (supplier.default_expense_account && fields.length > 0) {
      // Only override the first row if it's still the seeded default (5010 with empty desc)
      const firstRow = watch('items.0')
      if (firstRow && (firstRow.account_number === '5010' || !firstRow.account_number) && !firstRow.description) {
        setValue('items.0.account_number', supplier.default_expense_account)
      }
    }
    if (supplier.default_currency && watch('currency') === 'SEK') {
      setValue('currency', supplier.default_currency)
    }
    if (supplier.supplier_type === 'eu_business') {
      setValue('reverse_charge', true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSupplierId, suppliers])

  // Auto-fetch Riksbanken exchange rate when currency switches to non-SEK and
  // the user hasn't typed a custom rate yet. Re-fetches when the invoice
  // date changes too. Never overwrites a user-entered rate. Reuses the
  // watchedInvoiceDate declared above for the AI-filled-indicator flag.
  // The "user has manually edited the rate" flag is scoped *per currency*.
  // Switching from EUR (rate 11.8 edited by hand) to USD must re-fetch — the
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
      // Currency switched — drop the previous currency's manual-edit flag.
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
        // Non-critical — user can type the rate manually.
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

  async function fetchSuppliers() {
    try {
      const res = await fetch('/api/suppliers')
      const { data } = await res.json()
      setSuppliers(data || [])
    } finally {
      setSuppliersLoaded(true)
    }
  }

  async function fetchAccounts() {
    const res = await fetch('/api/bookkeeping/accounts')
    const { data } = await res.json()
    setAccounts(data || [])
  }

  async function fetchEntityType() {
    try {
      const res = await fetch('/api/settings')
      const { data } = await res.json()
      if (data?.entity_type) setEntityType(data.entity_type)
      // Cash method books at payment, not registration — drives whether the
      // out-of-period warning is relevant (see willBookAtRegistration below).
      if (data?.accounting_method === 'cash' || data?.accounting_method === 'accrual') {
        setAccountingMethod(data.accounting_method)
      }
    } catch {
      // Default to enskild_firma / accrual
    }
  }

  async function fetchPeriods() {
    try {
      const res = await fetch('/api/bookkeeping/fiscal-periods')
      const { data } = await res.json()
      setPeriods(data || [])
    } catch {
      // Non-critical — the server still hard-blocks an out-of-period booking.
    } finally {
      setPeriodsLoaded(true)
    }
  }

  function handleAccountChange(index: number, accountNumber: string) {
    setValue(`items.${index}.account_number`, accountNumber)
    const currentDesc = watch(`items.${index}.description`)
    if (!currentDesc && accountNumber.length === 4) {
      const desc = getAccountDescription(accountNumber)
      if (desc) setValue(`items.${index}.description`, desc.name)
    }
  }

  const itemTotals = (watchedItems || []).map((item) => {
    const lineTotal = Math.round((item.amount || 0) * 100) / 100
    // Reverse charge: VAT is self-assessed at reverse_charge_rate (25% default),
    // not the line's vat_rate (which is 0 — the supplier charged nothing).
    const effectiveRate = watchedReverseCharge ? (item.reverse_charge_rate ?? 0.25) : (item.vat_rate || 0)
    const vatAmount = Math.round(lineTotal * effectiveRate * 100) / 100
    return { lineTotal, vatAmount }
  })
  const subtotal = itemTotals.reduce((sum, t) => sum + t.lineTotal, 0)
  const totalVat = itemTotals.reduce((sum, t) => sum + t.vatAmount, 0)
  // Reverse charge: supplier never invoices VAT, so it doesn't roll into the
  // payable total. The VAT is still accounted for via 2614 / 2645 in
  // bookkeeping — the line stays in the breakdown for transparency.
  const payableVat = watchedReverseCharge ? 0 : totalVat
  const total = Math.round((subtotal + payableVat) * 100) / 100

  // Show the AI-suggested supplier card when we have an inbox item, the AI
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
      setSuppliers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setPendingSupplierSelect(created.id)
      setHasMatchedSupplier(true)
      setShowNewSupplier(false)
      setNewSupplier(EMPTY_NEW_SUPPLIER)
      toast({ title: t('supplier_created_title'), description: created.name })
    }

    setIsCreatingSupplier(false)
  }

  function buildPayload(data: FormData) {
    const vatTreatment = inferVatTreatment(data.items, data.reverse_charge)
    // When paid privately, due_date is irrelevant — but the API still requires
    // a YYYY-MM-DD value. Default to invoice_date so the field passes validation.
    const dueDate = data.paid_with_private_funds && !data.due_date
      ? data.invoice_date
      : data.due_date
    return {
      supplier_id: data.supplier_id,
      supplier_invoice_number: data.supplier_invoice_number,
      invoice_date: data.invoice_date,
      due_date: dueDate,
      delivery_date: data.delivery_date || undefined,
      currency: data.currency,
      exchange_rate: data.exchange_rate ? parseFloat(data.exchange_rate) : undefined,
      vat_treatment: vatTreatment,
      reverse_charge: data.reverse_charge,
      payment_reference: data.payment_reference || undefined,
      notes: data.notes || undefined,
      paid_with_private_funds: data.paid_with_private_funds,
      items: data.items.map((item) => ({
        description: item.description,
        amount: item.amount,
        account_number: item.account_number,
        // Reverse charge: the supplier charges no VAT, so the line rate is 0 and
        // the self-assessed rate travels on reverse_charge_rate (25% default).
        vat_rate: data.reverse_charge ? 0 : item.vat_rate,
        reverse_charge_rate: data.reverse_charge ? (item.reverse_charge_rate ?? 0.25) : undefined,
      })),
    }
  }

  // Persist user edits back into the inbox item's extracted_data so the
  // inbox stays in sync with what was actually booked. Best-effort: a
  // failed PATCH never blocks the registration.
  async function patchInboxFieldsIfChanged(data: FormData) {
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

  // Single submit endpoint chooser — convert when we came from inbox, plain
  // POST otherwise. Both endpoints validate the same CreateSupplierInvoiceSchema.
  async function postCreate(data: FormData): Promise<{
    ok: boolean
    status: number
    result: {
      data?: { id: string; arrival_number: number }
      error?: string
      message?: string
      existing?: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string | null }
    }
  }> {
    const url = inboxItemId
      ? `/api/extensions/ext/invoice-inbox/items/${inboxItemId}/convert`
      : '/api/supplier-invoices'

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(data)),
    })
    const result = await res.json()
    return { ok: res.ok, status: res.status, result }
  }

  function onSubmit(data: FormData) {
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
      toast({ title: t('supplier_missing_title'), description: t('supplier_missing_description'), variant: 'destructive' })
      return
    }
    if (!data.supplier_invoice_number) {
      toast({ title: t('invoice_number_missing_title'), description: t('invoice_number_missing_description'), variant: 'destructive' })
      return
    }

    if (submitModeRef.current === 'register_and_match') {
      // Open the bank-transaction picker; actual create happens on pick.
      // For AB the review dialog is shown after a transaction is picked.
      setPendingData(data)
      setShowBankPicker(true)
      return
    }

    // Privately-paid skips the AB review dialog — the toggle itself is the
    // explicit user intent, and the resulting verifikat is just expense + VAT
    // against the owner account (2893/2018). Same path for EF.
    if (isEF || data.paid_with_private_funds) {
      setPendingData(data)
      handleDirectSubmit(data)
    } else {
      setPendingData(data)
      setShowReview(true)
    }
  }

  // EF: create + auto-approve, no review dialog. Privately-paid invoices land
  // here too and skip auto-approve since they're already in status='paid'.
  async function handleDirectSubmit(data: FormData) {
    setIsSubmitting(true)
    await patchInboxFieldsIfChanged(data)
    const { ok, status, result } = await postCreate(data)

    if (!ok) {
      handleCreateError(status, result)
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

    if (data.paid_with_private_funds) {
      toast({
        title: t('expense_registered_title'),
        description: t('arrival_number_label', { number: result.data.arrival_number }),
      })
      router.push(afterCreate())
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
      router.push(afterCreate(result.data.id))
    } else {
      toast({ title: t('invoice_registered_title'), description: t('arrival_number_label', { number: result.data.arrival_number }) })
      router.push(afterCreate())
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
      // Clear dirty state — see comment in handleDirectSubmit.
      reset(pendingData)

      if (pendingTransactionId) {
        const matchRes = await fetch(`/api/transactions/${pendingTransactionId}/match-supplier-invoice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplier_invoice_id: invoiceId }),
        })
        const matchResult = await matchRes.json()
        setPendingTransactionId(null)
        submitModeRef.current = 'register'

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

      router.push(afterCreate(invoiceId))
    } else {
      // Treat duplicate-number as a recoverable conflict; everything else as a hard error.
      if (status === 409 && result.error === 'duplicate_supplier_invoice_number') {
        setShowReview(false)
        setConflict({
          message: result.message || t('duplicate_default_message'),
          existing: result.existing ?? null,
        })
      } else {
        handleCreateError(status, result)
      }
    }
    setIsSubmitting(false)
  }

  // Shared error toast for non-conflict failures.
  function handleCreateError(
    status: number,
    result: { error?: string; message?: string },
  ) {
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
      router.push(afterCreate(result.data.id))
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
  // register flow — handleConfirm picks up the match step on confirmation.
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
      if (status === 409 && result.error === 'duplicate_supplier_invoice_number') {
        setConflict({
          message: result.message || t('duplicate_default_message'),
          existing: result.existing ?? null,
        })
      } else {
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
    submitModeRef.current = 'register'

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
    router.push(afterCreate(invoiceId))
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push(inboxItemId ? '/e/general/invoice-inbox' : '/supplier-invoices')}
          aria-label={inboxItemId ? t('back_aria_inbox') : t('back_aria')}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">{t('page_title')}</h1>
        </div>
      </div>

      {isLoadingInbox && (
        <Card>
          <CardContent className="py-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('loading_inbox')}
          </CardContent>
        </Card>
      )}

      {showAISupplierHint && (
        <Card className="border-primary/30 bg-primary/[0.02]">
          <CardContent className="py-4">
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
          </CardContent>
        </Card>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Section 1: Faktura */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('section_invoice')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Eget utlägg-toggle. När den är på bokas verifikatet direkt mot
                skuld till ägare (2893/2018) istället för leverantörsskuld (2440),
                och fakturan får status "Betalad" direkt. */}
            <div className="flex items-start gap-3 p-3 rounded-md border bg-muted/30">
              <Controller
                name="paid_with_private_funds"
                control={control}
                render={({ field }) => (
                  <Checkbox
                    id="paid_with_private_funds"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    className="mt-0.5"
                  />
                )}
              />
              <Label htmlFor="paid_with_private_funds" className="cursor-pointer flex-1">
                <span className="text-sm font-medium">{t('paid_privately_label')}</span>
                <span className="block text-[11px] text-muted-foreground font-normal mt-0.5">
                  {isEF ? t('paid_privately_help_ef') : t('paid_privately_help_ab')}
                </span>
              </Label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('supplier_label')}<RequiredMark /></Label>
                <Controller
                  name="supplier_id"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(v) => {
                        if (v === '__new__') {
                          openSupplierDialogBlank()
                        } else {
                          field.onChange(v)
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('supplier_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {suppliers.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                        ))}
                        <SelectItem value="__new__" className="text-primary font-medium">
                          {t('add_new_supplier')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('supplier_invoice_number_label')}<RequiredMark /></Label>
                  <AiFilledIndicator active={aiFlags.invoiceNumber} label="AI-fyllt" />
                </div>
                {(() => {
                  const { ref: rhfRef, ...rest } = register('supplier_invoice_number')
                  return (
                    <Input
                      placeholder={t('supplier_invoice_number_placeholder')}
                      {...rest}
                      ref={(el) => {
                        rhfRef(el)
                        invoiceNumberInputRef.current = el
                      }}
                    />
                  )
                })()}
              </div>
            </div>
            <div className={cn(
              'grid grid-cols-1 gap-4',
              watchedPaidPrivately ? 'sm:grid-cols-1' : 'sm:grid-cols-3',
            )}>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('invoice_date_label')}<RequiredMark /></Label>
                  <AiFilledIndicator active={aiFlags.invoiceDate} label="AI-fyllt" />
                </div>
                <Input type="date" {...register('invoice_date')} />
              </div>
              {!watchedPaidPrivately && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('due_date_label')}<RequiredMark /></Label>
                      <AiFilledIndicator active={aiFlags.dueDate} label="AI-fyllt" />
                    </div>
                    <Input type="date" {...register('due_date')} />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('payment_reference_label')}</Label>
                      <AiFilledIndicator
                        active={aiFlags.paymentReference}
                        label="AI-fyllt"
                      />
                    </div>
                    <Input placeholder={t('payment_reference_placeholder')} {...register('payment_reference')} />
                  </div>
                </>
              )}
            </div>

            {showNoPeriodWarning && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
              >
                <AlertCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 text-sm text-destructive">
                  <p className="font-medium">{t('no_period_warning', { date: watchedInvoiceDate })}</p>
                  <p className="mt-0.5">{t('no_period_help')}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 2: Kontering */}
        <Card>
          <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <CardTitle className="text-lg">{t('section_accounting')}</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() =>
                append({ description: '', amount: 0, account_number: '', vat_rate: 0.25, reverse_charge_rate: 0.25 })
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('add_row')}
            </Button>
          </CardHeader>
          <CardContent>
            {/* Valuta & moms — kept inline with the line items because they
                drive how each row is interpreted. Hidden defaults (SEK +
                normal moms) collapse to nothing so most users don't see this. */}
            <div className="mb-5 pb-5 border-b grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('currency_label')}</Label>
                <Controller
                  name="currency"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="h-9">
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
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('exchange_rate_label')} <span className="text-muted-foreground">{t('exchange_rate_to_sek')}</span>
                  </Label>
                  <Input
                    type="number"
                    step="0.0001"
                    inputMode="decimal"
                    placeholder={t('exchange_rate_placeholder')}
                    className="h-9 text-right tabular-nums"
                    {...register('exchange_rate', {
                      onChange: () => { userTouchedRateRef.current = true },
                    })}
                  />
                </div>
              )}
              <div
                className={cn(
                  'flex items-center gap-2',
                  watchedCurrency === 'SEK' ? 'sm:col-span-2' : ''
                )}
              >
                <Controller
                  name="reverse_charge"
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      id="reverse_charge"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <Label htmlFor="reverse_charge" className="text-xs cursor-pointer">
                  {t('reverse_charge_label')}
                  <span className="block text-[11px] text-muted-foreground font-normal mt-0.5">
                    {t('reverse_charge_help')}
                  </span>
                </Label>
              </div>
            </div>

            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="pb-2 w-28">{t('col_account')}</th>
                    <th className="pb-2">{t('col_description')}</th>
                    <th className="pb-2 w-32">{t('col_amount_excl')}</th>
                    <th className="pb-2 w-36">{watchedReverseCharge ? t('col_rc_vat_rate') : t('col_vat_rate')}</th>
                    <th className="pb-2 w-24 text-right">{watchedReverseCharge ? t('col_rc_vat') : t('col_vat')}</th>
                    <th className="pb-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <tr key={field.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-2">
                        <Controller
                          name={`items.${index}.account_number`}
                          control={control}
                          render={({ field: f }) => (
                            <AccountCombobox
                              value={f.value}
                              accounts={accounts}
                              onChange={(val) => handleAccountChange(index, val)}
                            />
                          )}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Controller
                          name={`items.${index}.description`}
                          control={control}
                          render={({ field }) => (
                            <Input
                              placeholder={t('description_placeholder')}
                              ref={field.ref}
                              value={field.value ?? ''}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                            />
                          )}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Controller
                          name={`items.${index}.amount`}
                          control={control}
                          render={({ field }) => (
                            <Input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              placeholder="0,00"
                              className="text-right tabular-nums"
                              value={field.value || ''}
                              onChange={(e) => field.onChange(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                            />
                          )}
                        />
                      </td>
                      <td className="py-2 pr-2">
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
                      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                        {formatAmount(itemTotals[index]?.vatAmount ?? 0)}
                      </td>
                      <td className="py-2 pt-3">
                        {fields.length > 1 && (
                          <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={t('remove_row_aria', { index: index + 1 })}>
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="sm:hidden space-y-4">
              {fields.map((field, index) => (
                <div key={field.id} className="border rounded-lg p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-muted-foreground">{t('row_label', { index: index + 1 })}</span>
                    {fields.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={t('remove_row_aria', { index: index + 1 })}>
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">{t('col_account')}</Label>
                    <Controller
                      name={`items.${index}.account_number`}
                      control={control}
                      render={({ field: f }) => (
                        <AccountCombobox value={f.value} accounts={accounts} onChange={(val) => handleAccountChange(index, val)} />
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">{t('col_description')}</Label>
                    <Controller
                      name={`items.${index}.description`}
                      control={control}
                      render={({ field }) => (
                        <Input
                          placeholder={t('description_placeholder')}
                          ref={field.ref}
                          value={field.value ?? ''}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                        />
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">{t('col_amount_excl')}</Label>
                      <Controller
                        name={`items.${index}.amount`}
                        control={control}
                        render={({ field }) => (
                          <Input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            placeholder="0,00"
                            className="text-right tabular-nums"
                            value={field.value || ''}
                            onChange={(e) => field.onChange(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                          />
                        )}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">{watchedReverseCharge ? t('col_rc_vat_rate') : t('col_vat_rate')}</Label>
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
                    </div>
                  </div>
                  <div className="pt-1 border-t flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{watchedReverseCharge ? t('col_rc_vat') : t('col_vat')}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatAmount(itemTotals[index]?.vatAmount ?? 0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* AI totals comparison — only when extracted */}
            {extractedData?.totals && (extractedData.totals.subtotal != null || extractedData.totals.total != null) && (
              <div className="mt-4 pt-4 border-t flex flex-wrap gap-2 text-xs">
                <span className="text-muted-foreground">{t('ai_totals_label')}</span>
                {extractedData.totals.subtotal != null && (
                  <span className="px-2 py-1 rounded bg-muted font-mono">
                    {t('ai_net', { amount: formatAmount(extractedData.totals.subtotal) })}
                  </span>
                )}
                {extractedData.totals.vatAmount != null && (
                  <span className="px-2 py-1 rounded bg-muted font-mono">
                    {t('ai_vat', { amount: formatAmount(extractedData.totals.vatAmount) })}
                  </span>
                )}
                {extractedData.totals.total != null && (
                  <span className="px-2 py-1 rounded bg-muted font-mono">
                    {t('ai_total', { amount: formatAmount(extractedData.totals.total) })}
                  </span>
                )}
              </div>
            )}

            {/* Computed totals */}
            <div className="mt-4 pt-4 border-t space-y-2">
              <div className="flex justify-between sm:justify-end sm:gap-8">
                <span className="text-muted-foreground">{t('net_excl_vat')}</span>
                <span className="font-mono sm:w-32 text-right">{formatCurrency(subtotal, watchedCurrency)}</span>
              </div>
              <div className="flex justify-between sm:justify-end sm:gap-8">
                <span className="text-muted-foreground">
                  {watchedReverseCharge ? t('vat_reverse_charge') : t('vat_label_short')}
                </span>
                <span className="font-mono sm:w-32 text-right">{formatCurrency(totalVat, watchedCurrency)}</span>
              </div>
              <div className="flex justify-between sm:justify-end sm:gap-8 font-bold text-lg">
                <span>{t('total_label')}</span>
                <span className="font-mono sm:w-32 text-right">{formatCurrency(total, watchedCurrency)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Övrigt (collapsible) */}
        <Card>
          <CardHeader
            className="cursor-pointer hover:bg-muted/30 transition-colors"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{t('section_other')}</CardTitle>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
            </div>
          </CardHeader>
          {advancedOpen && (
            <CardContent className="space-y-4 pt-0">
              <div className="space-y-2">
                <Label>{t('delivery_date_label')}</Label>
                <Input type="date" {...register('delivery_date')} />
              </div>
              <div className="space-y-2">
                <Label>{t('notes_label')}</Label>
                <Textarea placeholder={t('notes_placeholder')} {...register('notes')} />
              </div>
            </CardContent>
          )}
        </Card>

        {/* Submit */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 sm:gap-4">
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => router.push(inboxItemId ? '/e/general/invoice-inbox' : '/supplier-invoices')}>
            {t('cancel')}
          </Button>
          {!watchedPaidPrivately && (
            <Button
              type="submit"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={isSubmitting || !canWrite || showNoPeriodWarning}
              onClick={() => { submitModeRef.current = 'register_and_match' }}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              <Link2 className="mr-2 h-4 w-4" />
              {t('register_and_mark_paid')}
            </Button>
          )}
          <Button
            type="submit"
            disabled={isSubmitting || !canWrite || showNoPeriodWarning}
            className="w-full sm:w-auto"
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
                {watchedPaidPrivately ? t('register_expense') : isEF ? t('register_invoice') : t('review_and_register')}
              </>
            ) : watchedPaidPrivately ? (
              t('register_expense')
            ) : isEF ? (
              t('register_invoice')
            ) : (
              t('review_and_register')
            )}
          </Button>
        </div>
      </form>

      {/* Review dialog (AB only — also shown after a bank transaction is picked
          in the register-and-match flow). */}
      {pendingData && !isEF && showReview && (() => {
        const selectedSupplier = suppliers.find((s) => s.id === pendingData.supplier_id)
        if (!selectedSupplier) return null
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
              supplier={selectedSupplier}
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
            <DialogDescription>{conflict?.message}</DialogDescription>
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
