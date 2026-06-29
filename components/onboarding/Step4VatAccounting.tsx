'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Loader2, ArrowRight, ArrowLeft, Info } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { deriveSwedishVatNumber } from '@/lib/vat/vat-number'
import type { MomsPeriod, EntityType } from '@/types'

const schema = z.object({
  vat_registered: z.boolean(),
  vat_number: z.string().optional(),
  moms_period: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  accounting_method: z.enum(['accrual', 'cash']),
}).superRefine((data, ctx) => {
  if (data.vat_registered && !data.moms_period) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Välj momsredovisningsperiod.',
      path: ['moms_period'],
    })
  }
})

type FormData = z.infer<typeof schema>

interface Step4Output {
  vat_registered: boolean
  vat_number?: string
  moms_period?: MomsPeriod
  accounting_method: 'accrual' | 'cash'
}

interface Step4Props {
  initialData: Partial<Step4Output>
  entityType?: EntityType
  orgNumber?: string
  onNext: (data: Step4Output) => void
  onBack: () => void
  isSaving: boolean
}

export default function Step4VatAccounting({
  initialData,
  entityType,
  orgNumber,
  onNext,
  onBack,
  isSaving,
}: Step4Props) {
  const t = useTranslations('onboarding')
  const { toast } = useToast()

  const {
    register,
    handleSubmit,
    watch,
    control,
    setValue,
    formState: {},
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      vat_registered: initialData.vat_registered ?? false,
      vat_number: initialData.vat_number || '',
      moms_period: initialData.moms_period,
      accounting_method: initialData.accounting_method ?? 'accrual',
    },
  })

  const vatRegistered = watch('vat_registered')
  const vatNumber = watch('vat_number')
  const accountingMethod = watch('accounting_method')

  // Auto-fill VAT number when vat_registered toggles on. Derive via the shared
  // helper so a 12-digit personnummer (enskild firma) gets its century dropped —
  // building SE${orgNumber}01 verbatim produced SE + 14 digits and failed
  // validation on save.
  useEffect(() => {
    if (vatRegistered && !vatNumber && orgNumber) {
      const derived = deriveSwedishVatNumber(orgNumber)
      if (derived) {
        setValue('vat_number', derived)
      }
    }
  }, [vatRegistered, vatNumber, orgNumber, setValue])

  const onSubmit = (data: FormData) => {
    const output: Step4Output = {
      vat_registered: data.vat_registered,
      vat_number: data.vat_registered ? data.vat_number : undefined,
      moms_period: data.vat_registered ? data.moms_period : undefined,
      accounting_method: data.accounting_method,
    }

    onNext(output)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('step4_card_title')}</CardTitle>
          <CardDescription>
            {t('step4_card_description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit, (errs) => {
            const fields = Object.keys(errs).join(', ')
            console.error('[onboarding] step 4 validation failed:', fields, errs)
            fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'step 4 validation failed', extra: { fields } }) }).catch(() => {})
            const firstError = Object.values(errs)[0]
            const message = firstError?.message || t('check_all_fields')
            toast({ title: t('missing_fields'), description: String(message), variant: 'destructive' })
          })} className="space-y-6">
            {/* VAT section */}
            <div className="space-y-4">
              <h3 className="flex items-center gap-2">
                <InfoTooltip
                  content={
                    <div className="space-y-2">
                      <p className="font-medium">{t('step4_vat_tip_title')}</p>
                      <p>{t('step4_vat_tip_body')}</p>
                      <p className="text-xs text-muted-foreground">{t('step4_vat_tip_note')}</p>
                    </div>
                  }
                  side="right"
                >
                  <span>{t('step4_vat_heading')}</span>
                </InfoTooltip>
              </h3>

              <div className="flex items-start space-x-3">
                <Controller
                  name="vat_registered"
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      id="vat_registered"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <div className="space-y-1">
                  <Label htmlFor="vat_registered" className="cursor-pointer">
                    {t('step4_vat_registered_label')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('step4_vat_registered_help')}
                  </p>
                </div>
              </div>

              {vatRegistered && (
                <div className="space-y-4 pl-0 sm:pl-7">
                  <div className="space-y-2">
                    <Label htmlFor="vat_number">{t('step4_vat_number_label')}</Label>
                    <Input
                      id="vat_number"
                      placeholder="SE123456789001"
                      {...register('vat_number')}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('step4_vat_number_format')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <InfoTooltip
                      content={
                        <div className="space-y-2">
                          <p className="font-medium">{t('step4_vat_period_tip_title')}</p>
                          <p>{t('step4_vat_period_tip_body')}</p>
                          <ul className="text-xs text-muted-foreground space-y-1">
                            <li>{t('step4_vat_period_bracket_low')}</li>
                            <li>{t('step4_vat_period_bracket_mid')}</li>
                            <li>{t('step4_vat_period_bracket_high')}</li>
                          </ul>
                        </div>
                      }
                      side="right"
                    >
                      <Label>{t('step4_vat_period_label')}</Label>
                    </InfoTooltip>
                    <Controller
                      name="moms_period"
                      control={control}
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(v) => { if (v) field.onChange(v) }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('step4_select_period')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="monthly">{t('step4_period_monthly')}</SelectItem>
                            <SelectItem value="quarterly">{t('step4_period_quarterly')}</SelectItem>
                            <SelectItem value="yearly">{t('step4_period_yearly')}</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('step4_period_help')}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Accounting method */}
            <div className="pt-4 border-t space-y-4">
              <div className="space-y-2">
                <InfoTooltip
                  content={t('step4_method_tip')}
                  side="right"
                >
                  <Label>{t('step4_method_label')}</Label>
                </InfoTooltip>
                <Controller
                  name="accounting_method"
                  control={control}
                  render={({ field }) => (
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <Checkbox
                          id="method_accrual"
                          checked={field.value === 'accrual'}
                          onCheckedChange={(checked) => { if (checked) field.onChange('accrual') }}
                        />
                        <Label htmlFor="method_accrual" className="cursor-pointer">
                          {t('step4_method_accrual')}
                        </Label>
                      </div>
                      <div className="flex items-start space-x-3">
                        <Checkbox
                          id="method_cash"
                          checked={field.value === 'cash'}
                          onCheckedChange={(checked) => { if (checked) field.onChange('cash') }}
                        />
                        <Label htmlFor="method_cash" className="cursor-pointer">
                          {t('step4_method_cash')}
                        </Label>
                      </div>
                    </div>
                  )}
                />
                <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Info className="h-4 w-4 text-muted-foreground" />
                    {accountingMethod === 'accrual' ? t('step4_method_accrual') : t('step4_method_cash')}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {accountingMethod === 'accrual'
                      ? t('step4_method_accrual_desc')
                      : t('step4_method_cash_desc')}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-200 bg-warning/10 rounded px-2 py-1">
                    {t('step4_cash_limit_note')}
                  </p>
                </div>
              </div>
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
