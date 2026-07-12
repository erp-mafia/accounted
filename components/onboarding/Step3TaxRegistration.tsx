'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Loader2, ArrowRight, ArrowLeft, Check, CalendarDays } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { parseDateParts } from '@/lib/bookkeeping/validate-period-duration'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import {
  FiscalPeriodDateFields,
  validateFirstPeriod,
} from '@/components/bookkeeping/FiscalPeriodDateFields'
import type { EntityType } from '@/types'

const schema = z.object({
  f_skatt: z.boolean(),
  is_first_fiscal_year: z.boolean(),
  // First year fields (conditional, validated via superRefine below)
  first_year_start: z.string().optional(),
  first_year_end: z.string().optional(),
  // Ongoing year field (conditional)
  fiscal_year_end_month: z.number().min(1).max(12).optional(),
}).superRefine((data, ctx) => {
  if (data.is_first_fiscal_year) {
    if (!data.first_year_start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Välj startdatum för första räkenskapsåret.',
        path: ['first_year_start'],
      })
    }
    if (!data.first_year_end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Välj slutdatum för första räkenskapsåret.',
        path: ['first_year_end'],
      })
    }
  }
})

type FormData = z.infer<typeof schema>

// Output type passed to onNext: includes computed fiscal_year_start_month
interface Step3Output {
  f_skatt: boolean
  fiscal_year_start_month: number
  is_first_fiscal_year: boolean
  first_year_start?: string
  first_year_end?: string
}

interface Step3Props {
  initialData: Partial<Step3Output>
  entityType?: EntityType
  onNext: (data: Step3Output) => void
  onBack: () => void
  isSaving: boolean
}

const monthNames = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
]

/**
 * Get the last day of a given month (1-indexed).
 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * Compute valid first-year end dates for enskild firma.
 * EF must use calendar year, so end is always Dec 31.
 */
function getEFFirstYearEndDates(startYear: number, startMonth: number): { label: string; value: string }[] {
  // EF always ends Dec 31 of either same year or (if start is Jan) same year
  // If start is late in the year, only option is Dec 31 same year
  // Periods cannot exceed 18 months
  const options: { label: string; value: string }[] = []

  // Option 1: Dec 31 of same year (if startMonth <= 12)
  const months1 = 12 - startMonth + 1
  if (months1 >= 1 && months1 <= 18) {
    const endDate = `${startYear}-12-31`
    options.push({
      label: `31 december ${startYear} (${months1} mån)`,
      value: endDate,
    })
  }

  // Option 2: Dec 31 of next year (if that gives <= 18 months)
  const months2 = months1 + 12
  if (months2 >= 1 && months2 <= 18 && startMonth > 6) {
    // Only makes sense if start month > June (otherwise > 18 months)
    const endDate = `${startYear + 1}-12-31`
    options.push({
      label: `31 december ${startYear + 1} (${months2} mån)`,
      value: endDate,
    })
  }

  return options
}

/**
 * Compute valid first-year end dates for aktiebolag given a chosen end month.
 * Returns one or two options (ending in the nearest years that give 1-18 months).
 */
function getABFirstYearEndDates(
  startYear: number,
  startMonth: number,
  endMonth: number
): { label: string; value: string }[] {
  const options: { label: string; value: string }[] = []

  // Try ending in the same year or next year
  for (const endYear of [startYear, startYear + 1, startYear + 2]) {
    const months = (endYear - startYear) * 12 + (endMonth - startMonth) + 1
    if (months >= 6 && months <= 18) {
      const day = lastDayOfMonth(endYear, endMonth)
      const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      options.push({
        label: `${day} ${monthNames[endMonth - 1].toLowerCase()} ${endYear} (${months} mån)`,
        value: endDate,
      })
    }
  }

  return options
}

