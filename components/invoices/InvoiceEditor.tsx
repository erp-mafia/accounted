'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { Reorder } from 'framer-motion'
import { SortableRow } from '@/components/ui/sortable-row'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { addDays, format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { TagInput } from '@/components/ui/tag-input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, Trash2, ArrowLeft, Send, Eye, Landmark, Lock, AlertTriangle, MoreVertical, CalendarClock, Tags } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { InvoiceReviewContent } from '@/components/invoices/InvoiceReviewContent'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import CustomerForm from '@/components/customers/CustomerForm'
import { BankDetailsSetupDialog } from '@/components/invoices/BankDetailsSetupDialog'
import { FirstInvoiceLogoPrompt } from '@/components/invoices/FirstInvoiceLogoPrompt'
import { useCompany } from '@/contexts/CompanyContext'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import {
  ROT_WORK_TYPES,
  RUT_WORK_TYPES,
  ROT_MAX,
  RUT_MAX,
  computeDeduction,
} from '@/lib/invoices/rot-rut-rules'
import AccrualPeriodControl from '@/components/bookkeeping/AccrualPeriodControl'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { DEFAULT_DEFERRED_REVENUE_ACCOUNT } from '@/lib/bookkeeping/accruals/account-suggestions'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import type { Customer, Currency, CreateInvoiceInput, CreateCustomerInput, InvoiceDocumentType, Article, Invoice, InvoiceItem, BASAccount } from '@/types'

const currencies: Currency[] = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']
const units = ['st', 'tim', 'dag', 'månad', 'km', 'kg']

// A draft invoice + its line items, as fetched for the edit flow.
export type InvoiceForEdit = Invoice & { items: InvoiceItem[] }

// `create` is the original "new invoice" flow (unchanged). `edit` pre-fills the
// form from an existing DRAFT and saves via PATCH instead of POST: no review
// dialog, no number allocation, no self-billed tab, no send/logo prompts.
// `bare` renders the editor without page chrome (back button, full-size
// heading, fixed mobile action bar) so it drops into NewInvoiceDialog: the
// same convention as JournalEntryForm's `bare`.
export type InvoiceEditorProps = (
  | { mode?: 'create' }
  | { mode: 'edit'; initial: InvoiceForEdit }
) & { bare?: boolean }

// Subset of Article fields the line picker needs to pre-fill a row.
type ArticleOption = Pick<
  Article,
  'id' | 'article_number' | 'name' | 'unit' | 'price_excl_vat' | 'vat_rate' | 'revenue_account'
>

function RequiredMark() {
  return <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
}

// True when a dimensions bag ({sie_dim_no: code}) carries at least one value.
function hasDimensionValues(dims: Record<string, string> | null | undefined): boolean {
  return !!dims && Object.keys(dims).length > 0
}

// Compact display of a dimensions bag, e.g. "KS01 · P001" (dim-number order).
function compactDims(dims: Record<string, string>): string {
  return Object.entries(dims)
    .filter(([, v]) => v)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, v]) => v)
    .join(' · ')
}

