'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
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
import { Loader2, Plus, Trash2, ArrowLeft, Send, Eye, Landmark, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { InvoiceReviewContent } from '@/components/invoices/InvoiceReviewContent'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import CustomerForm from '@/components/customers/CustomerForm'
import { BankDetailsSetupDialog } from '@/components/invoices/BankDetailsSetupDialog'
import { useCompany } from '@/contexts/CompanyContext'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import type { Customer, Currency, CreateInvoiceInput, CreateCustomerInput, InvoiceDocumentType } from '@/types'

const itemSchema = z.object({
  description: z.string().min(1, 'Beskrivning krävs'),
  quantity: z.number().min(0.01, 'Minst 0.01'),
  unit: z.string().min(1, 'Enhet krävs'),
  unit_price: z.number().min(0, 'Pris måste vara positivt'),
  vat_rate: z.number().min(0).max(25),
})

const schema = z.object({
  customer_id: z.string().min(1, 'Välj en kund'),
  invoice_date: z.string().min(1, 'Fakturadatum krävs'),
  due_date: z.string().min(1, 'Förfallodatum krävs'),
  delivery_date: z.string().optional(),
  currency: z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']),
  document_type: z.enum(['invoice', 'proforma', 'delivery_note']),
  your_reference: z.string().optional(),
  our_reference: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(itemSchema).min(1, 'Minst en rad krävs'),
})

type FormData = z.infer<typeof schema>

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
  const [numberPreview, setNumberPreview] = useState<string | null>(null)
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
      items: [{ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: 25 }],
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
      .select('invoice_default_notes, clearing_number, account_number, bankgiro, accounting_method, ore_rounding')
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
  }

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

      // When customer forces a single rate (reverse charge/export), update all lines
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
        title: 'Kunde inte ladda kunder',
        description: 'Kontrollera din anslutning och försök igen.',
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
        title: 'Kunde inte skapa kund',
        description: getErrorMessage(result, { context: 'customer' }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: 'Kund skapad',
        description: `${data.name} har lagts till`,
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

  async function onSubmit(data: FormData) {
    setPendingData(data)
    // Re-fetch the preview right before review so the displayed number
    // reflects any concurrent invoice creations.
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

  async function handleConfirm() {
    if (!pendingData) return
    setIsSubmitting(true)

    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingData as CreateInvoiceInput),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }

      const docLabel = watchDocumentType === 'proforma' ? 'Proformafaktura' : watchDocumentType === 'delivery_note' ? 'Följesedel' : 'Faktura'
      toast({
        title: `${docLabel} skapad`,
        description: `${docLabel} ${result.data.invoice_number} har skapats`,
      })

      setShowReview(false)

      // If customer has email, offer to send immediately
      if (selectedCustomer?.email) {
        setCreatedInvoiceId(result.data.id)
        setShowSendPrompt(true)
      } else {
        router.push(`/invoices/${result.data.id}`)
      }
    } catch (error) {
      toast({
        title: 'Kunde inte skapa faktura',
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
        title: 'Faktura skickad',
        description: `Fakturan har skickats till ${selectedCustomer?.email}`,
      })
    } catch (error) {
      toast({
        title: 'Kunde inte skicka faktura',
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
        title: 'Kunde inte generera PDF',
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

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label="Tillbaka">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
            {watchDocumentType === 'proforma' ? 'Ny proformafaktura' : watchDocumentType === 'delivery_note' ? 'Ny följesedel' : 'Ny faktura'}
            {numberPreview && (
              <span className="ml-2 text-muted-foreground tabular-nums text-xl md:text-2xl">
                ({numberPreview})
              </span>
            )}
          </h1>
          <p className="text-muted-foreground">
            {watchDocumentType === 'proforma' ? 'Skapa en proformafaktura (ingen bokföring)' : watchDocumentType === 'delivery_note' ? 'Skapa en följesedel (utan priser)' : 'Skapa en ny faktura'}
          </p>
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
          <p className="text-muted-foreground">Betalningsuppgifter saknas — du behöver lägga till dem innan du skapar en faktura.</p>
          <Button variant="link" size="sm" className="ml-auto shrink-0 px-0" onClick={() => setShowBankSetup(true)}>
            Lägg till nu
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
              <CardTitle>Kund<RequiredMark /></CardTitle>
              <CardDescription>Välj vilken kund fakturan ska skickas till</CardDescription>
            </CardHeader>
            <CardContent>
              <Controller
                name="customer_id"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Välj kund" />
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
                Skapa kund
              </Button>
              {errors.customer_id && (
                <p className="text-sm text-destructive mt-2">{errors.customer_id.message}</p>
              )}

            </CardContent>
          </Card>

            {/* Invoice items */}
            <Card>
              <CardHeader>
                <CardTitle>Fakturarader</CardTitle>
              <CardDescription>Lägg till produkter eller tjänster</CardDescription>
            </CardHeader>
            <CardContent>
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
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">Beskrivning</Label>
                          <Input
                            placeholder="T.ex. Instagram-kampanj"
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
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">Antal</Label>
                          <Input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                          />
                        </div>
                        <div className="space-y-1 md:col-span-2 md:space-y-2">
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">Enhet</Label>
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
                          <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">à-pris</Label>
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
                        <Label className="text-xs text-muted-foreground md:text-sm md:text-foreground">Moms</Label>
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

                      {/* Mobile summary row */}
                      <div className="flex justify-between text-sm pt-1 border-t border-border/40 md:hidden">
                        <span className="text-muted-foreground">Rad {index + 1}</span>
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
                    append({ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: availableRates[0]?.rate ?? 25 })
                  }
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Lägg till rad
                </Button>
              </div>
            </CardContent>
          </Card>

            {/* Notes */}
            <Card>
              <CardHeader>
                <CardTitle>Anteckningar</CardTitle>
              <CardDescription>Valfritt meddelande på fakturan</CardDescription>
            </CardHeader>
              <CardContent>
                <Textarea
                  placeholder="T.ex. betalningsvillkor eller tack för samarbetet..."
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
                <CardTitle>Fakturadetaljer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Dokumenttyp</Label>
                <Controller
                  name="document_type"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="invoice">Faktura</SelectItem>
                        <SelectItem value="proforma">Proformafaktura</SelectItem>
                        <SelectItem value="delivery_note">Följesedel</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label>Valuta</Label>
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
                <Label>Fakturadatum<RequiredMark /></Label>
                <Input type="date" {...register('invoice_date')} aria-required="true" />
              </div>

              <div className="space-y-2">
                <Label>Förfallodatum<RequiredMark /></Label>
                <Input type="date" {...register('due_date')} aria-required="true" />
              </div>

              {watchDocumentType === 'invoice' && (
                <div className="space-y-2">
                  <Label>Leveransdatum</Label>
                  <Input type="date" {...register('delivery_date')} placeholder="Om det skiljer sig från fakturadatum" />
                </div>
              )}

              <Separator />

              <div className="space-y-2">
                <Label>Er referens</Label>
                <Controller
                  name="your_reference"
                  control={control}
                  render={({ field }) => (
                    <TagInput
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      placeholder="Kontaktperson hos kund"
                    />
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label>Vår referens</Label>
                <Controller
                  name="our_reference"
                  control={control}
                  render={({ field }) => (
                    <TagInput
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      placeholder="Ditt namn"
                    />
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* Summary */}
            <Card>
              <CardHeader>
                <CardTitle>Summering</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Delsumma</span>
                <span>{formatCurrency(subtotal, watchCurrency)}</span>
              </div>
              {Array.from(vatByRate.entries())
                .sort(([a], [b]) => b - a)
                .map(([rate, group]) => (
                  <div key={rate}>
                    {vatByRate.size > 1 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Netto {rate}%</span>
                        <span>{formatCurrency(group.base, watchCurrency)}</span>
                      </div>
                    )}
                    {group.vat > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Moms {rate}%</span>
                        <span>{formatCurrency(group.vat, watchCurrency)}</span>
                      </div>
                    )}
                  </div>
                ))}
              {vatByRate.size === 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Moms</span>
                  <span>{formatCurrency(0, watchCurrency)}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between font-bold text-lg">
                <span>Totalt</span>
                <span>{formatCurrency(total, watchCurrency)}</span>
              </div>
            </CardContent>
          </Card>

            {/* Actions — desktop/tablet only */}
            <Button
              type="submit"
              className="w-full hidden md:block"
              size="lg"
              disabled={isSubmitting || !canWrite}
              title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
            >
              {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
              Granska & skapa
            </Button>
          </div>
        </div>

        {/* Mobile sticky total bar */}
        <div className="md:hidden fixed left-0 right-0 z-40 bg-card/98 backdrop-blur-sm border-t border-border/40 px-5 py-3" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}>
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Totalt</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(total, watchCurrency)}</p>
            </div>
            <Button
              type="submit"
              disabled={isSubmitting || !canWrite}
              title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
            >
              {!canWrite && <Lock className="mr-2 h-4 w-4 inline" />}
              Granska & skapa
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
          title={watchDocumentType === 'proforma' ? 'Granska proformafaktura' : watchDocumentType === 'delivery_note' ? 'Granska följesedel' : 'Granska faktura'}
          warningText={watchDocumentType === 'invoice'
            ? accountingMethod === 'cash'
              ? 'En faktura skapas och tilldelas ett fakturanummer. Verifikationen bokförs först när fakturan markeras som betald (kontantmetoden).'
              : 'En faktura skapas och tilldelas ett fakturanummer. När den skickas eller markeras som skickad bokförs en verifikation, som inte kan redigeras direkt men kan korrigeras via en kreditnota.'
            : watchDocumentType === 'proforma'
              ? 'En proformafaktura skapas. Ingen verifikation bokförs. Proforman kan senare konverteras till en riktig faktura.'
              : 'En följesedel skapas utan priser. Ingen verifikation bokförs.'}
          confirmLabel={watchDocumentType === 'proforma' ? 'Skapa proformafaktura' : watchDocumentType === 'delivery_note' ? 'Skapa följesedel' : 'Bekräfta & skapa'}
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
              {isPreviewing ? 'Genererar...' : 'Förhandsgranska PDF'}
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
            <DialogTitle>Lägg till kund</DialogTitle>
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

      {/* Send now prompt dialog */}
      <Dialog open={showSendPrompt} onOpenChange={(open) => {
        if (!open && createdInvoiceId) {
          setShowSendPrompt(false)
          router.push(`/invoices/${createdInvoiceId}`)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skicka fakturan nu?</DialogTitle>
            <DialogDescription>
              Fakturan skapades. Vill du skicka den till {selectedCustomer?.email} direkt?
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
              Skicka senare
            </Button>
            <Button onClick={handleSendNow} disabled={isSending}>
              {isSending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {isSending ? 'Skickar...' : 'Skicka nu'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
