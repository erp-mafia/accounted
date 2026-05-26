'use client'

import { useMemo, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, CheckCircle, XCircle, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { CreateCustomerInput } from '@/types'

interface CustomerFormProps {
  onSubmit: (data: CreateCustomerInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<CreateCustomerInput>
}

export default function CustomerForm({
  onSubmit,
  isLoading,
  initialData,
}: CustomerFormProps) {
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const t = useTranslations('form_customer')
  const [isValidatingVat, setIsValidatingVat] = useState(false)
  const [vatValidationResult, setVatValidationResult] = useState<{
    valid: boolean
    name?: string
  } | null>(null)

  const schema = useMemo(() => z.object({
    name: z.string().min(1, t('name_required')),
    customer_type: z.enum(['individual', 'swedish_business', 'eu_business', 'non_eu_business']),
    email: z.string().email(t('email_invalid')).optional().or(z.literal('')),
    phone: z.string().optional(),
    address_line1: z.string().optional(),
    address_line2: z.string().optional(),
    postal_code: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    org_number: z.string().optional(),
    vat_number: z.string().optional(),
    personal_number: z
      .string()
      .regex(/^(\d{6}|\d{8})[-+]?\d{4}$/, t('personal_number_invalid'))
      .optional()
      .or(z.literal('')),
    language: z.enum(['sv', 'en']).optional(),
    default_payment_terms: z.number().min(1).optional(),
    notes: z.string().optional(),
  }), [t])

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    watch,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialData?.name || '',
      customer_type: initialData?.customer_type || 'swedish_business',
      email: initialData?.email || '',
      phone: initialData?.phone || '',
      address_line1: initialData?.address_line1 || '',
      postal_code: initialData?.postal_code || '',
      city: initialData?.city || '',
      country: initialData?.country || 'Sweden',
      org_number: initialData?.org_number || '',
      vat_number: initialData?.vat_number || '',
      personal_number: initialData?.personal_number || '',
      language: initialData?.language || 'sv',
      default_payment_terms: initialData?.default_payment_terms || 30,
      notes: initialData?.notes || '',
    },
  })

  const customerType = watch('customer_type')
  const vatNumber = watch('vat_number')

  const handleValidateVat = async () => {
    if (!vatNumber) return

    setIsValidatingVat(true)
    setVatValidationResult(null)

    try {
      const response = await fetch('/api/vat/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vat_number: vatNumber }),
      })

      const result = await response.json()

      setVatValidationResult({
        valid: result.valid,
        name: result.name,
      })

      if (result.valid && result.name) {
        toast({
          title: t('vat_verified_title'),
          description: t('vat_verified_description', { name: result.name }),
        })
      } else if (!result.valid) {
        toast({
          title: t('vat_failed_title'),
          description: result.error || t('vat_failed_default'),
          variant: 'destructive',
        })
      }
    } catch {
      toast({
        title: t('vat_error_title'),
        variant: 'destructive',
      })
    } finally {
      setIsValidatingVat(false)
    }
  }

  const onFormSubmit = (data: FormData) => {
    onSubmit({
      ...data,
      email: data.email || undefined,
      personal_number: data.personal_number || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* Customer Type */}
      <div className="space-y-2">
        <Label>{t('type_label')}</Label>
        <Controller
          name="customer_type"
          control={control}
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
              <SelectTrigger>
                <SelectValue placeholder={t('type_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="individual">{t('type_individual')}</SelectItem>
                <SelectItem value="swedish_business">{t('type_swedish_business')}</SelectItem>
                <SelectItem value="eu_business">{t('type_eu_business')}</SelectItem>
                <SelectItem value="non_eu_business">{t('type_non_eu_business')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs text-muted-foreground">
          {t('type_hint')}
        </p>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">{t('name_label')}</Label>
        <Input
          id="name"
          placeholder={t('name_placeholder')}
          {...register('name')}
        />
        {errors.name && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>

      {/* Contact */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="email">{t('email_label')}</Label>
          <Input
            id="email"
            type="email"
            placeholder={t('email_placeholder')}
            {...register('email')}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">{t('phone_label')}</Label>
          <Input
            id="phone"
            placeholder={t('phone_placeholder')}
            {...register('phone')}
          />
        </div>
      </div>

      {/* Address */}
      <div className="space-y-4">
        <h3 className="font-medium">{t('address_section')}</h3>
        <div className="space-y-2">
          <Label htmlFor="address_line1">{t('street_label')}</Label>
          <Input
            id="address_line1"
            placeholder={t('street_placeholder')}
            {...register('address_line1')}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="postal_code">{t('postal_label')}</Label>
            <Input
              id="postal_code"
              placeholder={t('postal_placeholder')}
              {...register('postal_code')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">{t('city_label')}</Label>
            <Input
              id="city"
              placeholder={t('city_placeholder')}
              {...register('city')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">{t('country_label')}</Label>
            <Input
              id="country"
              placeholder={t('country_placeholder')}
              {...register('country')}
            />
          </div>
        </div>
      </div>

      {/* Identification — depends on customer type */}
      {customerType === 'individual' ? (
        <div className="space-y-4 pt-4 border-t">
          <h3 className="font-medium">{t('individual_section')}</h3>

          <div className="space-y-2">
            <Label htmlFor="personal_number">{t('personal_number_label')}</Label>
            <Input
              id="personal_number"
              placeholder={t('personal_number_placeholder')}
              {...register('personal_number')}
            />
            {errors.personal_number && (
              <p className="text-sm text-destructive">{errors.personal_number.message}</p>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 pt-4 border-t">
          <h3 className="font-medium">{t('business_section')}</h3>

          <div className="space-y-2">
            <Label htmlFor="org_number">{t('org_number_label')}</Label>
            <Input
              id="org_number"
              placeholder={t('org_number_placeholder')}
              {...register('org_number')}
            />
          </div>

          {(customerType === 'eu_business' || customerType === 'non_eu_business') && (
            <div className="space-y-2">
              <Label htmlFor="vat_number">{t('vat_label')}</Label>
              <div className="flex gap-2">
                <Input
                  id="vat_number"
                  placeholder={customerType === 'eu_business' ? t('vat_placeholder_eu') : t('vat_placeholder_se')}
                  {...register('vat_number')}
                  className="flex-1"
                />
                {customerType === 'eu_business' && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleValidateVat}
                    disabled={!vatNumber || isValidatingVat}
                  >
                    {isValidatingVat ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : vatValidationResult?.valid ? (
                      <CheckCircle className="h-4 w-4 text-success" />
                    ) : vatValidationResult?.valid === false ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      t('vat_verify')
                    )}
                  </Button>
                )}
              </div>
              {customerType === 'eu_business' && (
                <p className="text-xs text-muted-foreground">
                  {t('vat_hint_eu')}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Payment terms */}
      <div className="space-y-2">
        <Label htmlFor="payment_terms">{t('payment_terms_label')}</Label>
        <Input
          id="payment_terms"
          type="number"
          {...register('default_payment_terms', { valueAsNumber: true })}
        />
      </div>

      {/* Invoice language */}
      <div className="space-y-2">
        <Label>{t('language_label')}</Label>
        <Controller
          name="language"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? 'sv'} onValueChange={(v) => { if (v) field.onChange(v) }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sv">{t('language_sv')}</SelectItem>
                <SelectItem value="en">{t('language_en')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs text-muted-foreground">{t('language_hint')}</p>
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes">{t('notes_label')}</Label>
        <Textarea
          id="notes"
          placeholder={t('notes_placeholder')}
          {...register('notes')}
        />
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          disabled={isLoading || !canWrite}
          title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('submit_saving')}
            </>
          ) : !canWrite ? (
            <>
              <Lock className="mr-2 h-4 w-4" />
              {t('submit_save')}
            </>
          ) : (
            t('submit_save')
          )}
        </Button>
      </div>
    </form>
  )
}
