'use client'

import { Fragment, useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm, Controller, useFieldArray } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import AiFilledIndicator from '@/components/ui/ai-filled-indicator'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import BankTransactionPicker from '@/components/transactions/BankTransactionPicker'
import AccrualPeriodControl from '@/components/bookkeeping/AccrualPeriodControl'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import DocumentUploadZone, { type UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
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
} from '@/lib/supplier-invoices/form-payload'
import { VatRateCell, RcRateSelect } from '@/components/supplier-invoices/supplier-invoice-cells'
import { useSupplierInvoiceData } from '@/components/supplier-invoices/use-supplier-invoice-data'
import { useInboxPrefill } from '@/components/supplier-invoices/use-inbox-prefill'
import { useSupplierInvoiceSubmit } from '@/components/supplier-invoices/use-supplier-invoice-submit'
import { ArrowLeft, Plus, Trash2, ChevronDown, Loader2, Lock, AlertCircle, AlertTriangle, MessageCircle, Link2, CalendarClock, Tags, Paperclip } from 'lucide-react'
import type { Supplier } from '@/types'

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
    setSuppliers,
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [newSupplier, setNewSupplier] = useState<NewSupplierForm>(EMPTY_NEW_SUPPLIER)
  const [documentFiles, setDocumentFiles] = useState<UploadedFile[]>([])
  const documentFilesRef = useRef<UploadedFile[]>([])
  const createFinishedRef = useRef(false)
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
      // account_number is deliberately empty: a silent prefilled expense
      // account (the old '5010' Lokalhyra seed) produced legally wrong
      // verifikat whenever the user didn't notice it. An explicit choice is
      // required; the supplier's default_expense_account fills it when set.
      items: [{ description: '', amount: 0, account_number: '', vat_rate: 0.25, reverse_charge_rate: 0.25 }],
    },
  })

  useUnsavedChanges(isDirty)

  useEffect(() => {
    documentFilesRef.current = documentFiles
  }, [documentFiles])

  useEffect(() => () => {
    if (inboxItemId || createFinishedRef.current) return
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
  const documentUploadInProgress = documentFiles.some((file) => file.status === 'uploading')
  const documentUploadFailed = documentFiles.some((file) => file.status === 'error')
  const uploadedDocumentId = documentFiles.find((file) => file.status === 'uploaded')?.id

  const {
    extractedData,
    originalExtracted,
    hasMatchedSupplier,
    setHasMatchedSupplier,
    isLoadingInbox,
    hasPrefilled,
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

  // Auto-fill due date and defaults when supplier is selected: but never
  // overwrite a value the AI already filled in for us.
  const [templateAccountNote, setTemplateAccountNote] = useState<{ account: string; counterparty: string } | null>(null)
  // Rows planted by the counterparty-history prefill, so a supplier SWITCH can
  // un-plant them: without this, supplier A's history account survives into
  // supplier B's invoice and silently blocks B's own default_expense_account
  // (the fill branches only touch empty rows).
  const plantedRef = useRef<{ account: string; rows: number[] } | null>(null)
  // Automatic fill is requested, not applied inline: handleAccountChange
  // needs the loaded BAS chart to apply the konto's default moms, and the
  // requests originate in closures (the supplier effect and its async
  // template fetch) that may hold a stale empty `accounts`. The applying
  // effect below re-runs on both the request tick and the chart load with
  // fresh closures, so whichever arrives last triggers the fill. Filling
  // early would leave a VAT-free konto on the 25% row default, the exact
  // mis-booking the fill exists to prevent.
  const pendingAccountFillRef = useRef<{ account: string; plant: boolean; counterparty?: string } | null>(null)
  const [accountFillTick, setAccountFillTick] = useState(0)

  function requestAccountFill(account: string, plant: boolean, counterparty?: string) {
    pendingAccountFillRef.current = { account, plant, counterparty }
    setAccountFillTick((t) => t + 1)
  }

  useEffect(() => {
    if (accounts.length === 0 || !pendingAccountFillRef.current) return
    const { account, plant, counterparty } = pendingAccountFillRef.current
    pendingAccountFillRef.current = null
    const items = getValues('items')
    const appliedRows: number[] = []
    items.forEach((row, i) => {
      if (!row.account_number) {
        // Same path as a manual pick: konto default moms rides along.
        handleAccountChange(i, account)
        appliedRows.push(i)
      }
    })
    if (appliedRows.length > 0 && plant && counterparty) {
      plantedRef.current = { account, rows: appliedRows }
      setTemplateAccountNote({ account, counterparty })
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
      rows.forEach((i) => {
        if (planted[i]?.account_number === account) {
          // Clear only the account; the rate is left for the next fill or
          // manual pick to settle (handleAccountChange reapplies konto
          // defaults), so an AI-extracted rate is never clobbered here.
          setValue(`items.${i}.account_number`, '')
        }
      })
      plantedRef.current = null
    }

    const invoiceDate = watch('invoice_date')
    const currentDue = watch('due_date')
    if (invoiceDate && !currentDue) {
      const due = new Date(invoiceDate)
      due.setDate(due.getDate() + supplier.default_payment_terms)
      setValue('due_date', due.toISOString().split('T')[0])
    }
    if (supplier.default_expense_account && fields.length > 0) {
      // Fill every row the user hasn't assigned yet: an empty account is the
      // only signal needed (rows start empty by design, no seeded default).
      // Routed through the fill request so it waits for the BAS chart and the
      // konto's default moms comes along exactly like a manual pick.
      requestAccountFill(supplier.default_expense_account, false)
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
    if (!supplier.default_expense_account && fields.length > 0 && supplier.name?.trim()) {
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
          requestAccountFill(debit, true, match.template.counterparty_name)
        } catch {
          // Prefill is best-effort; the rows stay blank.
        }
      })()
      return () => { cancelled = true }
    }
    return undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSupplierId, suppliers])

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
  // Re-runs after the inbox prefill lands so a late extraction can't
  // reintroduce a rate.
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
  }, [vatRegistered, hasPrefilled])

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
        <AlertTriangle className="h-4 w-4 text-attn mt-0.5 shrink-0" />
        <p className="flex-1 text-sm text-attn">
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
    return buildSupplierInvoicePayload(data, {
      inboxItemId,
      uploadedDocumentId,
      oreRounding,
      defaultDims,
      canUseAccrual,
    })
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
  })

  function handleDocumentFilesChange(nextFiles: UploadedFile[]) {
    const retainedKeys = new Set(nextFiles.map((file) => file.uploadKey))
    const removedDocuments = documentFiles.filter(
      (file) => file.id && !retainedKeys.has(file.uploadKey),
    )

    setDocumentFiles(nextFiles)
    for (const document of removedDocuments) {
      void fetch(`/api/documents/${document.id}`, { method: 'DELETE' })
    }
  }

  async function discardUploadedDocument() {
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

  return (
    <div className={bare ? 'space-y-6' : 'space-y-6 max-w-4xl'}>
      {/* In bare (dialog) mode the dialog renders the title. */}
      {!bare && (
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
            <h1 className="font-display text-2xl leading-8 tracking-tight">{t('page_title')}</h1>
          </div>
        </div>
      )}

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
            <CardTitle className="text-base">{t('section_invoice')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Eget utlägg-toggle. När den är på bokas verifikatet direkt mot
                skuld till ägare (2893/2018) istället för leverantörsskuld (2440),
                och fakturan får status "Betalad" direkt. */}
            <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30">
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

            {!inboxItemId && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <div className="flex items-start gap-3">
                  <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <Label>{t('document_label')}</Label>
                  </div>
                </div>
                <DocumentUploadZone
                  files={documentFiles}
                  onFilesChange={handleDocumentFilesChange}
                  maxFiles={1}
                  disabled={isSubmitting}
                  compact
                />
              </div>
            )}

            {/* Invoice-level default dims (kostnadsställe/projekt): applied to
                every generated journal line; per-row bags in Kontering merge on
                top. Renders only when dimensions are enabled for the company. */}
            {dimensionsEnabled && (
              <div className="space-y-1">
                <div className="max-w-md">
                  <LineDimensionFields
                    dimensions={defaultDims}
                    onChange={setDefaultDimension}
                    inputClassName="h-9"
                  />
                </div>
              </div>
            )}

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
            <CardTitle className="text-base">{t('section_accounting')}</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() =>
                append({ description: '', amount: 0, account_number: '', vat_rate: vatRegistered ? 0.25 : 0, reverse_charge_rate: 0.25 })
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('add_row')}
            </Button>
          </CardHeader>
          <CardContent>
            {templateAccountNote &&
              (watchedItems ?? []).some((r) => r.account_number === templateAccountNote.account) && (
                <p className="mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                  {t('account_from_history', {
                    account: templateAccountNote.account,
                    counterparty: formatCounterpartyName(templateAccountNote.counterparty),
                  })}
                </p>
              )}
            {/* Valuta & moms: kept inline with the line items because they
                drive how each row is interpreted. Hidden defaults (SEK +
                normal moms) collapse to nothing so most users don't see this. */}
            <div className="mb-4 pb-4 border-b grid grid-cols-1 sm:grid-cols-3 gap-4">
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

            {/* Non-blocking account-range hint for reverse charge (#863 item 2) */}
            {rcAccountWarningRows.length > 0 && (
              <div
                role="status"
                className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3"
              >
                <AlertTriangle className="h-4 w-4 text-attn mt-0.5 shrink-0" />
                <p className="text-sm text-attn">
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
                className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3"
              >
                <AlertTriangle className="h-4 w-4 text-attn mt-0.5 shrink-0" />
                <p className="text-sm text-attn">
                  {t('foreign_zero_vat_warning', {
                    count: foreignZeroVatRows.length,
                    rows: foreignZeroVatRows.map((i) => i + 1).join(', '),
                  })}
                </p>
              </div>
            )}

            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="pb-2 w-28">{t('col_account')}</th>
                    <th className="pb-2">{t('col_description')}</th>
                    <th className="pb-2 w-32">{vatColsVisible ? t('col_amount_excl') : t('col_amount')}</th>
                    {vatColsVisible && (
                      <>
                        <th className="pb-2 w-36">{watchedReverseCharge ? t('col_rc_vat_rate') : t('col_vat_rate')}</th>
                        <th className="pb-2 w-24 text-right">{watchedReverseCharge ? t('col_rc_vat') : t('col_vat')}</th>
                      </>
                    )}
                    <th className="pb-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <Fragment key={field.id}>
                    <tr className={cn('align-top', (canUseAccrual && isAccrualOpen(index)) || (dimensionsEnabled && isDimOpen(index)) || slpRowVisible(index) ? 'border-0' : 'border-b last:border-0')}>
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
                      {vatColsVisible && (
                        <>
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
                        </>
                      )}
                      <td className="py-2 pt-3">
                        <div className="flex items-center">
                          {dimensionsEnabled && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => toggleDimensions(index)}
                              aria-label={t('row_dimensions_aria', { index: index + 1 })}
                              aria-pressed={isDimOpen(index)}
                              title={t('row_dimensions_title')}
                            >
                              <Tags
                                className={cn(
                                  'h-4 w-4',
                                  isDimOpen(index) ? 'text-foreground' : 'text-muted-foreground',
                                )}
                              />
                            </Button>
                          )}
                          {canUseAccrual && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => toggleAccrual(index)}
                              aria-label={ta('row_toggle_aria', { index: index + 1 })}
                              aria-pressed={isAccrualOpen(index)}
                              title={ta('row_toggle')}
                            >
                              <CalendarClock
                                className={cn(
                                  'h-4 w-4',
                                  isAccrualOpen(index) ? 'text-foreground' : 'text-muted-foreground',
                                )}
                              />
                            </Button>
                          )}
                          {fields.length > 1 && (
                            <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={t('remove_row_aria', { index: index + 1 })}>
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {canUseAccrual && isAccrualOpen(index) && (
                      <tr className={cn(dimensionsEnabled && isDimOpen(index) ? 'border-0' : 'border-b last:border-0')}>
                        <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                          {renderAccrualPanel(index, `accrual-desktop-${index}`)}
                        </td>
                      </tr>
                    )}
                    {dimensionsEnabled && isDimOpen(index) && (
                      <tr className={cn(slpRowVisible(index) ? 'border-0' : 'border-b last:border-0')}>
                        <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                          {renderDimensionsPanel(index)}
                        </td>
                      </tr>
                    )}
                    {slpRowVisible(index) && (
                      <tr className="border-b last:border-0">
                        <td colSpan={vatColsVisible ? 6 : 4} className="pb-3">
                          {renderSlpPanel(index)}
                        </td>
                      </tr>
                    )}
                    </Fragment>
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
                    <div className="flex items-center">
                      {dimensionsEnabled && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleDimensions(index)}
                          aria-label={t('row_dimensions_aria', { index: index + 1 })}
                          aria-pressed={isDimOpen(index)}
                          title={t('row_dimensions_title')}
                        >
                          <Tags
                            className={cn(
                              'h-4 w-4',
                              isDimOpen(index) ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          />
                        </Button>
                      )}
                      {canUseAccrual && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleAccrual(index)}
                          aria-label={ta('row_toggle_aria', { index: index + 1 })}
                          aria-pressed={isAccrualOpen(index)}
                          title={ta('row_toggle')}
                        >
                          <CalendarClock
                            className={cn(
                              'h-4 w-4',
                              isAccrualOpen(index) ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          />
                        </Button>
                      )}
                      {fields.length > 1 && (
                        <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={t('remove_row_aria', { index: index + 1 })}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
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
                  <div className={vatColsVisible ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">{vatColsVisible ? t('col_amount_excl') : t('col_amount')}</Label>
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
                    {vatColsVisible && (
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
                    )}
                  </div>
                  {vatColsVisible && (
                    <div className="pt-1 border-t flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{watchedReverseCharge ? t('col_rc_vat') : t('col_vat')}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatAmount(itemTotals[index]?.vatAmount ?? 0)}
                      </span>
                    </div>
                  )}
                  {canUseAccrual && isAccrualOpen(index) &&
                    renderAccrualPanel(index, `accrual-mobile-${index}`)}
                  {dimensionsEnabled && isDimOpen(index) && renderDimensionsPanel(index)}
                  {slpRowVisible(index) && renderSlpPanel(index)}
                </div>
              ))}
            </div>

            {/* AI totals comparison: only when extracted */}
            {extractedData?.totals && (extractedData.totals.subtotal != null || extractedData.totals.total != null) && (
              <div className="mt-4 pt-4 border-t flex flex-wrap gap-2 text-xs">
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

            {/* Computed totals */}
            <div className="mt-4 pt-4 border-t space-y-2">
              {vatColsVisible && (
                <>
                  <div className="flex justify-between sm:justify-end sm:gap-8">
                    <span className="text-muted-foreground">{t('net_excl_vat')}</span>
                    <span className="tabular-nums sm:w-32 text-right">{formatCurrency(subtotal, watchedCurrency)}</span>
                  </div>
                  <div className="flex justify-between sm:justify-end sm:gap-8">
                    <span className="text-muted-foreground">
                      {watchedReverseCharge ? t('vat_reverse_charge') : t('vat_label_short')}
                    </span>
                    <span className="tabular-nums sm:w-32 text-right">{formatCurrency(totalVat, watchedCurrency)}</span>
                  </div>
                </>
              )}
              {displayRounding.applies && (
                <div className="flex justify-between sm:justify-end sm:gap-8">
                  <span className="text-muted-foreground">{t('ore_rounding_label')}</span>
                  <span className="tabular-nums sm:w-32 text-right">{formatCurrency(displayRounding.roundingDelta, watchedCurrency)}</span>
                </div>
              )}
              <div className="flex justify-between sm:justify-end sm:gap-8 font-bold text-lg">
                <span>{t('total_label')}</span>
                <span className="tabular-nums sm:w-32 text-right">{formatCurrency(displayRounding.displayed, watchedCurrency)}</span>
              </div>
              {/* Öresavrundning: display-only rounding of the displayed total to
                  whole kronor (SEK only). The registered amount and the booked
                  verifikat keep the exact öre; this only changes what's shown. */}
              {(watchedCurrency || 'SEK') === 'SEK' && (
                <div className="flex items-center justify-between gap-4 pt-3 mt-1 border-t">
                  <div className="space-y-0.5">
                    <Label htmlFor="ore-rounding" className="text-sm">{t('ore_rounding_label')}</Label>
                    <p className="text-xs text-muted-foreground">{t('ore_rounding_help')}</p>
                  </div>
                  <Switch
                    id="ore-rounding"
                    checked={oreRounding}
                    onCheckedChange={setOreRounding}
                    aria-label={t('ore_rounding_label')}
                  />
                </div>
              )}
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
              <CardTitle className="text-base">{t('section_other')}</CardTitle>
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
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={handleCancel}
            disabled={isSubmitting || documentUploadInProgress}
          >
            {t('cancel')}
          </Button>
          {!watchedPaidPrivately && (
            <Button
              type="submit"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={isSubmitting || documentUploadInProgress || !canWrite || showNoPeriodWarning}
              onClick={() => { submitModeRef.current = 'register_and_match' }}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              <Link2 className="mr-2 h-4 w-4" />
              {t('register_and_mark_paid')}
            </Button>
          )}
          <Button
            type="submit"
            disabled={isSubmitting || documentUploadInProgress || !canWrite || showNoPeriodWarning}
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

      {/* Review dialog (AB only: also shown after a bank transaction is picked
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
