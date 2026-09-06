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
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { Plus, Trash2 } from 'lucide-react'
import type { Customer, Currency, RecurringInvoiceSchedule } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'
import {
  alignRunDateToDay,
  isoFromParts,
  lastDayOfMonth,
  parseIsoDate,
  projectRunDates,
  runDateMatchesDayOfMonth,
} from '@/lib/invoices/recurring-run-date'

const currencies: Currency[] = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']
const units = ['st', 'tim', 'dag', 'månad', 'km', 'kg']

/** Today as yyyy-mm-dd in the browser's local calendar. */
function localTodayIso(): string {
  const now = new Date()
  return isoFromParts(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * Client-side twin of computeInitialRunDate: this month's occurrence of
 * day_of_month if it has not passed, otherwise next month's. Prefills the
 * date field so the default is "no offset", exactly what the server would
 * pick when start_date is omitted.
 */
function defaultRunDate(dayOfMonth: number): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const thisMonthDay = Math.min(dayOfMonth, lastDayOfMonth(y, m))
  if (now.getDate() <= thisMonthDay) return isoFromParts(y, m, thisMonthDay)
  const ny = m === 11 ? y + 1 : y
  const nm = (m + 1) % 12
  return isoFromParts(ny, nm, Math.min(dayOfMonth, lastDayOfMonth(ny, nm)))
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful create or edit. Hosts close the dialog and refresh their list. */
  onSaved: () => void
  /** When provided, the dialog edits this schedule (PATCH) instead of creating a new one. */
  schedule?: RecurringInvoiceSchedule
}

/**
 * "Nytt schema" / "Redigera schema" as a modal: mirrors NewInvoiceDialog now
 * that regular invoice creation opens in one. Passing `schedule` switches it to
 * edit mode (prefilled form, PATCH on save).
 */
export default function NewRecurringScheduleDialog({ open, onOpenChange, onSaved, schedule }: Props) {
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
          <DialogTitle>{schedule ? t('edit_title') : t('title')}</DialogTitle>
        </DialogHeader>
        <NewRecurringScheduleForm
          schedule={schedule}
          onSaved={onSaved}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// Inner component so form state resets whenever the dialog reopens (Radix
// unmounts DialogContent children on close). This is also what makes edit mode
// work: each open re-mounts with the current schedule's values as defaults.
function NewRecurringScheduleForm({
  schedule,
  onSaved,
  onCancel,
}: {
  schedule?: RecurringInvoiceSchedule
  onSaved: () => void
  onCancel: () => void
}) {
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
    return z
      .object({
        customer_id: z.string().uuid(t('validation_customer_required')),
        name: z.string().min(1, t('validation_name_required')),
        day_of_month: z.number().int().min(1).max(31),
        interval_months: z.number().int().min(1).max(12),
        // First run (create) or next run (edit). The month is what the user
        // is really choosing: it fixes the phase of a quarterly/yearly
        // schedule ("bill in February"). Sent as start_date / next_run_date.
        run_date: z.string().regex(ISO_DATE_RE, t('validation_run_date_required')),
        send_hour: z.number().int().min(0).max(23),
        payment_terms_days: z.number().int().min(0).max(90),
        currency: z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']),
        auto_send: z.boolean(),
        your_reference: z.string().optional(),
        our_reference: z.string().optional(),
        notes: z.string().optional(),
        items: z.array(itemSchema).min(1, t('validation_min_one_row')),
      })
      .superRefine((data, ctx) => {
        if (!ISO_DATE_RE.test(data.run_date)) return
        // Mirrors the API: the date must sit on the schedule grid for the
        // chosen day (the field syncs with day_of_month, so this only fires
        // on a hand-typed mismatch), and it may not be in the past. An edit
        // that keeps the stored date is not re-validated: a paused schedule
        // with a stale date is reactivated by the server's roll-forward.
        if (!runDateMatchesDayOfMonth(data.run_date, data.day_of_month)) {
          ctx.addIssue({
            code: 'custom',
            path: ['run_date'],
            message: t('validation_run_date_grid', { day: data.day_of_month }),
          })
          return
        }
        const today = localTodayIso()
        if (schedule) {
          // The stored date, moved onto the grid for the (possibly edited)
          // day, is the "unchanged" reference: a day-only edit keeps the
          // server's own recompute and is not a re-phase.
          const unchanged = alignRunDateToDay(schedule.next_run_date, data.day_of_month)
          if (data.run_date !== unchanged && data.run_date <= today) {
            ctx.addIssue({
              code: 'custom',
              path: ['run_date'],
              message: t('validation_run_date_not_future'),
            })
          }
        } else if (data.run_date < today) {
          ctx.addIssue({
            code: 'custom',
            path: ['run_date'],
            message: t('validation_run_date_past'),
          })
        }
      })
  }, [t, schedule])

  type FormData = z.infer<typeof schema>

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: schedule
      ? {
          customer_id: schedule.customer_id,
          name: schedule.name,
          day_of_month: schedule.day_of_month,
          interval_months: schedule.interval_months ?? 1,
          run_date: schedule.next_run_date,
          send_hour: schedule.send_hour ?? 8,
          payment_terms_days: schedule.payment_terms_days,
          currency: schedule.currency,
          auto_send: schedule.auto_send,
          your_reference: schedule.your_reference ?? undefined,
          our_reference: schedule.our_reference ?? undefined,
          notes: schedule.notes ?? undefined,
          items:
            schedule.items && schedule.items.length > 0
              ? [...schedule.items]
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((it) => ({
                    description: it.description,
                    quantity: it.quantity,
                    unit: it.unit,
                    unit_price: it.unit_price,
                    vat_rate: (it.vat_rate as 0 | 6 | 12 | 25 | null) ?? null,
                  }))
              : [{ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: 25 }],
        }
      : {
          customer_id: '',
          name: '',
          day_of_month: 15,
          interval_months: 1,
          run_date: defaultRunDate(15),
          send_hour: 8,
          payment_terms_days: 30,
          currency: 'SEK',
          auto_send: false,
          items: [{ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: 25 }],
        },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  useEffect(() => {
    if (!company) return
    // Archived customers (v1 API soft-delete) are not offered in the picker,
    // but a schedule being edited keeps its current customer visible.
    const base = supabase.from('customers').select('*').eq('company_id', company.id)
    const query = schedule?.customer_id
      ? base.or(`archived_at.is.null,id.eq.${schedule.customer_id}`)
      : base.is('archived_at', null)
    query.order('name').then(({ data }) => setCustomers(data ?? []))
  }, [company, schedule?.customer_id])

  async function onSubmit(data: FormData) {
    setIsSubmitting(true)
    try {
      const { run_date, ...rest } = data
      // Create: the chosen date is the first run. Edit: only send it when the
      // user re-phased the schedule (a different month/year than the stored
      // date aligned to the chosen day), so an unrelated edit, a day-only
      // edit or a reactivation keeps the server's own recompute and never
      // re-sends a stale date.
      const rePhased =
        !!schedule && run_date !== alignRunDateToDay(schedule.next_run_date, rest.day_of_month)
      const body = schedule
        ? { ...rest, ...(rePhased ? { next_run_date: run_date } : {}) }
        : { ...rest, start_date: run_date }
      const res = await fetch(
        schedule ? `/api/invoices/recurring/${schedule.id}` : '/api/invoices/recurring',
        {
          method: schedule ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string | { message?: string }
        }
        // errorResponse() returns the nested envelope { error: { code, message } },
        // so reading body.error directly would stringify to "[object Object]".
        const message = typeof body.error === 'string' ? body.error : body.error?.message
        throw new Error(message || t('create_failed_fallback'))
      }
      toast({ title: schedule ? t('updated_title') : t('created_title') })
      onSaved()
    } catch (err) {
      toast({
        title: schedule ? t('update_failed_title') : t('create_failed_title'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Mirror InvoiceEditor: a failed validation must never look like a dead
  // button. Toast, then scroll the first inline error into view once rendered.
  function onInvalidSubmit(_errors: unknown, event?: React.BaseSyntheticEvent) {
    toast({
      title: t('validation_toast_title'),
      description: t('validation_toast_description'),
      variant: 'destructive',
    })
    const root = (event?.target as HTMLElement | null)?.closest('form')
    setTimeout(() => {
      const firstError = (root ?? document).querySelector('p.text-destructive')
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }

  const items = watch('items')
  const watchCurrency = watch('currency')
  const watchDay = watch('day_of_month')
  const watchInterval = watch('interval_months')
  const watchRunDate = watch('run_date')
  // Keep the date on the schedule grid when the day field changes: same
  // month, day moved to the new day_of_month (clamped). The reverse sync
  // (date -> day) lives in the date field's onChange.
  useEffect(() => {
    if (!Number.isInteger(watchDay) || watchDay < 1 || watchDay > 31) return
    const aligned = alignRunDateToDay(watchRunDate, watchDay)
    if (aligned !== watchRunDate) setValue('run_date', aligned, { shouldValidate: true })
    // watchRunDate is deliberately not a dependency: the effect exists to
    // react to the day, not to re-run on every date keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchDay, setValue])
  const upcomingRuns =
    Number.isInteger(watchDay) && watchInterval >= 1
      ? projectRunDates(watchRunDate, watchDay, watchInterval, 4).slice(1)
      : []
  // Automatic sending requires a customer email; without one the cron would
  // just produce a monthly draft + warning. Block it at the source.
  const watchCustomerId = watch('customer_id')
  const selectedCustomer = customers.find((c) => c.id === watchCustomerId)
  const customerMissingEmail = !!selectedCustomer && !selectedCustomer.email
  const hasEmailSend = useCapability(CAPABILITY.email_send)
  const autoSendBlocked = customerMissingEmail || !hasEmailSend

  // The onValueChange guard on the customer select only fires on a manual
  // change. In edit mode a schedule can load with auto_send=true against a
  // customer who has since lost their email (customers load async, after the
  // form's defaultValues). Force auto_send off whenever the effective customer
  // has no email (or email sending isn't entitled) so a disabled-but-checked
  // box can't PATCH auto_send=true.
  useEffect(() => {
    if (autoSendBlocked) setValue('auto_send', false)
  }, [autoSendBlocked, setValue])
  const subtotalRaw = items.reduce(
    (sum, it) => sum + (it.quantity || 0) * (it.unit_price || 0),
    0,
  )
  // Round to öre using the project monetary rule, then format.
  const subtotal = Math.round(subtotalRaw * 100) / 100

  return (
    <form onSubmit={handleSubmit(onSubmit, onInvalidSubmit)} className="space-y-6">
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
                <Select
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v)
                    // Switching to a customer without email while auto-send is
                    // checked would create an unsendable schedule.
                    const c = customers.find((x) => x.id === v)
                    if (!c?.email) setValue('auto_send', false)
                  }}
                >
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="interval_months">{t('interval_label')}</Label>
              <Controller
                control={control}
                name="interval_months"
                render={({ field }) => (
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <SelectTrigger id="interval_months">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">{t('interval_monthly')}</SelectItem>
                      <SelectItem value="3">{t('interval_quarterly')}</SelectItem>
                      <SelectItem value="6">{t('interval_semiannual')}</SelectItem>
                      <SelectItem value="12">{t('interval_yearly')}</SelectItem>
                      {/* A non-preset interval (set via API/MCP, e.g. every 2
                          months) must stay selectable so an edit doesn't
                          silently coerce it to a preset. */}
                      {![1, 3, 6, 12].includes(field.value) && (
                        <SelectItem value={String(field.value)}>
                          {t('interval_every_n', { n: field.value })}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
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
              <Label htmlFor="run_date">
                {schedule ? t('run_date_edit_label') : t('run_date_label')}
              </Label>
              <Controller
                control={control}
                name="run_date"
                render={({ field }) => (
                  <Input
                    id="run_date"
                    type="date"
                    className="tabular-nums"
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(e) => {
                      const next = e.target.value
                      field.onChange(next)
                      // Picking a day that is not where day_of_month lands in
                      // that month means the user changed the day too, so
                      // follow it. Feb 28 with day 31 stays 31 (clamped hit).
                      const parsed = parseIsoDate(next)
                      if (parsed && !runDateMatchesDayOfMonth(next, watchDay)) {
                        setValue('day_of_month', parsed.day, { shouldValidate: true })
                      }
                    }}
                  />
                )}
              />
              {errors.run_date ? (
                <p className="text-sm text-destructive mt-1">{errors.run_date.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  {upcomingRuns.length > 0
                    ? t('upcoming_runs', { dates: upcomingRuns.map((d) => formatDate(d)).join(', ') })
                    : t('run_date_hint')}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="send_hour">{t('send_hour_label')}</Label>
              <Controller
                control={control}
                name="send_hour"
                render={({ field }) => (
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <SelectTrigger id="send_hour" className="tabular-nums">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                        <SelectItem key={h} value={String(h)} className="tabular-nums">
                          {`${String(h).padStart(2, '0')}:00`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t('send_hour_hint')}
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
                    disabled={autoSendBlocked}
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
                {customerMissingEmail && (
                  <p className="text-sm text-attn mt-1">
                    {t('auto_send_missing_email')}
                  </p>
                )}
                {!hasEmailSend && (
                  <UpgradeNote className="mt-2">
                    {t('auto_send_requires_subscription')}
                  </UpgradeNote>
                )}
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
                {errors.items?.[index]?.description && (
                  <p className="text-sm text-destructive mt-1">
                    {errors.items[index].description?.message}
                  </p>
                )}
              </div>
              <div className="col-span-3 sm:col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  placeholder={t('quantity_placeholder')}
                  className="tabular-nums"
                  {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                />
                {errors.items?.[index]?.quantity && (
                  <p className="text-sm text-destructive mt-1">
                    {errors.items[index].quantity?.message}
                  </p>
                )}
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
                {errors.items?.[index]?.unit && (
                  <p className="text-sm text-destructive mt-1">
                    {errors.items[index].unit?.message}
                  </p>
                )}
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
          {schedule
            ? isSubmitting
              ? t('saving')
              : t('save_changes')
            : isSubmitting
              ? t('creating')
              : t('create_schedule')}
        </Button>
      </div>
    </form>
  )
}