export default function InvoiceEditor(props: InvoiceEditorProps = { mode: 'create' }) {
  // Edit mode pre-fills the form from an existing draft and saves via PATCH.
  const isEditMode = props.mode === 'edit'
  const initial = props.mode === 'edit' ? props.initial : null
  const bare = props.bare === true
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  const supabase = createClient()
  const t = useTranslations('invoice_editor')
  const ts = useTranslations('self_billing')
  const ta = useTranslations('accruals')
  // Toggle between a normal customer invoice (default) and registering a
  // self-billing invoice we received (mottagen självfaktura, ML 17 kap 15§).
  // Self-billing is never available when editing an existing draft.
  const [mode, setMode] = useState<'invoice' | 'self_billed'>('invoice')

  const schema = useMemo(() => {
    const itemSchema = z.object({
      // 'text' rows carry only a (possibly empty) description: a free-text or
      // blank spacer line. Product rows keep the original requirements,
      // enforced in the refine below so the base shape stays uniform.
      line_type: z.enum(['product', 'text']).optional(),
      description: z.string(),
      quantity: z.number(),
      unit: z.string(),
      unit_price: z.number(),
      vat_rate: z.number().min(0).max(25),
      // Article linkage (artikelregister). Optional: free-text lines omit them.
      article_id: z.string().nullable().optional(),
      revenue_account: z.string().nullable().optional(),
      // ROT/RUT-avdrag per line. Optional: null means "no deduction".
      deduction_type: z.enum(['rot', 'rut']).nullable().optional(),
      labor_hours: z.number().nonnegative().nullable().optional(),
      work_type: z.string().nullable().optional(),
      housing_designation: z.string().nullable().optional(),
      apartment_number: z.string().nullable().optional(),
      brf_org_number: z.string().nullable().optional(),
      // Periodisering (förutbetald intäkt). Active when balance account is
      // non-null; both period dates are then required (refine below).
      accrual_period_start: z.string().nullable().optional(),
      accrual_period_end: z.string().nullable().optional(),
      accrual_balance_account: z.string().nullable().optional(),
      // Per-item dimensions bag ({sie_dim_no: code}, dimensions PR7). Stored
      // as-is; the server merges it over the invoice's default_dimensions on
      // the item's revenue line at booking time.
      dimensions: z.record(z.string(), z.string()).nullable().optional(),
    }).superRefine((item, ctx) => {
      if (item.accrual_balance_account != null) {
        const start = item.accrual_period_start
        const end = item.accrual_period_end
        let invalid = !start || !end || end < start
        if (!invalid) {
          try {
            invalid = countCalendarMonths(start as string, end as string) < 2
          } catch {
            invalid = true
          }
        }
        if (invalid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accrual_period_end'],
            message: ta('validation_period'),
          })
        }
      }
      if (item.line_type === 'text') return
      if (item.description.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: t('validation_description_required') })
      }
      if (!(item.quantity >= 0.01)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: t('validation_quantity_min') })
      }
      if (item.unit.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: t('validation_unit_required') })
      }
      // Negative unit prices are allowed: discount lines (e.g. "Rabatt -100")
      // are a valid way to reduce an invoice total. The backend schema accepts
      // them too (see lib/api/schemas.ts CreateInvoiceItemSchema). An empty
      // price field is still rejected by the base `unit_price: z.number()` type
      // (NaN), so we only need to allow the sign here.
    })
    return z.object({
      customer_id: z.string().min(1, t('validation_customer_required')),
      invoice_date: z.string().min(1, t('validation_invoice_date_required')),
      due_date: z.string().min(1, t('validation_due_date_required')),
      delivery_date: z.string().optional(),
      currency: z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']),
      document_type: z.enum(['invoice', 'proforma', 'delivery_note']),
      your_reference: z.string().optional(),
      our_reference: z.string().optional(),
      notes: z.string().optional(),
      // Self-billing received (mottagen självfaktura). Present in the form for
      // both modes; required only in self_billed mode: enforced in onSubmit.
      external_invoice_number: z.string().optional(),
      self_billing_agreement_ref: z.string().optional(),
      received_date: z.string().optional(),
      // Invoice-level ROT/RUT claim info. Personnummer is plaintext on
      // the wire; the API encrypts it before storage. The API additionally
      // accepts the bostadsrätt pair (deduction_apartment_number +
      // deduction_brf_org_number): no editor UI for it yet, rot i
      // bostadsrätt data enters via API/MCP until the payout-file UI ships.
      deduction_personnummer: z.string().optional(),
      deduction_housing_designation: z.string().optional(),
      items: z.array(itemSchema).min(1, t('validation_min_one_row')),
    })
  }, [t, ta])

  type FormData = z.infer<typeof schema>

  const [customers, setCustomers] = useState<Customer[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSavingDraft, setIsSavingDraft] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [pendingData, setPendingData] = useState<FormData | null>(null)
  const [createdInvoiceId, setCreatedInvoiceId] = useState<string | null>(null)
  const [showSendPrompt, setShowSendPrompt] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [, setDefaultNotes] = useState<string | null>(null)
  const [isCreateCustomerOpen, setIsCreateCustomerOpen] = useState(false)
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false)
  const [hasBankDetails, setHasBankDetails] = useState<boolean | null>(null)
  const [showBankSetup, setShowBankSetup] = useState(false)
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  // Öresavrundning is display-only. In edit mode the draft's stored flag wins;
  // otherwise it defaults to the company-wide setting (loaded below).
  const [oreRounding, setOreRounding] = useState<boolean>(
    typeof initial?.ore_rounding === 'boolean' ? initial.ore_rounding : true,
  )
  const [vatRegistered, setVatRegistered] = useState<boolean>(true)
  const [numberPreview, setNumberPreview] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  // Artikelregister: active articles for the line picker + which line is mid quick-create.
  const [articles, setArticles] = useState<ArticleOption[]>([])
  const [savingArticleIndex, setSavingArticleIndex] = useState<number | null>(null)
  // Class-3 (revenue) accounts for the optional per-line försäljningskonto
  // override, plus which rows currently show that picker.
  const [revenueAccounts, setRevenueAccounts] = useState<BASAccount[]>([])
  const [accountOverrideRows, setAccountOverrideRows] = useState<Set<number>>(new Set())
  // Dimension tagging (kostnadsställe/projekt, dimensions PR7). Affordances
  // render only when company_settings.dimensions_enabled: a UI-visibility
  // gate; a draft that already carries bags still round-trips untouched when
  // the toggle is off. defaultDims is the invoice-level default; per-item
  // overrides live on the form items and open via the row ⋮ menu (same
  // open/close bookkeeping as accountOverrideRows).
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [defaultDims, setDefaultDims] = useState<Record<string, string>>(
    initial?.default_dimensions ?? {},
  )
  const [dimensionOverrideRows, setDimensionOverrideRows] = useState<Set<number>>(new Set())
  // True only when the user had zero invoices when this page loaded. The
  // post-create flow uses this to offer a one-shot "upload a logo?" prompt,
  // issue #520. Self-limits: once count > 0 it stays false.
  const [hadZeroInvoices, setHadZeroInvoices] = useState<boolean | null>(null)
  const [showLogoPrompt, setShowLogoPrompt] = useState(false)
  const pendingCustomerRef = useRef<Customer | null>(null)
  // In edit mode the first time we resolve the pre-filled customer we must NOT
  // re-derive due_date / forced VAT rates from it: those came from the saved
  // draft. Starts true for create (always derive), false for edit (skip once).
  const didInitialCustomerSync = useRef(!isEditMode)

  // Edit mode: the claim card's property fields are restored from the first
  // rot line (they're stamped onto every rot line server-side at save time).
  const initialRotLine = initial?.items?.find((i) => i.deduction_type === 'rot') ?? null

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    // Edit mode pre-fills from the existing draft (header + every line incl.
    // line_type, article link, ROT/RUT and periodisering). The personnummer
    // can't be restored (stored encrypted): the user re-enters it if the
    // draft carries a ROT/RUT claim. Create mode keeps the original empty form.
    defaultValues: initial
      ? {
          customer_id: initial.customer_id,
          invoice_date: initial.invoice_date,
          due_date: initial.due_date,
          delivery_date: initial.delivery_date ?? '',
          currency: initial.currency,
          document_type: (initial.document_type ?? 'invoice') as InvoiceDocumentType,
          your_reference: initial.your_reference ?? '',
          our_reference: initial.our_reference ?? '',
          notes: initial.notes ?? '',
          external_invoice_number: '',
          self_billing_agreement_ref: '',
          received_date: '',
          deduction_personnummer: '',
          deduction_housing_designation: initialRotLine?.housing_designation ?? '',
          items: (initial.items ?? []).map((item) => ({
            line_type: (item.line_type ?? 'product') as 'product' | 'text',
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            vat_rate: item.vat_rate ?? 25,
            article_id: item.article_id ?? null,
            revenue_account: item.revenue_account ?? null,
            deduction_type: item.deduction_type ?? null,
            labor_hours: item.labor_hours ?? null,
            work_type: item.work_type ?? null,
            housing_designation: item.housing_designation ?? null,
            apartment_number: item.apartment_number ?? null,
            brf_org_number: item.brf_org_number ?? null,
            accrual_period_start: item.accrual_period_start ?? null,
            accrual_period_end: item.accrual_period_end ?? null,
            accrual_balance_account: item.accrual_balance_account ?? null,
            dimensions: hasDimensionValues(item.dimensions) ? item.dimensions ?? null : null,
          })),
        }
      : {
          customer_id: '',
          invoice_date: '',
          due_date: '',
          currency: 'SEK',
          document_type: 'invoice' as InvoiceDocumentType,
          external_invoice_number: '',
          self_billing_agreement_ref: '',
          received_date: '',
          items: [{
            description: '',
            quantity: 1,
            unit: 'st',
            unit_price: 0,
            vat_rate: 25,
            article_id: null,
            revenue_account: null,
            deduction_type: null,
            labor_hours: null,
            work_type: null,
            housing_designation: null,
            apartment_number: null,
            brf_org_number: null,
            accrual_period_start: null,
            accrual_period_end: null,
            accrual_balance_account: null,
            dimensions: null,
          }],
        },
  })

  useUnsavedChanges(isDirty)

  // Set date defaults on client only to avoid hydration mismatch. Skipped when
  // editing: the draft's own dates are already loaded into the form.
  useEffect(() => {
    if (isEditMode) return
    setValue('invoice_date', format(new Date(), 'yyyy-MM-dd'))
    setValue('received_date', format(new Date(), 'yyyy-MM-dd'))
    setValue('due_date', format(addDays(new Date(), 30), 'yyyy-MM-dd'))
  }, [])

  const { fields, append, remove, move } = useFieldArray({
    control,
    name: 'items',
  })

  // Drag-to-reorder (grip handle left of each row). framer-motion hands back
  // the fully reordered array; we translate the single displacement into a
  // react-hook-form move() so the registered inputs follow. The persisted
  // sort_order is the array index at create time, so reordering here is all
  // that's needed: no extra payload.
  const handleItemsReorder = (newOrder: typeof fields) => {
    const movedAt = newOrder.findIndex((f, i) => f.id !== fields[i]?.id)
    if (movedAt === -1) return
    const from = fields.findIndex((f) => f.id === newOrder[movedAt].id)
    if (from !== -1 && from !== movedAt) move(from, movedAt)
  }

  const watchItems = watch('items')
  const watchCurrency = watch('currency')
  const watchCustomerId = watch('customer_id')
  const watchDocumentType = watch('document_type') as InvoiceDocumentType

  // After customers state updates with the new customer, select it
  useEffect(() => {
    const pending = pendingCustomerRef.current
    if (pending && customers.some((c) => c.id === pending.id)) {
      setValue('customer_id', pending.id, { shouldValidate: true, shouldDirty: true })
      setSelectedCustomer(pending)
      pendingCustomerRef.current = null
    }
  }, [customers, setValue])

  useEffect(() => {
    if (!company?.id) return
    fetchCustomers()
    fetchDefaultNotes()
    fetchArticles()
    fetchRevenueAccounts()
  }, [company?.id])

  async function fetchArticles() {
    if (!company?.id) return
    const { data } = await supabase
      .from('articles')
      .select('id, article_number, name, unit, price_excl_vat, vat_rate, revenue_account')
      .eq('company_id', company.id)
      .eq('active', true)
      .order('name')
    setArticles((data ?? []) as ArticleOption[])
  }

  async function fetchRevenueAccounts() {
    if (!company?.id) return
    try {
      const res = await fetch('/api/bookkeeping/accounts?class=3')
      const body = await res.json()
      setRevenueAccounts((body?.data as BASAccount[]) || [])
    } catch {
      // Non-fatal: the override picker degrades to free 4-digit entry.
    }
  }

  // Apply a chosen article's defaults onto a line. Selecting "none" detaches the
  // article link (and its account override) but keeps the typed text/price so the
  // row becomes an editable free-text line.
  function applyArticle(index: number, articleId: string) {
    if (articleId === 'none') {
      setValue(`items.${index}.article_id`, null, { shouldDirty: true })
      setValue(`items.${index}.revenue_account`, null, { shouldDirty: true })
      return
    }
    const a = articles.find((x) => x.id === articleId)
    if (!a) return
    setValue(`items.${index}.article_id`, a.id, { shouldDirty: true })
    setValue(`items.${index}.description`, a.name, { shouldValidate: true, shouldDirty: true })
    if (a.unit) setValue(`items.${index}.unit`, a.unit, { shouldDirty: true })
    setValue(`items.${index}.unit_price`, Number(a.price_excl_vat) || 0, { shouldValidate: true, shouldDirty: true })
    // Only adopt the article's VAT rate when it's allowed for this customer
    // (and the rate isn't locked, e.g. reverse charge / export). Otherwise keep
    // the line's current rate so the API's per-customer VAT rule isn't violated.
    if (!isRateLocked && availableRates.some((r) => r.rate === a.vat_rate)) {
      setValue(`items.${index}.vat_rate`, a.vat_rate, { shouldValidate: true, shouldDirty: true })
    }
    // The account override rides along regardless of rate; the engine ignores it
    // for reverse-charge/export and validates it against the chart of accounts.
    setValue(`items.${index}.revenue_account`, a.revenue_account ?? null, { shouldDirty: true })
  }

  // "Spara som artikel": persist the current free-text line into the register and
  // back-fill the article_id so the row is now catalog-linked.
  async function saveLineAsArticle(index: number) {
    const item = watchItems[index]
    if (!item?.description?.trim()) {
      toast({ title: t('save_article_need_description'), variant: 'destructive' })
      return
    }
    setSavingArticleIndex(index)
    try {
      const response = await fetch('/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.description.trim(),
          unit: item.unit || 'st',
          price_excl_vat: Number(item.unit_price) || 0,
          vat_rate: item.vat_rate ?? 25,
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'article', statusCode: response.status }))
      }
      const created = result.data as ArticleOption
      setArticles((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, 'sv')))
      setValue(`items.${index}.article_id`, created.id, { shouldDirty: true })
      toast({ title: t('article_saved_title'), description: created.name })
    } catch (error) {
      toast({
        title: t('save_article_failed'),
        description: getErrorMessage(error, { context: 'article' }),
        variant: 'destructive',
      })
    } finally {
      setSavingArticleIndex(null)
    }
  }

  async function fetchDefaultNotes() {
    if (!company?.id) return
    const { data } = await supabase
      .from('company_settings')
      .select('invoice_default_notes, default_our_reference, clearing_number, account_number, bankgiro, accounting_method, ore_rounding, logo_url, vat_registered, dimensions_enabled')
      .eq('company_id', company.id)
      .single()
    if (data?.invoice_default_notes) {
      setDefaultNotes(data.invoice_default_notes)
      setValue('notes', data.invoice_default_notes)
    }
    // Pre-fill "Vår referens" from the company default: only when creating a
    // fresh invoice, so an edited draft's own reference is never overwritten.
    if (!isEditMode && data?.default_our_reference) {
      setValue('our_reference', data.default_our_reference)
    }
    setHasBankDetails(
      !!(data?.clearing_number && data?.account_number) || !!data?.bankgiro
    )
    if (data?.accounting_method === 'cash' || data?.accounting_method === 'accrual') {
      setAccountingMethod(data.accounting_method)
    }
    // An explicit per-invoice flag (edit mode) wins; only fall back to the
    // company-wide setting when creating or when the draft never set one.
    if (typeof data?.ore_rounding === 'boolean' && (!isEditMode || initial?.ore_rounding == null)) {
      setOreRounding(data.ore_rounding)
    }
    setLogoUrl(data?.logo_url ?? null)
    if (typeof data?.vat_registered === 'boolean') {
      setVatRegistered(data.vat_registered)
    }
    // Gates the dimension affordances (header default + per-row override).
    setDimensionsEnabled(data?.dimensions_enabled === true)
  }

  // First-invoice detection (issue #520): captured at page load so the
  // post-create flow can offer the logo prompt for genuinely first-time
  // invoices only. head:true keeps it cheap: no rows pulled.
  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    ;(async () => {
      const { count } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
      if (!cancelled) setHadZeroInvoices(count === 0 || count === null)
    })()
    return () => {
      cancelled = true
    }
    // supabase is a stable reference from createClient() at top of component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  // Preview the next invoice number so the user can catch a mis-set
  // sequence/prefix before committing. The actual allocator still runs
  // atomically at create time; this is read-only.
  useEffect(() => {
    if (!company?.id) return
    // Editing an existing draft: it already has (or will keep) its own number,
    // never show the "next number" preview.
    if (isEditMode || watchDocumentType === 'delivery_note') {
      setNumberPreview(null)
      return
    }
    let cancelled = false
    fetch(`/api/invoices/next-number?document_type=${encodeURIComponent(watchDocumentType)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!cancelled) setNumberPreview(res?.data?.preview ?? null)
      })
      .catch(() => {
        if (!cancelled) setNumberPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [company?.id, watchDocumentType])

  useEffect(() => {
    if (watchCustomerId) {
      const customer = customers.find((c) => c.id === watchCustomerId)
      setSelectedCustomer(customer || null)

      // Skip the derived side-effects (due_date, forced VAT rate) the first time
      // we resolve a pre-filled customer in edit mode: those values came from
      // the saved draft and must not be overwritten. Applied normally on every
      // subsequent (user-initiated) customer change, and always in create mode.
      if (customer) {
        if (didInitialCustomerSync.current) {
          // Update due date based on customer payment terms
          if (customer.default_payment_terms) {
            setValue(
              'due_date',
              format(addDays(new Date(), customer.default_payment_terms), 'yyyy-MM-dd')
            )
          }

          // When the customer forces a single rate (reverse charge/export),
          // update all lines so the picker can't leave stale 25% values behind.
          const rates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
          if (rates.length === 1) {
            const forcedRate = rates[0].rate
            watchItems.forEach((_, i) => {
              setValue(`items.${i}.vat_rate`, forcedRate)
            })
          }
        }
        didInitialCustomerSync.current = true
      }
    }
  }, [watchCustomerId, customers, setValue])

  async function fetchCustomers() {
    if (!company?.id) return
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (error) {
      toast({
        title: t('load_customers_failed_title'),
        description: t('load_customers_failed_description'),
        variant: 'destructive',
      })
    } else {
      setCustomers(data || [])
    }
    setIsLoading(false)
  }

  async function handleCreateCustomer(data: CreateCustomerInput) {
    setIsCreatingCustomer(true)

    const response = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const result = await response.json()

    if (!response.ok) {
      toast({
        title: t('create_customer_failed_title'),
        description: getErrorMessage(result, { context: 'customer' }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: t('customer_created_title'),
        description: t('customer_created_description', { name: data.name }),
      })
      pendingCustomerRef.current = result.data
      setCustomers(prev => [...prev, result.data])
      setIsCreateCustomerOpen(false)
    }

    setIsCreatingCustomer(false)
  }

  const subtotal = watchItems.reduce((sum, item) => {
    return sum + (item.quantity || 0) * (item.unit_price || 0)
  }, 0)

  const vatRules = selectedCustomer
    ? getVatRules(selectedCustomer.customer_type, selectedCustomer.vat_number_validated)
    : null

  const availableRates = selectedCustomer
    ? getAvailableVatRates(selectedCustomer.customer_type, selectedCustomer.vat_number_validated)
    : []
  const isRateLocked = availableRates.length === 1
  // A non-momsregistrerad company never charges VAT: hide the Moms column and
  // book every line momsfritt. `vatRegistered` is the single switch the whole
  // form keys off: no rate picker, no warning, no VAT in the totals/preview.
  // The API enforces the same (forces 0% server-side), so a stale hidden field
  // value can't smuggle VAT onto the invoice. With VAT shown the description
  // keeps its 3/12 width; when hidden it widens to fill the freed columns.
  const descColSpan = vatRegistered ? 'md:col-span-3' : 'md:col-span-5'

  // Calculate per-item VAT. When not VAT-registered every rate is forced to 0
  // so vatAmount stays 0 and total === subtotal.
  const vatByRate = new Map<number, { base: number; vat: number }>()
  let vatAmount = 0
  for (const item of watchItems) {
    const rate = vatRegistered ? (item.vat_rate ?? (vatRules?.rate || 25)) : 0
    const lineTotal = (item.quantity || 0) * (item.unit_price || 0)
    const lineVat = Math.round(lineTotal * rate / 100 * 100) / 100
    vatAmount += lineVat
    const existing = vatByRate.get(rate) || { base: 0, vat: 0 }
    existing.base += lineTotal
    existing.vat += lineVat
    vatByRate.set(rate, existing)
  }
  const total = subtotal + vatAmount

  // ROT/RUT-avdrag live preview. Computed client-side for instant feedback;
  // the API recomputes server-side as the source of truth. Skipped for
  // non-invoice document types (proformas and delivery notes don't book
  // a deduction).
  const isSelfBilled = mode === 'self_billed'
  // ROT/RUT is an own-issued, B2C concept: never shown for a received self-bill.
  const isInvoiceDoc = watchDocumentType === 'invoice' && !isSelfBilled
  const deductionByKind = { rot: 0, rut: 0 }
  if (isInvoiceDoc) {
    for (const item of watchItems) {
      if (!item.deduction_type) continue
      const amount = computeDeduction({
        unit_price: item.unit_price || 0,
        quantity: item.quantity || 0,
        deduction_type: item.deduction_type,
      })
      if (item.deduction_type === 'rot') deductionByKind.rot += amount
      else deductionByKind.rut += amount
    }
  }
  const deductionTotal = Math.round((deductionByKind.rot + deductionByKind.rut) * 100) / 100
  const hasAnyDeduction = deductionTotal > 0
  const hasAnyRotLine = isInvoiceDoc && watchItems.some((i) => i.deduction_type === 'rot')
  const toPay = Math.round((total - deductionTotal) * 100) / 100

  // Periodisering per rad: kräver faktureringsmetoden och en riktig faktura.
  // EU-/exportkunder bokas på 3308/3305 (omvänd skattskyldighet/export) och
  // kan inte periodiseras: ruta 39/40 ska spegla hela försäljningen.
  const customerBlocksAccrual =
    selectedCustomer?.customer_type === 'eu_business' ||
    selectedCustomer?.customer_type === 'non_eu_business'
  const canUseAccrual = isInvoiceDoc && accountingMethod === 'accrual' && !customerBlocksAccrual

  function toggleAccrual(index: number) {
    if (watchItems[index]?.accrual_balance_account != null) {
      setValue(`items.${index}.accrual_period_start`, null, { shouldDirty: true })
      setValue(`items.${index}.accrual_period_end`, null, { shouldDirty: true })
      setValue(`items.${index}.accrual_balance_account`, null, { shouldDirty: true })
    } else {
      setValue(`items.${index}.accrual_period_start`, watch('invoice_date') || '', { shouldDirty: true })
      setValue(`items.${index}.accrual_period_end`, '', { shouldDirty: true })
      setValue(
        `items.${index}.accrual_balance_account`,
        DEFAULT_DEFERRED_REVENUE_ACCOUNT,
        { shouldDirty: true },
      )
    }
  }

  // Open/close the optional per-line försäljningskonto override. Closing clears
  // the value so the engine falls back to the VAT-rate-derived revenue account.
  function toggleAccountOverride(index: number) {
    const isOpen = accountOverrideRows.has(index) || !!watchItems[index]?.revenue_account
    if (isOpen) {
      setValue(`items.${index}.revenue_account`, null, { shouldDirty: true })
      setAccountOverrideRows((prev) => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    } else {
      setAccountOverrideRows((prev) => new Set(prev).add(index))
    }
  }

  // Open/close the optional per-item dimensions override (⋮ menu). Closing
  // clears the bag so the row falls back to the invoice's default_dimensions.
  function toggleItemDimensions(index: number) {
    const isOpen = dimensionOverrideRows.has(index) || hasDimensionValues(watchItems[index]?.dimensions)
    if (isOpen) {
      setValue(`items.${index}.dimensions`, null, { shouldDirty: true })
      setDimensionOverrideRows((prev) => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    } else {
      setDimensionOverrideRows((prev) => new Set(prev).add(index))
    }
  }

  function updateItemDimension(index: number, dimNo: string, code: string | null) {
    const current = { ...(watchItems[index]?.dimensions ?? {}) }
    const trimmed = code?.trim()
    if (trimmed) current[dimNo] = trimmed
    else delete current[dimNo]
    setValue(
      `items.${index}.dimensions`,
      Object.keys(current).length > 0 ? current : null,
      { shouldDirty: true },
    )
    // Keep the sub-row open after the user clears the last value: it closes
    // only via the ⋮ menu (same lifecycle as the account override).
    setDimensionOverrideRows((prev) => (prev.has(index) ? prev : new Set(prev).add(index)))
  }

  function setDefaultDimension(dimNo: string, code: string | null) {
    setDefaultDims((prev) => {
      const next = { ...prev }
      const trimmed = code?.trim()
      if (trimmed) next[dimNo] = trimmed
      else delete next[dimNo]
      return next
    })
  }

  // Per-item bags ride the payload only when they carry values: the server
  // treats an absent bag as "inherit the invoice's default_dimensions".
  function pruneItemDimensions<T extends { dimensions?: Record<string, string> | null }>(
    items: T[],
  ): T[] {
    return items.map((item) =>
      hasDimensionValues(item.dimensions) ? item : { ...item, dimensions: undefined },
    )
  }

  // Self-billing path: no review dialog, no PDF, no send: it arrives already
  // booked. POST straight to the dedicated endpoint and open the verifikat.
  async function handleSelfBilledSubmit(data: FormData) {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/invoices/self-billed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: data.customer_id,
          external_invoice_number: data.external_invoice_number,
          self_billing_agreement_ref: data.self_billing_agreement_ref || undefined,
          invoice_date: data.invoice_date,
          received_date: data.received_date,
          due_date: data.due_date,
          currency: data.currency,
          notes: data.notes,
          items: data.items.map((i) => ({
            description: i.description,
            quantity: i.quantity,
            unit: i.unit,
            unit_price: i.unit_price,
            vat_rate: i.vat_rate,
          })),
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }
      toast({
        title: ts('created_title'),
        description: ts('created_description', { number: data.external_invoice_number ?? '' }),
      })
      router.push(`/invoices/${result.data.id}`)
    } catch (error) {
      toast({
        title: ts('create_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function onSubmit(data: FormData) {
    if (isEditMode) {
      // Editing a draft: no review dialog, straight to PATCH.
      await saveEdit(data)
      return
    }
    if (isSelfBilled) {
      // The two self-billing-only fields are optional in the shared schema:
      // enforce them here so the inline errors render under the right inputs.
      let valid = true
      if (!data.external_invoice_number?.trim()) {
        setError('external_invoice_number', { message: ts('validation_external_number_required') })
        valid = false
      }
      if (!data.received_date) {
        setError('received_date', { message: ts('validation_received_date_required') })
        valid = false
      }
      if (!valid) return
      await handleSelfBilledSubmit(data)
      return
    }
    setPendingData(data)
    // Re-fetch the preview right before review so the displayed number
    // reflects any concurrent invoice creations. Skip for delivery notes.
    if (data.document_type !== 'delivery_note') {
      try {
        const r = await fetch(`/api/invoices/next-number?document_type=${encodeURIComponent(data.document_type)}`)
        if (r.ok) {
          const json = await r.json()
          setNumberPreview(json?.data?.preview ?? null)
        }
      } catch {
        // Preview is best-effort; the allocator at create time is the source of truth.
      }
    }
    if (hasBankDetails === false && watchDocumentType === 'invoice') {
      setShowBankSetup(true)
      return
    }
    setShowReview(true)
  }

  function handleBankSetupComplete() {
    setHasBankDetails(true)
    setShowBankSetup(false)
    if (pendingData) {
      setShowReview(true)
    }
  }

  function getDocLabel(type: InvoiceDocumentType): string {
    if (type === 'proforma') return t('doc_label_proforma')
    if (type === 'delivery_note') return t('doc_label_delivery_note')
    return t('doc_label_invoice')
  }

  function handleLogoPromptClose() {
    setShowLogoPrompt(false)
    // Resume the post-create flow that was deferred by the logo prompt.
    if (selectedCustomer?.email && createdInvoiceId) {
      setShowSendPrompt(true)
    } else if (createdInvoiceId) {
      router.push(`/invoices/${createdInvoiceId}`)
    }
  }

  async function handleConfirm() {
    if (!pendingData) return
    setIsSubmitting(true)

    // Privacy by default: ROT/RUT line fields and the invoice-level
    // personnummer / housing designation are only sent to the API when the
    // user actually claims a deduction. Defaults are pre-instantiated as
    // null in the form state, but null personal-data fields shouldn't ride
    // along on every regular invoice.
    const anyDeduction = pendingData.items.some((i) => i.deduction_type)
    const sanitizedItems = pruneItemDimensions(pendingData.items).map((item) => {
      if (item.deduction_type) return item
      const {
        deduction_type: _dt,
        labor_hours: _lh,
        work_type: _wt,
        housing_designation: _hd,
        apartment_number: _an,
        brf_org_number: _bn,
        ...rest
      } = item
      return rest
    })
    const sanitizedPayload: CreateInvoiceInput & { default_dimensions: Record<string, string> } = {
      ...(pendingData as CreateInvoiceInput),
      ore_rounding: oreRounding,
      // Invoice-level default dims: always sent so an edited draft can clear
      // them; {} means "no defaults".
      default_dimensions: defaultDims,
      items: sanitizedItems as CreateInvoiceInput['items'],
      ...(anyDeduction
        ? {}
        : { deduction_personnummer: undefined, deduction_housing_designation: undefined }),
    }

    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitizedPayload),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }

      const docLabel = getDocLabel(watchDocumentType)
      toast({
        title: t('doc_created_title', { docLabel }),
        description: t('doc_created_description', { docLabel, number: result.data.invoice_number }),
      })

      setShowReview(false)
      setCreatedInvoiceId(result.data.id)

      // First-invoice-only logo prompt (issue #520) takes priority over the
      // send-now dialog so a fresh upload makes it onto the just-sent PDF
      // (pdf-template reads logo_url live from company_settings). Once the
      // prompt closes, handleLogoPromptClose resumes the regular flow.
      if (hadZeroInvoices === true && !logoUrl) {
        setShowLogoPrompt(true)
      } else if (selectedCustomer?.email) {
        setShowSendPrompt(true)
      } else {
        router.push(`/invoices/${result.data.id}`)
      }
    } catch (error) {
      toast({
        title: t('create_invoice_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // "Spara som utkast": save an unnumbered draft (save_as_draft) without the
  // review dialog. The invoice gets no F-number and fires no invoice.created
  // until the user opens it and clicks "Granska & skapa" (finalize). Same
  // ROT/RUT privacy sanitization as handleConfirm.
  async function saveDraftData(data: FormData) {
    setIsSavingDraft(true)

    const anyDeduction = data.items.some((i) => i.deduction_type)
    const sanitizedItems = pruneItemDimensions(data.items).map((item) => {
      if (item.deduction_type) return item
      const {
        deduction_type: _dt,
        labor_hours: _lh,
        work_type: _wt,
        housing_designation: _hd,
        apartment_number: _an,
        brf_org_number: _bn,
        ...rest
      } = item
      return rest
    })
    const payload: CreateInvoiceInput & { default_dimensions: Record<string, string> } = {
      ...(data as CreateInvoiceInput),
      save_as_draft: true,
      ore_rounding: oreRounding,
      default_dimensions: defaultDims,
      items: sanitizedItems as CreateInvoiceInput['items'],
      ...(anyDeduction
        ? {}
        : { deduction_personnummer: undefined, deduction_housing_designation: undefined }),
    }

    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }
      toast({
        title: t('toast_draft_saved_title'),
        description: t('toast_draft_saved_description'),
      })
      router.push(`/invoices/${result.data.id}`)
    } catch (error) {
      toast({
        title: t('save_draft_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSavingDraft(false)
    }
  }

  // Edit mode: PATCH the existing draft (header + items). Same ROT/RUT privacy
  // sanitization as create: personal-data fields only ride along when a
  // deduction is actually claimed. No review dialog, no number allocation, no
  // send/logo prompt; on success go back to the invoice detail page.
  async function saveEdit(data: FormData) {
    if (!initial) return
    setIsSubmitting(true)

    const anyDeduction = data.items.some((i) => i.deduction_type)
    const sanitizedItems = pruneItemDimensions(data.items).map((item) => {
      if (item.deduction_type) return item
      const {
        deduction_type: _dt,
        labor_hours: _lh,
        work_type: _wt,
        housing_designation: _hd,
        apartment_number: _an,
        brf_org_number: _bn,
        ...rest
      } = item
      return rest
    })
    const payload: CreateInvoiceInput & { default_dimensions: Record<string, string> } = {
      ...(data as CreateInvoiceInput),
      ore_rounding: oreRounding,
      default_dimensions: defaultDims,
      items: sanitizedItems as CreateInvoiceInput['items'],
      ...(anyDeduction
        ? {}
        : { deduction_personnummer: undefined, deduction_housing_designation: undefined }),
    }

    try {
      const response = await fetch(`/api/invoices/${initial.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }
      toast({
        title: t('toast_draft_updated_title'),
        description: t('toast_draft_updated_description'),
      })
      router.push(`/invoices/${initial.id}`)
    } catch (error) {
      toast({
        title: t('update_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSendNow() {
    if (!createdInvoiceId) return
    setIsSending(true)

    try {
      const response = await fetch(`/api/invoices/${createdInvoiceId}/send`, {
        method: 'POST',
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }

      toast({
        title: t('invoice_sent_title'),
        description: t('invoice_sent_description', { email: selectedCustomer?.email ?? '' }),
      })
    } catch (error) {
      toast({
        title: t('send_invoice_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSending(false)
      setShowSendPrompt(false)
      router.push(`/invoices/${createdInvoiceId}`)
    }
  }

  async function handlePreviewPDF() {
    if (!pendingData) return
    setIsPreviewing(true)

    try {
      const response = await fetch('/api/invoices/preview-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: pendingData.customer_id,
          invoice_date: pendingData.invoice_date,
          due_date: pendingData.due_date,
          currency: pendingData.currency,
          document_type: pendingData.document_type,
          items: pendingData.items,
          your_reference: pendingData.your_reference,
          our_reference: pendingData.our_reference,
          notes: pendingData.notes,
          invoice_number: numberPreview,
        }),
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      window.open(url, '_blank')
    } catch (error) {
      toast({
        title: t('preview_pdf_failed'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsPreviewing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const titleText = isEditMode
    ? t('title_edit')
    : isSelfBilled
    ? ts('title')
    : watchDocumentType === 'proforma'
    ? t('title_proforma')
    : watchDocumentType === 'delivery_note'
      ? t('title_delivery_note')
      : t('title_invoice')
  const subtitleText = isEditMode
    ? t('subtitle_edit')
    : isSelfBilled
    ? ts('subtitle')
    : watchDocumentType === 'proforma'
    ? t('subtitle_proforma')
    : watchDocumentType === 'delivery_note'
      ? t('subtitle_delivery_note')
      : t('subtitle_invoice')

  // In bare (dialog) mode the dialog owns the accessible title (sr-only
  // DialogTitle) and the page already has its own h1, so the visible heading
  // steps down to h2: it still tracks document type and number preview live.
  const Heading = bare ? 'h2' : 'h1'

  return (
    <div className={bare ? 'space-y-6' : 'space-y-8'}>
      <div className="flex items-center gap-4">
        {!bare && (
          <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label={t('back')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <Heading className={bare ? 'font-display text-xl tracking-tight' : 'font-display text-2xl md:text-3xl tracking-tight'}>
            {titleText}
            {numberPreview && !isSelfBilled && (
              <span className={bare ? 'ml-2 text-muted-foreground tabular-nums text-lg' : 'ml-2 text-muted-foreground tabular-nums text-xl md:text-2xl'}>
                ({numberPreview})
              </span>
            )}
          </Heading>
          {!bare && <p className="text-muted-foreground">{subtitleText}</p>}
        </div>
        <AgentSparkleButton
          intentId="invoice.draft"
          intentArgs={{ customer_id: watchCustomerId ?? null }}
          contextRef={watchCustomerId ? `customer:${watchCustomerId}` : 'invoice:new'}
        />
      </div>

      {!isEditMode && (
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'invoice' | 'self_billed')}>
          <TabsList>
            <TabsTrigger value="invoice">{t('mode_invoice')}</TabsTrigger>
            <TabsTrigger value="self_billed">{t('mode_self_billed')}</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {hasBankDetails === false && !isSelfBilled && (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm">
          <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">{t('bank_missing_warning')}</p>
          <Button variant="link" size="sm" className="ml-auto shrink-0 px-0" onClick={() => setShowBankSetup(true)}>
            {t('bank_add_now')}
          </Button>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className={bare ? 'space-y-6' : 'space-y-6 pb-28 md:pb-0'}>
        <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
          {/* Main content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Customer selection */}
            <Card>
            <CardHeader>
              <CardTitle>{isSelfBilled ? <>{ts('customer_label')}<RequiredMark /></> : <>{t('customer_card_title')}<RequiredMark /></>}</CardTitle>
              <CardDescription>{isSelfBilled ? ts('issuer_card_description') : t('customer_card_description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Controller
                name="customer_id"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('select_customer_placeholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setIsCreateCustomerOpen(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                {t('create_customer')}
              </Button>
              {errors.customer_id && (
                <p className="text-sm text-destructive mt-2">{errors.customer_id.message}</p>
              )}

              {isSelfBilled && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{ts('external_number_label')}<RequiredMark /></Label>
                    <Input placeholder={ts('external_number_placeholder')} {...register('external_invoice_number')} />
                    {errors.external_invoice_number && (
                      <p className="text-sm text-destructive">{errors.external_invoice_number.message}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>{ts('agreement_ref_label')}</Label>
                    <Input placeholder={ts('agreement_ref_placeholder')} {...register('self_billing_agreement_ref')} />
                  </div>
                </div>
              )}

            </CardContent>
          </Card>

            {/* Invoice items */}
            <Card>
              <CardHeader>
                <CardTitle>{t('items_card_title')}</CardTitle>
              <CardDescription>{t('items_card_description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <Reorder.Group
                  as="div"
                  axis="y"
                  values={fields}
                  onReorder={handleItemsReorder}
                  className="space-y-4"
                >
                {fields.map((field, index) => {
                  const isTextRow = watchItems[index]?.line_type === 'text'
                  const lineTotal = (watchItems[index]?.quantity || 0) * (watchItems[index]?.unit_price || 0)
                  const lineVat = vatRegistered && !isTextRow
                    ? Math.round(lineTotal * (watchItems[index]?.vat_rate ?? 25) / 100 * 100) / 100
                    : 0
                  // Free-text / blank row: just a description field (may be left
                  // empty for a spacer) and a delete button.
                  if (isTextRow) {
                    return (
                      <SortableRow
                        key={field.id}
                        value={field}
                        handleLabel={t('drag_handle_aria')}
                        disabled={fields.length === 1}
                      >
                        <div className="rounded-lg border bg-card p-4 md:rounded-none md:border-0 md:bg-transparent md:p-0">
                          <div className="flex items-end gap-2">
                            <div className="flex-1 space-y-1">
                              <Label className="text-xs text-muted-foreground">{t('text_row_label')}</Label>
                              <Input
                                placeholder={t('text_row_placeholder')}
                                {...register(`items.${index}.description`)}
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0 min-h-[44px] min-w-[44px] text-muted-foreground hover:text-destructive"
                              onClick={() => remove(index)}
                              disabled={fields.length === 1}
                              aria-label={t('remove_row_aria')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </SortableRow>
                    )
                  }
                  // Per-row action button. On real invoices it's a ⋮ menu that
                  // holds both the ROT/RUT skattereduktion choice and delete;
                  // proformas/delivery notes have no deduction model, so they
                  // keep a plain trash button (a one-item menu would be noise).
                  const renderRowActions = (triggerClassName: string) =>
                    isInvoiceDoc ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={triggerClassName}
                            aria-label={t('row_actions_aria')}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-56">
                          <DropdownMenuLabel>{t('deduction_menu_label')}</DropdownMenuLabel>
                          <DropdownMenuRadioGroup
                            value={watchItems[index]?.deduction_type ?? 'none'}
                            onValueChange={(v) => {
                              const next = v === 'none' ? null : (v as 'rot' | 'rut')
                              setValue(`items.${index}.deduction_type`, next, { shouldDirty: true })
                              if (next === null) {
                                setValue(`items.${index}.work_type`, null)
                                setValue(`items.${index}.labor_hours`, null)
                                setValue(`items.${index}.housing_designation`, null)
                                setValue(`items.${index}.apartment_number`, null)
                              } else if (watchItems[index]?.accrual_balance_account != null) {
                                // ROT/RUT och periodisering kombineras aldrig
                                // på samma rad: avdraget vinner.
                                setValue(`items.${index}.accrual_period_start`, null)
                                setValue(`items.${index}.accrual_period_end`, null)
                                setValue(`items.${index}.accrual_balance_account`, null)
                              }
                            }}
                          >
                            <DropdownMenuRadioItem value="none" className="py-2">{t('deduction_none')}</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="rot" className="py-2">{t('deduction_rot')}</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="rut" className="py-2">{t('deduction_rut')}</DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                          {canUseAccrual && !watchItems[index]?.deduction_type && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => toggleAccrual(index)} className="py-2">
                                <CalendarClock className="h-4 w-4" />
                                {watchItems[index]?.accrual_balance_account != null
                                  ? ta('row_menu_remove')
                                  : ta('row_menu_add')}
                              </DropdownMenuItem>
                            </>
                          )}
                          {watchItems[index]?.line_type !== 'text' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => toggleAccountOverride(index)} className="py-2">
                                <Landmark className="h-4 w-4" />
                                {(accountOverrideRows.has(index) || watchItems[index]?.revenue_account)
                                  ? t('row_menu_remove_account')
                                  : t('row_menu_set_account')}
                              </DropdownMenuItem>
                            </>
                          )}
                          {dimensionsEnabled && watchItems[index]?.line_type !== 'text' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => toggleItemDimensions(index)} className="py-2">
                                <Tags className="h-4 w-4" />
                                {(dimensionOverrideRows.has(index) || hasDimensionValues(watchItems[index]?.dimensions))
                                  ? t('row_menu_remove_dimensions')
                                  : t('row_menu_set_dimensions')}
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="py-2 text-destructive focus:text-destructive"
                            disabled={fields.length === 1}
                            onSelect={() => remove(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t('remove_row')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={triggerClassName}
                        onClick={() => remove(index)}
                        disabled={fields.length === 1}
                        aria-label={t('remove_row_aria')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )
                  return (
                    <SortableRow
                      key={field.id}
                      value={field}
                      handleLabel={t('drag_handle_aria')}
                      disabled={fields.length === 1}
                    >
                    <div
                      className="rounded-lg border bg-card p-4 space-y-3 relative md:rounded-none md:border-0 md:bg-transparent md:p-0 md:space-y-0 md:grid md:grid-cols-12 md:gap-4 md:items-start"
                    >
                      {/* Article picker (artikelregister). Optional: leave on
                          "Egen rad" to type a free-text line. Selecting an
                          article pre-fills description, unit, price, VAT and any
                          revenue-account override. */}
                      <div className="md:col-span-12 flex flex-wrap items-end gap-2">
                        <div className="flex-1 min-w-[180px] space-y-1 md:space-y-2">
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">{t('article_label')}</Label>
                          <Controller
                            name={`items.${index}.article_id`}
                            control={control}
                            render={({ field }) => (
                              <Select
                                value={field.value ?? 'none'}
                                onValueChange={(v) => applyArticle(index, v)}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder={t('article_placeholder')} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">{t('article_free_text')}</SelectItem>
                                  {articles.map((a) => (
                                    <SelectItem key={a.id} value={a.id}>
                                      {a.article_number ? `${a.article_number}: ${a.name}` : a.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </div>
                        {canWrite && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-10 shrink-0"
                            onClick={() => saveLineAsArticle(index)}
                            disabled={savingArticleIndex === index}
                          >
                            {savingArticleIndex === index ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Plus className="h-4 w-4 md:mr-1" />
                            )}
                            <span className="hidden md:inline">{t('save_as_article')}</span>
                          </Button>
                        )}
                      </div>

                      {/* Description + mobile delete button */}
                      <div className="flex items-start gap-2 md:contents">
                        <div className={`flex-1 space-y-1 ${descColSpan} md:space-y-2`}>
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">{t('description_label')}</Label>
                          <Input
                            placeholder={t('description_placeholder')}
                            {...register(`items.${index}.description`)}
                          />
                          {errors.items?.[index]?.description && (
                            <p className="text-sm text-destructive">
                              {errors.items[index].description?.message}
                            </p>
                          )}
                        </div>
                        {renderRowActions('shrink-0 min-h-[44px] min-w-[44px] -mr-2 -mt-1 md:hidden')}
                      </div>

                      {/* Antal, Enhet, à-pris */}
                      <div className="grid grid-cols-3 gap-2 md:contents">
                        <div className="space-y-1 md:col-span-2 md:space-y-2">
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">{t('quantity_label')}</Label>
                          <Input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                          />
                        </div>
                        <div className="space-y-1 md:col-span-2 md:space-y-2">
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">{t('unit_label')}</Label>
                          <Controller
                            name={`items.${index}.unit`}
                            control={control}
                            render={({ field }) => (
                              <Select value={field.value} onValueChange={field.onChange}>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {units.map((unit) => (
                                    <SelectItem key={unit} value={unit}>
                                      {unit}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </div>
                        <div className="space-y-1 md:col-span-2 md:space-y-2">
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">{t('unit_price_label')}</Label>
                          <Input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            {...register(`items.${index}.unit_price`, { valueAsNumber: true })}
                          />
                        </div>
                      </div>

                      {/* Moms: hidden entirely when the company is not
                          momsregistrerad (no VAT may be charged). */}
                      {vatRegistered && (
                        <div className="space-y-1 md:col-span-2 md:space-y-2">
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">{t('vat_label')}</Label>
                          <Controller
                            name={`items.${index}.vat_rate`}
                            control={control}
                            render={({ field }) => (
                              <Select
                                value={String(field.value ?? 25)}
                                onValueChange={(v) => field.onChange(Number(v))}
                                disabled={isRateLocked}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableRates.map((opt) => (
                                    <SelectItem key={opt.rate} value={String(opt.rate)}>
                                      {opt.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </div>
                      )}

                      {/* Desktop row actions (⋮ menu or trash). An invisible
                          label spacer mirrors the field columns (same Label +
                          space-y-2), so the button sits on the input row, not
                          high against the labels, nor low at the row bottom. */}
                      <div className="hidden md:col-span-1 md:block md:space-y-2">
                        <Label className="invisible text-xs md:text-sm" aria-hidden="true">&nbsp;</Label>
                        <div className="flex justify-end">
                          {renderRowActions('')}
                        </div>
                      </div>

                      {/* ROT/RUT-avdrag strip: only when a deduction is active
                          on this row (chosen via the ⋮ menu). A leading tag shows
                          which reduction applies; the work-type + hours are
                          required for the Skatteverket claim. Rows with no
                          deduction render nothing here and stay clean. */}
                      {isInvoiceDoc && watchItems[index]?.deduction_type && (
                        <div className="md:col-span-12 mt-2 md:mt-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium tabular-nums text-muted-foreground">
                              {watchItems[index]?.deduction_type === 'rot' ? 'ROT 30%' : 'RUT 50%'}
                            </span>
                            <Controller
                              name={`items.${index}.work_type`}
                              control={control}
                              render={({ field: workField }) => {
                                const opts =
                                  watchItems[index]?.deduction_type === 'rot'
                                    ? ROT_WORK_TYPES
                                    : RUT_WORK_TYPES
                                return (
                                  <Select
                                    value={workField.value ?? ''}
                                    onValueChange={(v) => workField.onChange(v || null)}
                                  >
                                    <SelectTrigger className="h-8 w-56">
                                      <SelectValue placeholder={t('deduction_work_type_placeholder')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {opts.map((w) => (
                                        <SelectItem key={w.code} value={w.code}>
                                          {w.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )
                              }}
                            />
                            <Input
                              type="number"
                              step="0.5"
                              inputMode="decimal"
                              placeholder={t('deduction_hours_placeholder')}
                              className="h-8 w-32 text-right tabular-nums"
                              {...register(`items.${index}.labor_hours`, {
                                valueAsNumber: true,
                                setValueAs: (v) =>
                                  v === '' || Number.isNaN(v) ? null : Number(v),
                              })}
                            />
                            {(() => {
                              const amt = computeDeduction({
                                unit_price: watchItems[index]?.unit_price || 0,
                                quantity: watchItems[index]?.quantity || 0,
                                deduction_type: watchItems[index]?.deduction_type,
                              })
                              return amt > 0 ? (
                                <span className="text-xs tabular-nums text-muted-foreground">
                                  −{formatCurrency(amt, watchCurrency)}
                                </span>
                              ) : null
                            })()}
                          </div>
                          {/* Labor-only disclosure (Skatteverket fakturamodellen).
                              30%/50% applies to the full line total: the seller
                              must ensure the line is 100% labor; material has
                              to be invoiced separately. */}
                          <div className="mt-2 flex items-start gap-2 text-xs text-warning-foreground">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-warning shrink-0" />
                            <p>{t('deduction_labor_only_warning')}</p>
                          </div>
                        </div>
                      )}

                      {/* Periodisering (förutbetald intäkt): activated via the
                          row's ⋮ menu. Intäkten krediteras 29xx vid bokning och
                          löses upp månadsvis över perioden; momsen påverkas inte. */}
                      {canUseAccrual && watchItems[index]?.accrual_balance_account != null && (
                        <div className="md:col-span-12 mt-2 md:mt-3">
                          <AccrualPeriodControl
                            direction="revenue"
                            amount={lineTotal}
                            idPrefix={`accrual-invoice-${index}`}
                            value={{
                              start: watchItems[index]?.accrual_period_start ?? '',
                              end: watchItems[index]?.accrual_period_end ?? '',
                              balanceAccount:
                                watchItems[index]?.accrual_balance_account ||
                                DEFAULT_DEFERRED_REVENUE_ACCOUNT,
                            }}
                            onChange={(next) => {
                              setValue(`items.${index}.accrual_period_start`, next.start, { shouldDirty: true })
                              setValue(`items.${index}.accrual_period_end`, next.end, { shouldDirty: true })
                              setValue(`items.${index}.accrual_balance_account`, next.balanceAccount, { shouldDirty: true })
                            }}
                            onRemove={() => toggleAccrual(index)}
                          />
                          {errors.items?.[index]?.accrual_period_end && (
                            <p className="mt-1 text-sm text-destructive">
                              {errors.items[index].accrual_period_end?.message}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Optional försäljningskonto override (engångsartikel). When
                          unset the engine derives the revenue account from the VAT
                          rate; reverse-charge/export lines ignore the override. */}
                      {isInvoiceDoc && watchItems[index]?.line_type !== 'text' &&
                        (accountOverrideRows.has(index) || watchItems[index]?.revenue_account) && (
                        <div className="md:col-span-12 mt-2 md:mt-3">
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="min-w-[220px] flex-1 space-y-1 md:space-y-2">
                              <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">
                                {t('revenue_account_label')}
                              </Label>
                              <Controller
                                name={`items.${index}.revenue_account`}
                                control={control}
                                render={({ field }) => (
                                  <AccountCombobox
                                    value={field.value ?? ''}
                                    accounts={revenueAccounts}
                                    onChange={(v) => field.onChange(v || null)}
                                  />
                                )}
                              />
                            </div>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{t('revenue_account_hint')}</p>
                        </div>
                      )}

                      {/* Per-item dimensions override (dimensions PR7): opened
                          via the row's ⋮ menu. The bag is stored as-is; the
                          server merges it over the invoice's default_dimensions
                          for this item's revenue line at booking time. */}
                      {dimensionsEnabled && isInvoiceDoc && watchItems[index]?.line_type !== 'text' &&
                        (dimensionOverrideRows.has(index) || hasDimensionValues(watchItems[index]?.dimensions)) && (
                        <div className="md:col-span-12 mt-2 md:mt-3">
                          <div className="max-w-md">
                            <LineDimensionFields
                              dimensions={watchItems[index]?.dimensions ?? undefined}
                              onChange={(dimNo, code) => updateItemDimension(index, dimNo, code)}
                              inputClassName="h-8"
                            />
                          </div>
                          {hasDimensionValues(defaultDims) && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t('row_dimensions_inherit_hint', { dims: compactDims(defaultDims) })}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Mobile summary row */}
                      <div className="flex justify-between text-sm pt-1 border-t border-border/40 md:hidden">
                        <span className="text-muted-foreground">{t('row_label', { index: index + 1 })}</span>
                        <span className="font-medium tabular-nums">{formatCurrency(lineTotal + lineVat, watchCurrency)}</span>
                      </div>
                    </div>
                    </SortableRow>
                  )
                })}
                </Reorder.Group>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full md:w-auto"
                    onClick={() =>
                      append({
                        line_type: 'product',
                        description: '',
                        quantity: 1,
                        unit: 'st',
                        unit_price: 0,
                        vat_rate: vatRegistered ? (availableRates[0]?.rate ?? 25) : 0,
                        article_id: null,
                        revenue_account: null,
                        deduction_type: null,
                        labor_hours: null,
                        work_type: null,
                        housing_designation: null,
                        apartment_number: null,
                        brf_org_number: null,
                        accrual_period_start: null,
                        accrual_period_end: null,
                        accrual_balance_account: null,
                        dimensions: null,
                      })
                    }
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t('add_row')}
                  </Button>
                  {/* Free-text / blank row: explanatory text under an item, or
                      an empty spacer. Carries no amounts and never books. Not
                      offered for a received självfaktura: that is a faithful
                      revenue-only transcription, and the self-billed endpoint
                      (SelfBillingInvoiceItemSchema) has no line_type and rejects
                      zero-amount rows. */}
                  {!isSelfBilled && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full md:w-auto text-muted-foreground"
                      onClick={() =>
                        append({
                          line_type: 'text',
                          description: '',
                          quantity: 0,
                          unit: '',
                          unit_price: 0,
                          vat_rate: 0,
                          article_id: null,
                          revenue_account: null,
                          deduction_type: null,
                          labor_hours: null,
                          work_type: null,
                          housing_designation: null,
                          apartment_number: null,
                          brf_org_number: null,
                          accrual_period_start: null,
                          accrual_period_end: null,
                          accrual_balance_account: null,
                          dimensions: null,
                        })
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {t('add_text_row')}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

            {/* ROT/RUT-avdrag claim info. Surfaces only when any item has
                a deduction_type set: keeps the form quiet for the 90%+
                of users who don't sell ROT/RUT-eligible services. */}
            {isInvoiceDoc && hasAnyDeduction && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('deduction_card_title')}</CardTitle>
                  <CardDescription>{t('deduction_card_description')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="deduction_personnummer">
                      {t('deduction_personnummer_label')}<RequiredMark />
                    </Label>
                    <Input
                      id="deduction_personnummer"
                      placeholder={t('deduction_personnummer_placeholder')}
                      autoComplete="off"
                      {...register('deduction_personnummer')}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('deduction_personnummer_hint')}
                    </p>
                  </div>
                  {hasAnyRotLine && (
                    <div className="space-y-2">
                      <Label htmlFor="deduction_housing_designation">
                        {t('deduction_housing_label')}<RequiredMark />
                      </Label>
                      <Input
                        id="deduction_housing_designation"
                        placeholder={t('deduction_housing_placeholder')}
                        {...register('deduction_housing_designation')}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('deduction_housing_hint')}
                      </p>
                    </div>
                  )}
                  {(deductionByKind.rot > ROT_MAX || deductionByKind.rut > RUT_MAX) && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      {t('deduction_cap_over')}
                      {deductionByKind.rot > ROT_MAX && ` (ROT ${ROT_MAX.toLocaleString('sv-SE')} kr)`}
                      {deductionByKind.rut > RUT_MAX && ` (RUT ${RUT_MAX.toLocaleString('sv-SE')} kr)`}
                      {'. '}
                      {t('deduction_cap_check')}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Notes */}
            <Card>
              <CardHeader>
                <CardTitle>{t('notes_card_title')}</CardTitle>
              <CardDescription>{t('notes_card_description')}</CardDescription>
            </CardHeader>
              <CardContent>
                <Textarea
                  placeholder={t('notes_placeholder')}
                  {...register('notes')}
                />
              </CardContent>
            </Card>
          </div>

          {/* Sidebar: sticky so totals + action stay visible while scrolling items */}
          <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            {/* Invoice details */}
            <Card>
              <CardHeader>
                <CardTitle>{t('details_card_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!isSelfBilled && (
                <div className="space-y-2">
                  <Label>{t('document_type_label')}</Label>
                  <Controller
                    name="document_type"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="invoice">{t('doctype_invoice')}</SelectItem>
                          <SelectItem value="proforma">{t('doctype_proforma')}</SelectItem>
                          <SelectItem value="delivery_note">{t('doctype_delivery_note')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label>{t('currency_label')}</Label>
                <Controller
                  name="currency"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {currencies.map((currency) => (
                          <SelectItem key={currency} value={currency}>
                            {currency}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label>{t('invoice_date_label')}<RequiredMark /></Label>
                <Input type="date" {...register('invoice_date')} aria-required="true" />
              </div>

              <div className="space-y-2">
                <Label>{t('due_date_label')}<RequiredMark /></Label>
                <Input type="date" {...register('due_date')} aria-required="true" />
              </div>

              {isSelfBilled && (
                <div className="space-y-2">
                  <Label>{ts('received_date_label')}<RequiredMark /></Label>
                  <Input type="date" {...register('received_date')} aria-required="true" />
                  {errors.received_date && (
                    <p className="text-sm text-destructive">{errors.received_date.message}</p>
                  )}
                </div>
              )}

              {watchDocumentType === 'invoice' && !isSelfBilled && (
                <div className="space-y-2">
                  <Label>{t('delivery_date_label')}</Label>
                  <Input type="date" {...register('delivery_date')} placeholder={t('delivery_date_placeholder')} />
                </div>
              )}

              {!isSelfBilled && (
                <>
                  <Separator />

                  <div className="space-y-2">
                    <Label>{t('your_reference_label')}</Label>
                    <Controller
                      name="your_reference"
                      control={control}
                      render={({ field }) => (
                        <TagInput
                          value={field.value ?? ''}
                          onChange={field.onChange}
                          placeholder={t('your_reference_placeholder')}
                        />
                      )}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>{t('our_reference_label')}</Label>
                    <Controller
                      name="our_reference"
                      control={control}
                      render={({ field }) => (
                        <TagInput
                          value={field.value ?? ''}
                          onChange={field.onChange}
                          placeholder={t('our_reference_placeholder')}
                        />
                      )}
                    />
                  </div>

                  {/* Invoice-level default dims (kostnadsställe/projekt):
                      written to every generated journal line; per-item bags
                      (row ⋮ menu) merge on top. Renders only when dimensions
                      are enabled for the company and the doc actually books. */}
                  {dimensionsEnabled && isInvoiceDoc && (
                    <>
                      <Separator />
                      <div className="space-y-1">
                        <LineDimensionFields
                          dimensions={defaultDims}
                          onChange={setDefaultDimension}
                          inputClassName="h-9"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('dimensions_default_hint')}
                        </p>
                      </div>
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Summary */}
            <Card>
              <CardHeader>
                <CardTitle>{t('summary_card_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('subtotal_label')}</span>
                <span>{formatCurrency(subtotal, watchCurrency)}</span>
              </div>
              {/* VAT rows: only when momsregistrerad. A non-registered company
                  shows no moms line at all (subtotal === total). */}
              {vatRegistered && Array.from(vatByRate.entries())
                .sort(([a], [b]) => b - a)
                .map(([rate, group]) => (
                  <div key={rate}>
                    {vatByRate.size > 1 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('net_at_rate', { rate })}</span>
                        <span>{formatCurrency(group.base, watchCurrency)}</span>
                      </div>
                    )}
                    {group.vat > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('vat_at_rate', { rate })}</span>
                        <span>{formatCurrency(group.vat, watchCurrency)}</span>
                      </div>
                    )}
                  </div>
                ))}
              {vatRegistered && vatByRate.size === 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('vat_label_short')}</span>
                  <span>{formatCurrency(0, watchCurrency)}</span>
                </div>
              )}
              {hasAnyDeduction && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('deduction_summary_label')}</span>
                  <span className="tabular-nums">−{formatCurrency(deductionTotal, watchCurrency)}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between font-bold text-lg">
                <span>{hasAnyDeduction ? t('to_pay_label') : t('total_label')}</span>
                <span>{formatCurrency(hasAnyDeduction ? toPay : total, watchCurrency)}</span>
              </div>
              {hasAnyDeduction && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{t('total_incl_vat_label')}</span>
                  <span className="tabular-nums">{formatCurrency(total, watchCurrency)}</span>
                </div>
              )}
              {/* Öresavrundning: display-only rounding of the invoice total to
                  whole kronor (SEK only). The exact amount stays in the books;
                  this only changes what's shown on the PDF, list and detail.
                  Defaults to the company setting (company_settings.ore_rounding). */}
              {watchCurrency === 'SEK' && (
                <>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
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
                </>
              )}
            </CardContent>
          </Card>

            {/* Actions: desktop/tablet only. In bare (dialog) mode the fixed
                mobile bar is unusable (DialogContent's transform re-anchors
                `fixed` children), so these buttons show at every width. */}
            <div className={bare ? 'flex flex-col gap-2' : 'hidden md:flex md:flex-col md:gap-2'}>
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={isSubmitting || isSavingDraft || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
                {isEditMode && isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEditMode ? t('save_changes') : isSelfBilled ? ts('register') : t('review_and_create')}
              </Button>
              {!isEditMode && !isSelfBilled && watchDocumentType === 'invoice' && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  size="lg"
                  disabled={isSubmitting || isSavingDraft || !canWrite}
                  title={!canWrite ? t('viewer_disabled_tooltip') : t('save_as_draft_tooltip')}
                  onClick={handleSubmit(saveDraftData)}
                >
                  {isSavingDraft ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t('save_as_draft')}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Mobile sticky total bar: page mode only (see bare note above) */}
        {!bare && (
        <div className="md:hidden fixed left-0 right-0 z-40 bg-card/98 backdrop-blur-sm border-t border-border/40 px-5 py-3" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}>
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">
                {hasAnyDeduction ? t('to_pay_label') : t('total_label')}
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCurrency(hasAnyDeduction ? toPay : total, watchCurrency)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!isEditMode && !isSelfBilled && watchDocumentType === 'invoice' && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting || isSavingDraft || !canWrite}
                  onClick={handleSubmit(saveDraftData)}
                >
                  {isSavingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : t('save_as_draft_short')}
                </Button>
              )}
              <Button
                type="submit"
                disabled={isSubmitting || isSavingDraft || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
                {isEditMode && isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEditMode ? t('save_changes') : isSelfBilled ? ts('register') : t('review_and_create')}
              </Button>
            </div>
          </div>
        </div>
        )}
      </form>

      {selectedCustomer && vatRules && (
        <ConfirmationDialog
          open={showReview}
          onOpenChange={setShowReview}
          onConfirm={handleConfirm}
          isSubmitting={isSubmitting}
          title={watchDocumentType === 'proforma'
            ? t('review_dialog_title_proforma')
            : watchDocumentType === 'delivery_note'
              ? t('review_dialog_title_delivery_note')
              : t('review_dialog_title_invoice')}
          warningText={watchDocumentType === 'invoice'
            ? accountingMethod === 'cash'
              ? t('review_warning_invoice_cash')
              : t('review_warning_invoice_accrual')
            : watchDocumentType === 'proforma'
              ? t('review_warning_proforma')
              : t('review_warning_delivery_note')}
          confirmLabel={watchDocumentType === 'proforma'
            ? t('confirm_create_proforma')
            : watchDocumentType === 'delivery_note'
              ? t('confirm_create_delivery_note')
              : t('confirm_create_invoice')}
          extraActions={
            <Button
              variant="outline"
              onClick={handlePreviewPDF}
              disabled={isPreviewing || isSubmitting}
            >
              {isPreviewing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              {isPreviewing ? t('preview_pdf_generating') : t('preview_pdf')}
            </Button>
          }
        >
          <InvoiceReviewContent
            customer={selectedCustomer}
            invoiceDate={pendingData?.invoice_date || ''}
            dueDate={pendingData?.due_date || ''}
            currency={(pendingData?.currency || 'SEK') as Currency}
            items={(pendingData?.items || []).map((item) => ({
              ...item,
              vat_rate: vatRegistered ? (item.vat_rate ?? (vatRules?.rate || 25)) : 0,
            }))}
            subtotal={subtotal}
            vatAmount={vatAmount}
            total={total}
            yourReference={pendingData?.your_reference}
            ourReference={pendingData?.our_reference}
            notes={pendingData?.notes}
            numberPreview={numberPreview}
            oreRounding={oreRounding}
            vatRegistered={vatRegistered}
          />
        </ConfirmationDialog>
      )}

      {/* Create customer dialog */}
      <Dialog open={isCreateCustomerOpen} onOpenChange={setIsCreateCustomerOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('create_customer_dialog_title')}</DialogTitle>
          </DialogHeader>
          <CustomerForm
            onSubmit={handleCreateCustomer}
            isLoading={isCreatingCustomer}
          />
        </DialogContent>
      </Dialog>

      {/* Bank details setup dialog */}
      <BankDetailsSetupDialog
        open={showBankSetup}
        onOpenChange={setShowBankSetup}
        onComplete={handleBankSetupComplete}
      />

      {/* First-invoice logo prompt (issue #520) */}
      <FirstInvoiceLogoPrompt
        open={showLogoPrompt}
        onClose={handleLogoPromptClose}
        logoUrl={logoUrl}
        onLogoUpdate={(url) => setLogoUrl(url)}
      />

      {/* Send now prompt dialog */}
      <Dialog open={showSendPrompt} onOpenChange={(open) => {
        if (!open && createdInvoiceId) {
          setShowSendPrompt(false)
          router.push(`/invoices/${createdInvoiceId}`)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('send_now_dialog_title')}</DialogTitle>
            <DialogDescription>
              {t('send_now_dialog_description', { email: selectedCustomer?.email ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setShowSendPrompt(false)
                if (createdInvoiceId) router.push(`/invoices/${createdInvoiceId}`)
              }}
              disabled={isSending}
            >
              {t('send_later')}
            </Button>
            <Button onClick={handleSendNow} disabled={isSending}>
              {isSending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {isSending ? t('send_now_sending') : t('send_now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