export default function Step3TaxRegistration({
  initialData,
  entityType,
  onNext,
  onBack,
  isSaving,
}: Step3Props) {
  const t = useTranslations('onboarding')
  const isEF = entityType === 'enskild_firma'
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const {
    handleSubmit,
    watch,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      f_skatt: initialData.f_skatt ?? true,
      is_first_fiscal_year: initialData.is_first_fiscal_year ?? false,
      first_year_start: initialData.first_year_start || '',
      first_year_end: initialData.first_year_end || '',
      fiscal_year_end_month: initialData.fiscal_year_start_month
        ? (initialData.fiscal_year_start_month === 1 ? 12 : initialData.fiscal_year_start_month - 1)
        : 12,
    },
  })

  const isFirstYear = watch('is_first_fiscal_year')
  const firstYearStart = watch('first_year_start')
  const fiscalYearEndMonth = watch('fiscal_year_end_month')

  // State for AB first-year end month selector
  const [abEndMonth, setAbEndMonth] = useState<number>(
    initialData.first_year_end
      ? parseDateParts(initialData.first_year_end).month
      : 12
  )

  // Parse first year start for date computations
  const parsedStart = useMemo(() => {
    if (!firstYearStart) return null
    const parts = parseDateParts(firstYearStart)
    if (isNaN(parts.year) || isNaN(parts.month)) return null
    return { year: parts.year, month: parts.month }
  }, [firstYearStart])

  // Compute end date options for first year
  const firstYearEndOptions = useMemo(() => {
    if (!parsedStart) return []
    if (isEF) {
      return getEFFirstYearEndDates(parsedStart.year, parsedStart.month)
    }
    return getABFirstYearEndDates(parsedStart.year, parsedStart.month, abEndMonth)
  }, [parsedStart, isEF, abEndMonth])

  const onSubmit = async (data: FormData) => {
    let fiscalYearStartMonth: number
    let firstStart: string | undefined
    let firstEnd: string | undefined

    if (data.is_first_fiscal_year && data.first_year_start && data.first_year_end) {
      // Validate the 6-18 month BFL 3 kap. window + EF calendar-year rule
      const validation = validateFirstPeriod(
        data.first_year_start,
        data.first_year_end,
        entityType,
      )
      if (validation.error) {
        toast({
          title: t('step3_invalid_period'),
          description: validation.error,
          variant: 'destructive',
        })
        return
      }
      // Derive start month from end date
      const endMonth = parseDateParts(data.first_year_end).month
      fiscalYearStartMonth = endMonth === 12 ? 1 : endMonth + 1
      firstStart = data.first_year_start
      firstEnd = data.first_year_end
    } else if (isEF) {
      // EF must always be calendar year
      fiscalYearStartMonth = 1
    } else {
      // AB ongoing: derive from end month
      const endMonth = data.fiscal_year_end_month || 12
      fiscalYearStartMonth = endMonth === 12 ? 1 : endMonth + 1
    }

    // Warn on non-calendar fiscal year for AB (EF is always calendar year)
    if (!isEF && fiscalYearStartMonth !== 1) {
      const endMonth = fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1
      const endLabel = firstEnd
        ? `${parseDateParts(firstEnd).day} ${monthNames[parseDateParts(firstEnd).month - 1].toLowerCase()} ${parseDateParts(firstEnd).year}`
        : monthNames[endMonth - 1].toLowerCase()
      const ok = await confirm({
        title: t('step3_broken_year_title'),
        description: t('step3_broken_year_description', { endLabel }),
        confirmLabel: t('step3_broken_year_confirm'),
        cancelLabel: t('step3_broken_year_cancel'),
        variant: 'warning',
      })
      if (!ok) return
    }

    const output: Step3Output = {
      f_skatt: data.f_skatt,
      fiscal_year_start_month: fiscalYearStartMonth,
      is_first_fiscal_year: data.is_first_fiscal_year,
      ...(firstStart && { first_year_start: firstStart }),
      ...(firstEnd && { first_year_end: firstEnd }),
    }

    onNext(output)
  }

  return (
    <div className="space-y-6">
      <DestructiveConfirmDialog {...dialogProps} />
      <Card>
        <CardHeader>
          <CardTitle>{t('step3_card_title')}</CardTitle>
          <CardDescription>
            {t('step3_card_description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit, (errs) => {
            const fields = Object.keys(errs).join(', ')
            console.error('[onboarding] step 3 validation failed:', fields, errs)
            fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'step 3 validation failed', extra: { fields } }) }).catch(() => {})
            // Show first validation error to user
            const firstError = Object.values(errs)[0]
            const message = firstError?.message || t('check_all_fields')
            toast({ title: t('missing_fields'), description: String(message), variant: 'destructive' })
          })} className="space-y-6">
            {/* F-skatt */}
            <div className="flex items-start space-x-3">
              <Controller
                name="f_skatt"
                control={control}
                render={({ field }) => (
                  <Checkbox
                    id="f_skatt"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <div className="space-y-1">
                <InfoTooltip
                  content={
                    <div className="space-y-2">
                      <p className="font-medium">{t('step3_fskatt_tip_title')}</p>
                      <p>{t('step3_fskatt_tip_body')}</p>
                      <p className="text-xs text-muted-foreground">{t('step3_fskatt_tip_note')}</p>
                    </div>
                  }
                  side="right"
                >
                  <Label htmlFor="f_skatt" className="cursor-pointer">
                    {t('step3_fskatt_label')}
                  </Label>
                </InfoTooltip>
                <p className="text-sm text-muted-foreground">
                  {t('step3_fskatt_help')}
                </p>
              </div>
            </div>

            {/* Fiscal year section */}
            <div className="pt-4 border-t space-y-4">
              <InfoTooltip
                content={
                  <div className="space-y-2">
                    <p className="font-medium">{t('step3_fy_tip_title')}</p>
                    <p>{t('step3_fy_tip_body')}</p>
                    {isEF && (
                      <p className="text-xs text-muted-foreground">{t('step3_fy_tip_ef_note')}</p>
                    )}
                  </div>
                }
                side="right"
              >
                <Label className="text-base font-medium">{t('step3_fy_question')}</Label>
              </InfoTooltip>

              {/* Toggle: First year vs Ongoing */}
              <Controller
                name="is_first_fiscal_year"
                control={control}
                render={({ field }) => (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => field.onChange(true)}
                      className="text-left"
                    >
                      <Card className={cn(
                        'p-3 transition-colors cursor-pointer hover:border-primary/50',
                        field.value && 'border-primary ring-2 ring-primary/20'
                      )}>
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-sm">{t('step3_first_fy_title')}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{t('step3_first_fy_subtitle')}</p>
                          </div>
                          {field.value && (
                            <div className="flex-shrink-0 p-1 rounded-full bg-primary text-primary-foreground">
                              <Check className="h-3 w-3" />
                            </div>
                          )}
                        </div>
                      </Card>
                    </button>
                    <button
                      type="button"
                      onClick={() => field.onChange(false)}
                      className="text-left"
                    >
                      <Card className={cn(
                        'p-3 transition-colors cursor-pointer hover:border-primary/50',
                        !field.value && 'border-primary ring-2 ring-primary/20'
                      )}>
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-sm">{t('step3_other_fy_title')}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{t('step3_other_fy_subtitle')}</p>
                          </div>
                          {!field.value && (
                            <div className="flex-shrink-0 p-1 rounded-full bg-primary text-primary-foreground">
                              <Check className="h-3 w-3" />
                            </div>
                          )}
                        </div>
                      </Card>
                    </button>
                  </div>
                )}
              />

              {/* First fiscal year options */}
              {isFirstYear && (
                <div className="space-y-4 rounded-lg bg-muted/50 p-4">
                  <Controller
                    name="first_year_start"
                    control={control}
                    render={({ field: startField }) => (
                      <Controller
                        name="first_year_end"
                        control={control}
                        render={({ field: endField }) => (
                          <FiscalPeriodDateFields
                            startDate={startField.value || ''}
                            onStartDateChange={(v) => {
                              startField.onChange(v)
                              // Reset end when start changes: its valid options depend on start
                              if (endField.value) endField.onChange('')
                            }}
                            startHelpText={t('step3_start_help')}
                            endDate={endField.value || ''}
                            entityType={entityType}
                            endDateSlot={
                              <>
                                {/* AB: end month selector */}
                                {!isEF && parsedStart && (
                                  <div className="space-y-2">
                                    <Label>{t('step3_fy_end_month_label')}</Label>
                                    <Select
                                      value={abEndMonth.toString()}
                                      onValueChange={(v) => {
                                        if (v) {
                                          setAbEndMonth(parseInt(v))
                                          if (endField.value) endField.onChange('')
                                        }
                                      }}
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder={t('step3_select_month')} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {monthNames.map((name, i) => (
                                          <SelectItem key={i + 1} value={(i + 1).toString()}>
                                            {name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                )}

                                {/* End date selector (options depend on entity type + start) */}
                                {parsedStart && firstYearEndOptions.length > 0 && (
                                  <div className="space-y-2">
                                    <Label>{t('step3_end_date_label')}</Label>
                                    <Select
                                      value={endField.value || ''}
                                      onValueChange={(v) => { if (v) endField.onChange(v) }}
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder={t('step3_select_end_date')} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {firstYearEndOptions.map((opt) => (
                                          <SelectItem key={opt.value} value={opt.value}>
                                            {opt.label}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {errors.first_year_end && (
                                      <p className="text-xs text-destructive">{errors.first_year_end.message}</p>
                                    )}
                                  </div>
                                )}

                                {parsedStart && firstYearEndOptions.length === 0 && (
                                  <p className="text-sm text-destructive">
                                    {t('step3_no_valid_end')}
                                  </p>
                                )}

                                {errors.first_year_start && (
                                  <p className="text-xs text-destructive">{errors.first_year_start.message}</p>
                                )}
                              </>
                            }
                          />
                        )}
                      />
                    )}
                  />
                </div>
              )}

              {/* Ongoing fiscal year options */}
              {!isFirstYear && (
                <div className="space-y-2">
                  {isEF ? (
                    <div className="rounded-lg bg-muted/50 p-4">
                      <p className="text-sm font-medium">{t('step3_calendar_year')}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('step3_ef_calendar_required')}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>{t('step3_when_fy_ends')}</Label>
                      <Controller
                        name="fiscal_year_end_month"
                        control={control}
                        render={({ field }) => (
                          <Select
                            value={field.value?.toString() || '12'}
                            onValueChange={(v) => { if (v) field.onChange(parseInt(v)) }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('step3_select_month')} />
                            </SelectTrigger>
                            <SelectContent>
                              {monthNames.map((name, i) => (
                                <SelectItem key={i + 1} value={(i + 1).toString()}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <p className="text-sm text-muted-foreground">
                        {t('step3_calendar_or_broken')}
                      </p>

                      {fiscalYearEndMonth && (
                        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <CalendarDays className="h-4 w-4 text-primary" />
                            {t('step3_your_fy')}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {fiscalYearEndMonth === 12
                              ? `1 januari \u2013 31 december (kalenderår)`
                              : `1 ${monthNames[fiscalYearEndMonth].toLowerCase()} \u2013 ${lastDayOfMonth(new Date().getFullYear(), fiscalYearEndMonth)} ${monthNames[fiscalYearEndMonth - 1].toLowerCase()}`}
                          </p>
                          <p className="text-xs text-muted-foreground">{t('step3_twelve_months')}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-between pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={onBack}
                disabled={isSaving}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('back')}
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  <>
                    {t('continue')}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
