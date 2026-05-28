'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
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
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, Trash2, ArrowLeft, Send, Eye, Landmark, Lock, AlertTriangle } from 'lucide-react'
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
import type { Customer, Currency, CreateInvoiceInput, CreateCustomerInput, InvoiceDocumentType } from '@/types'

const currencies: Currency[] = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']
const units = ['st', 'tim', 'dag', 'månad', 'km', 'kg']

function RequiredMark() {
  return <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
}

export default function NewInvoicePage() {
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  const supabase = createClient()
  const t = useTranslations('invoice_editor')

  const schema = useMemo(() => {
    const itemSchema = z.object({
      description: z.string().min(1, t('validation_description_required')),
      quantity: z.number().min(0.01, t('validation_quantity_min')),
      unit: z.string().min(1, t('validation_unit_required')),
      unit_price: z.number().min(0, t('validation_price_positive')),
      vat_rate: z.number().min(0).max(25),
      // ROT/RUT-avdrag per line. Optional — null means "no deduction".
      deduction_type: z.enum(['rot', 'rut']).nullable().optional(),
      labor_hours: z.number().nonnegative().nullable().optional(),
      work_type: z.string().nullable().optional(),
      housing_designation: z.string().nullable().optional(),
      apartment_number: z.string().nullable().optional(),
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
      // Invoice-level ROT/RUT claim info. Personnummer is plaintext on
      // the wire; the API encrypts it before storage.
      deduction_personnummer: z.string().optional(),
      deduction_housing_designation: z.string().optional(),
      items: z.array(itemSchema).min(1, t('validation_min_one_row')),
    })
  }, [t])

  type FormData = z.infer<typeof schema>

  const [customers, setCustomers] = useState<Customer[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
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
  const [oreRounding, setOreRounding] = useState<boolean>(true)
  const [vatRegistered, setVatRegistered] = useState<boolean>(true)
  const [numberPreview, setNumberPreview] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  // True only when the user had zero invoices when this page loaded. The
  // post-create flow uses this to offer a one-shot "upload a logo?" prompt
  // — issue #520. Self-limits: once count > 0 it stays false.
  const [hadZeroInvoices, setHadZeroInvoices] = useState<boolean | null>(null)
  const [showLogoPrompt, setShowLogoPrompt] = useState(false)
  const pendingCustomerRef = useRef<Customer | null>(null)

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      customer_id: '',
      invoice_date: '',
      due_date: '',
      currency: 'SEK',
      document_type: 'invoice' as InvoiceDocumentType,
      items: [{
        description: '',
        quantity: 1,
        unit: 'st',
        unit_price: 0,
        vat_rate: 25,
        deduction_type: null,
        labor_hours: null,
        work_type: null,
        housing_designation: null,
        apartment_number: null,
      }],
    },
  })

  useUnsavedChanges(isDirty)

  // Set date defaults on client only to avoid hydration mismatch
  useEffect(() => {
    setValue('invoice_date', format(new Date(), 'yyyy-MM-dd'))
    setValue('due_date', format(addDays(new Date(), 30), 'yyyy-MM-dd'))
  }, [])

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'items',
  })

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
  }, [company?.id])

  async function fetchDefaultNotes() {
    if (!company?.id) return
    const { data } = await supabase
      .from('company_settings')
      .select('invoice_default_notes, clearing_number, account_number, bankgiro, accounting_method, ore_rounding, logo_url, vat_registered')
      .eq('company_id', company.id)
      .single()
    if (data?.invoice_default_notes) {
      setDefaultNotes(data.invoice_default_notes)
      setValue('notes', data.invoice_default_notes)
    }
    setHasBankDetails(
      !!(data?.clearing_number && data?.account_number) || !!data?.bankgiro
    )
    if (data?.accounting_method === 'cash' || data?.accounting_method === 'accrual') {
      setAccountingMethod(data.accounting_method)
    }
    if (typeof data?.ore_rounding === 'boolean') {
      setOreRounding(data.ore_rounding)
    }
    setLogoUrl(data?.logo_url ?? null)
    if (typeof data?.vat_registered === 'boolean') {
      setVatRegistered(data.vat_registered)
    }
  }

  // First-invoice detection (issue #520): captured at page load so the
  // post-create flow can offer the logo prompt for genuinely first-time
  // invoices only. head:true keeps it cheap — no rows pulled.
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
    if (watchDocumentType === 'delivery_note') {
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

      // Update due date based on customer payment terms
      if (customer?.default_payment_terms) {
        setValue(
          'due_date',
          format(addDays(new Date(), customer.default_payment_terms), 'yyyy-MM-dd')
        )
      }

      // When the customer forces a single rate (reverse charge/export),
      // update all lines so the picker can't leave stale 25% values behind.
      if (customer) {
        const rates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
        if (rates.length === 1) {
          const forcedRate = rates[0].rate
          watchItems.forEach((_, i) => {
            setValue(`items.${i}.vat_rate`, forcedRate)
          })
        }
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
  // Show a warning when a non-registered seller has picked any non-zero VAT
  // rate. ML 16 kap. 23 § (faktureringsmoms): stated VAT is owed to
  // Skatteverket regardless of registration, but the buyer cannot deduct it
  // as input VAT — so we surface the consequence rather than block the input.
  const hasNonZeroVat = watchItems.some((item) => (item?.vat_rate ?? 0) > 0)
  const showNotRegisteredVatWarning = !vatRegistered && hasNonZeroVat

  // Calculate per-item VAT
  const vatByRate = new Map<number, { base: number; vat: number }>()
  let vatAmount = 0
  for (const item of watchItems) {
    const rate = item.vat_rate ?? (vatRules?.rate || 25)
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
  const isInvoiceDoc = watchDocumentType === 'invoice'
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

  async function onSubmit(data: FormData) {
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
    const sanitizedItems = pendingData.items.map((item) => {
      if (item.deduction_type) return item
      const {
        deduction_type: _dt,
        labor_hours: _lh,
        work_type: _wt,
        housing_designation: _hd,
        apartment_number: _an,
        ...rest
      } = item
      return rest
    })
    const sanitizedPayload: CreateInvoiceInput = {
      ...(pendingData as CreateInvoiceInput),
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

  const titleText = watchDocumentType === 'proforma'
    ? t('title_proforma')
    : watchDocumentType === 'delivery_note'
      ? t('title_delivery_note')
      : t('title_invoice')
  const subtitleText = watchDocumentType === 'proforma'
    ? t('subtitle_proforma')
    : watchDocumentType === 'delivery_note'
      ? t('subtitle_delivery_note')
      : t('subtitle_invoice')

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label={t('back')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
            {titleText}
            {numberPreview && (
              <span className="ml-2 text-muted-foreground tabular-nums text-xl md:text-2xl">
                ({numberPreview})
              </span>
            )}
          </h1>
          <p className="text-muted-foreground">{subtitleText}</p>
        </div>
        <AgentSparkleButton
          intentId="invoice.draft"
          intentArgs={{ customer_id: watchCustomerId ?? null }}
          contextRef={watchCustomerId ? `customer:${watchCustomerId}` : 'invoice:new'}
        />
      </div>

      {hasBankDetails === false && (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm">
          <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">{t('bank_missing_warning')}</p>
          <Button variant="link" size="sm" className="ml-auto shrink-0 px-0" onClick={() => setShowBankSetup(true)}>
            {t('bank_add_now')}
          </Button>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 pb-28 md:pb-0">
        <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
          {/* Main content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Customer selection */}
            <Card>
            <CardHeader>
              <CardTitle>{t('customer_card_title')}<RequiredMark /></CardTitle>
              <CardDescription>{t('customer_card_description')}</CardDescription>
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

            </CardContent>
          </Card>

            {/* Invoice items */}
            <Card>
              <CardHeader>
                <CardTitle>{t('items_card_title')}</CardTitle>
              <CardDescription>{t('items_card_description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {showNotRegisteredVatWarning && (
                <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-secondary/60 px-4 py-3 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                  <p className="text-muted-foreground">
                    Du är inte momsregistrerad. Om du ändå tar ut moms är du
                    enligt ML 16 kap. 23 § skyldig att betala in den till
                    Skatteverket, men din kund får inte dra av den som ingående
                    moms. Om du har börjat bedriva momspliktig verksamhet bör
                    du först registrera dig för moms.
                  </p>
                </div>
              )}
              <div className="space-y-4">
                {fields.map((field, index) => {
                  const lineTotal = (watchItems[index]?.quantity || 0) * (watchItems[index]?.unit_price || 0)
                  const lineVat = Math.round(lineTotal * (watchItems[index]?.vat_rate ?? 25) / 100 * 100) / 100
                  return (
                    <div
                      key={field.id}
                      className="rounded-lg border bg-card p-4 space-y-3 relative md:rounded-none md:border-0 md:bg-transparent md:p-0 md:space-y-0 md:grid md:grid-cols-12 md:gap-4 md:items-start"
                    >
                      {/* Description + mobile delete button */}
                      <div className="flex items-start gap-2 md:contents">
                        <div className="flex-1 space-y-1 md:col-span-3 md:space-y-2">
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0 min-h-[44px] min-w-[44px] -mr-2 -mt-1 md:hidden"
                          onClick={() => remove(index)}
                          disabled={fields.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
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

                      {/* Moms */}
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

                      {/* Desktop delete button */}
                      <div className="hidden md:flex md:col-span-1 md:items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(index)}
                          disabled={fields.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      {/* ROT/RUT-avdrag per-row controls. Only shown on real
                          invoices — proformas and delivery notes have no
                          deduction model. Collapsed to a tiny segmented
                          toggle by default; selecting ROT or RUT reveals the
                          work-type picker. */}
                      {isInvoiceDoc && (
                        <div className="md:col-span-12 mt-2 md:mt-3">
                          <Controller
                            name={`items.${index}.deduction_type`}
                            control={control}
                            render={({ field }) => {
                              const value = field.value ?? 'none'
                              return (
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs text-muted-foreground">Skattereduktion:</span>
                                  <Select
                                    value={value}
                                    onValueChange={(v) => {
                                      const next = v === 'none' ? null : (v as 'rot' | 'rut')
                                      field.onChange(next)
                                      if (next === null) {
                                        setValue(`items.${index}.work_type`, null)
                                        setValue(`items.${index}.labor_hours`, null)
                                        setValue(`items.${index}.housing_designation`, null)
                                        setValue(`items.${index}.apartment_number`, null)
                                      }
                                    }}
                                  >
                                    <SelectTrigger className="h-8 w-32">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="none">Ingen</SelectItem>
                                      <SelectItem value="rot">ROT (30%)</SelectItem>
                                      <SelectItem value="rut">RUT (50%)</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  {watchItems[index]?.deduction_type && (
                                    <>
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
                                                <SelectValue placeholder="Välj arbetstyp" />
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
                                        placeholder="Arbetstimmar"
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
                                    </>
                                  )}
                                </div>
                              )
                            }}
                          />
                          {/* Labor-only disclosure (Skatteverket fakturamodellen).
                              30%/50% applies to the full line total — the seller
                              must ensure the line is 100% labor; material has
                              to be invoiced separately. */}
                          {watchItems[index]?.deduction_type && (
                            <div className="mt-2 flex items-start gap-2 text-xs text-warning-foreground">
                              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-warning shrink-0" />
                              <p>
                                Skatteverket kräver att endast arbetskostnad ingår i ROT/RUT-grundlaget. Material ska faktureras separat. Sätt endast skattereduktion på rader som är 100% arbete.
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Mobile summary row */}
                      <div className="flex justify-between text-sm pt-1 border-t border-border/40 md:hidden">
                        <span className="text-muted-foreground">{t('row_label', { index: index + 1 })}</span>
                        <span className="font-medium tabular-nums">{formatCurrency(lineTotal + lineVat, watchCurrency)}</span>
                      </div>
                    </div>
                  )
                })}

                <Button
                  type="button"
                  variant="outline"
                  className="w-full md:w-auto"
                  onClick={() =>
                    append({
                      description: '',
                      quantity: 1,
                      unit: 'st',
                      unit_price: 0,
                      vat_rate: availableRates[0]?.rate ?? 25,
                      deduction_type: null,
                      labor_hours: null,
                      work_type: null,
                      housing_designation: null,
                      apartment_number: null,
                    })
                  }
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t('add_row')}
                </Button>
              </div>
            </CardContent>
          </Card>

            {/* ROT/RUT-avdrag claim info. Surfaces only when any item has
                a deduction_type set — keeps the form quiet for the 90%+
                of users who don't sell ROT/RUT-eligible services. */}
            {isInvoiceDoc && hasAnyDeduction && (
              <Card>
                <CardHeader>
                  <CardTitle>Underlag för skattereduktion</CardTitle>
                  <CardDescription>
                    ROT/RUT-avdrag begärs hos Skatteverket via fakturamodellen. Kunden behöver godkänna utbetalningen, så uppgifterna måste matcha köparen exakt.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="deduction_personnummer">
                      Personnummer<RequiredMark />
                    </Label>
                    <Input
                      id="deduction_personnummer"
                      placeholder="ÅÅÅÅMMDD-NNNN"
                      autoComplete="off"
                      {...register('deduction_personnummer')}
                    />
                    <p className="text-xs text-muted-foreground">
                      Krypteras innan lagring. Endast de fyra sista siffrorna visas på fakturan.
                    </p>
                  </div>
                  {hasAnyRotLine && (
                    <div className="space-y-2">
                      <Label htmlFor="deduction_housing_designation">
                        Fastighetsbeteckning<RequiredMark />
                      </Label>
                      <Input
                        id="deduction_housing_designation"
                        placeholder="t.ex. Stockholm Vasastan 1:23"
                        {...register('deduction_housing_designation')}
                      />
                      <p className="text-xs text-muted-foreground">
                        Krävs för ROT-avdrag (RUT behöver inte detta fält).
                      </p>
                    </div>
                  )}
                  {(deductionByKind.rot > ROT_MAX || deductionByKind.rut > RUT_MAX) && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      Fakturans avdrag överstiger årstaket
                      {deductionByKind.rot > ROT_MAX && ` (ROT ${ROT_MAX.toLocaleString('sv-SE')} kr)`}
                      {deductionByKind.rut > RUT_MAX && ` (RUT ${RUT_MAX.toLocaleString('sv-SE')} kr)`}
                      . Kunden behöver kontrollera sitt återstående utrymme själv.
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

          {/* Sidebar — sticky so totals + action stay visible while scrolling items */}
          <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            {/* Invoice details */}
            <Card>
              <CardHeader>
                <CardTitle>{t('details_card_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
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

              {watchDocumentType === 'invoice' && (
                <div className="space-y-2">
                  <Label>{t('delivery_date_label')}</Label>
                  <Input type="date" {...register('delivery_date')} placeholder={t('delivery_date_placeholder')} />
                </div>
              )}

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
              {Array.from(vatByRate.entries())
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
              {vatByRate.size === 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('vat_label_short')}</span>
                  <span>{formatCurrency(0, watchCurrency)}</span>
                </div>
              )}
              {hasAnyDeduction && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Skattereduktion ROT/RUT</span>
                  <span className="tabular-nums">−{formatCurrency(deductionTotal, watchCurrency)}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between font-bold text-lg">
                <span>{hasAnyDeduction ? 'Att betala' : t('total_label')}</span>
                <span>{formatCurrency(hasAnyDeduction ? toPay : total, watchCurrency)}</span>
              </div>
              {hasAnyDeduction && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Totalt inkl. moms</span>
                  <span className="tabular-nums">{formatCurrency(total, watchCurrency)}</span>
                </div>
              )}
            </CardContent>
          </Card>

            {/* Actions — desktop/tablet only */}
            <Button
              type="submit"
              className="w-full hidden md:block"
              size="lg"
              disabled={isSubmitting || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
              {t('review_and_create')}
            </Button>
          </div>
        </div>

        {/* Mobile sticky total bar */}
        <div className="md:hidden fixed left-0 right-0 z-40 bg-card/98 backdrop-blur-sm border-t border-border/40 px-5 py-3" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}>
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">
                {hasAnyDeduction ? 'Att betala' : t('total_label')}
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCurrency(hasAnyDeduction ? toPay : total, watchCurrency)}
              </p>
            </div>
            <Button
              type="submit"
              disabled={isSubmitting || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
              {t('review_and_create')}
            </Button>
          </div>
        </div>
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
              vat_rate: item.vat_rate ?? (vatRules?.rate || 25),
            }))}
            subtotal={subtotal}
            vatAmount={vatAmount}
            total={total}
            yourReference={pendingData?.your_reference}
            ourReference={pendingData?.our_reference}
            notes={pendingData?.notes}
            numberPreview={numberPreview}
            oreRounding={oreRounding}
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
