'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { Plus, Trash2 } from 'lucide-react'
import type { Customer, Currency } from '@/types'
import { formatCurrency } from '@/lib/utils'

const currencies: Currency[] = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']
const units = ['st', 'tim', 'dag', 'månad', 'km', 'kg']

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful create. Hosts close the dialog and refresh their list. */
  onCreated: () => void
}

/**
 * "Nytt schema" as a modal: mirrors NewInvoiceDialog now that regular
 * invoice creation opens in one. Card sections carry over from the old
 * /invoices/recurring/new page.
 */
export default function NewRecurringScheduleDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useTranslations('invoice_recurring_new')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // A half-typed schedule must survive an accidental backdrop click or
        // a stray Escape (the customer/currency selects portal outside the
        // dialog). Closing is explicit: the header X or Avbryt. Same
        // convention as NewInvoiceDialog.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <NewRecurringScheduleForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// Inner component so form state resets whenever the dialog reopens (Radix
// unmounts DialogContent children on close).
function NewRecurringScheduleForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { toast } = useToast()
  const { company } = useCompany()
  const supabase = createClient()
  const t = useTranslations('invoice_recurring_new')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const schema = useMemo(() => {
    const itemSchema = z.object({
      description: z.string().min(1, t('validation_description_required')),
      quantity: z.number().min(0.01, t('validation_quantity_min')),
      unit: z.string().min(1, t('validation_unit_required')),
      unit_price: z.number(),
      vat_rate: z
        .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
        .nullable()
        .optional(),
    })
    return z.object({
      customer_id: z.string().uuid(t('validation_customer_required')),
      name: z.string().min(1, t('validation_name_required')),
      day_of_month: z.number().int().min(1).max(31),
      payment_terms_days: z.number().int().min(0).max(90),
      currency: z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']),
      auto_send: z.boolean(),
      your_reference: z.string().optional(),
      our_reference: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(itemSchema).min(1, t('validation_min_one_row')),
    })
  }, [t])

  type FormData = z.infer<typeof schema>

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      customer_id: '',
      name: '',
      day_of_month: 15,
      payment_terms_days: 30,
      currency: 'SEK',
      auto_send: false,
      items: [{ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: 25 }],
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  useEffect(() => {
    if (!company) return
    supabase
      .from('customers')
      .select('*')
      .eq('company_id', company.id)
      .order('name')
      .then(({ data }) => setCustomers(data ?? []))
  }, [company])

  async function onSubmit(data: FormData) {
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/invoices/recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || t('create_failed_fallback'))
      }
      toast({ title: t('created_title') })
      onCreated()
    } catch (err) {
      toast({
        title: t('create_failed_title'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const items = watch('items')
  const watchCurrency = watch('currency')
  const subtotalRaw = items.reduce(
    (sum, it) => sum + (it.quantity || 0) * (it.unit_price || 0),
    0,
  )
  // Round to öre using the project monetary rule, then format.
  const subtotal = Math.round(subtotalRaw * 100) / 100

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('schedule_card_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="name">{t('name_label')}</Label>
            <Input
              id="name"
              placeholder={t('name_placeholder')}
              {...register('name')}
            />
            {errors.name && (
              <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="customer_id">{t('customer_label')}</Label>
            <Controller
              control={control}
              name="customer_id"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="customer_id">
                    <SelectValue placeholder={t('customer_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.customer_id && (
              <p className="text-sm text-destructive mt-1">{errors.customer_id.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="day_of_month">{t('day_label')}</Label>
              <Input
                id="day_of_month"
                type="number"
                min={1}
                max={31}
                className="tabular-nums"
                {...register('day_of_month', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t('day_hint')}
              </p>
            </div>
            <div>
              <Label htmlFor="payment_terms_days">{t('payment_terms_label')}</Label>
              <Input
                id="payment_terms_days"
                type="number"
                min={0}
                max={90}
                className="tabular-nums"
                {...register('payment_terms_days', { valueAsNumber: true })}
              />
            </div>
            <div>
              <Label htmlFor="currency">{t('currency_label')}</Label>
              <Controller
                control={control}
                name="currency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {currencies.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <div className="flex items-start gap-3">
              <Controller
                control={control}
                name="auto_send"
                render={({ field }) => (
                  <input
                    type="checkbox"
                    id="auto_send"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    className="mt-1 h-4 w-4"
                  />
                )}
              />
              <div className="flex-1">
                <Label htmlFor="auto_send" className="font-medium">
                  {t('auto_send_label')}
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('auto_send_description')}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('items_card_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {fields.map((field, index) => (
            <div
              key={field.id}
              className="grid grid-cols-12 gap-2 items-start"
            >
              <div className="col-span-12 sm:col-span-5">
                <Input
                  placeholder={t('description_placeholder')}
                  {...register(`items.${index}.description`)}
                />
              </div>
              <div className="col-span-3 sm:col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  placeholder={t('quantity_placeholder')}
                  className="tabular-nums"
                  {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                />
              </div>
              <div className="col-span-3 sm:col-span-1">
                <Controller
                  control={control}
                  name={`items.${index}.unit`}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {units.map((u) => (
                          <SelectItem key={u} value={u}>
                            {u}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="col-span-4 sm:col-span-3">
                <Input
                  type="number"
                  step="0.01"
                  placeholder={t('unit_price_placeholder')}
                  className="tabular-nums"
                  {...register(`items.${index}.unit_price`, { valueAsNumber: true })}
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => fields.length > 1 && remove(index)}
                  aria-label={t('remove_row')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              append({ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: 25 })
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('add_row')}
          </Button>
          <div className="pt-2 text-sm text-muted-foreground tabular-nums">
            {t('subtotal_ex_vat', { amount: formatCurrency(subtotal, watchCurrency) })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('other_card_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="your_reference">{t('your_reference_label')}</Label>
              <Input id="your_reference" {...register('your_reference')} />
            </div>
            <div>
              <Label htmlFor="our_reference">{t('our_reference_label')}</Label>
              <Input id="our_reference" {...register('our_reference')} />
            </div>
          </div>
          <div>
            <Label htmlFor="notes">{t('notes_label')}</Label>
            <Textarea id="notes" rows={3} {...register('notes')} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('creating') : t('create_schedule')}
        </Button>
      </div>
    </form>
  )
}
