'use client'

import { useMemo } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { CreateSupplierInput } from '@/types'

interface SupplierFormProps {
  onSubmit: (data: CreateSupplierInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<CreateSupplierInput>
}

export default function SupplierForm({
  onSubmit,
  isLoading,
  initialData,
}: SupplierFormProps) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('form_supplier')

  const schema = useMemo(() => z.object({
    name: z.string().min(1, t('name_required')),
    supplier_type: z.enum(['swedish_business', 'eu_business', 'non_eu_business']),
    email: z.string().email(t('email_invalid')).optional().or(z.literal('')),
    phone: z.string().optional(),
    address_line1: z.string().optional(),
    address_line2: z.string().optional(),
    postal_code: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    org_number: z.string().optional(),
    vat_number: z.string().optional(),
    bankgiro: z.string().optional(),
    plusgiro: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    default_expense_account: z.string().optional(),
    default_payment_terms: z.number().min(1).optional(),
    default_currency: z.string().optional(),
    notes: z.string().optional(),
  }), [t])

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialData?.name || '',
      supplier_type: initialData?.supplier_type || 'swedish_business',
      email: initialData?.email || '',
      phone: initialData?.phone || '',
      address_line1: initialData?.address_line1 || '',
      postal_code: initialData?.postal_code || '',
      city: initialData?.city || '',
      country: initialData?.country || 'SE',
      org_number: initialData?.org_number || '',
      vat_number: initialData?.vat_number || '',
      bankgiro: initialData?.bankgiro || '',
      plusgiro: initialData?.plusgiro || '',
      iban: initialData?.iban || '',
      bic: initialData?.bic || '',
      default_expense_account: initialData?.default_expense_account || '',
      default_payment_terms: initialData?.default_payment_terms || 30,
      default_currency: initialData?.default_currency || 'SEK',
      notes: initialData?.notes || '',
    },
  })

  const onFormSubmit = (data: FormData) => {
    onSubmit({
      ...data,
      email: data.email || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* Supplier Type */}
      <div className="space-y-2">
        <Label>{t('type_label')}</Label>
        <Controller
          name="supplier_type"
          control={control}
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
              <SelectTrigger>
                <SelectValue placeholder={t('type_label')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="swedish_business">{t('type_swedish_business')}</SelectItem>
                <SelectItem value="eu_business">{t('type_eu_business')}</SelectItem>
                <SelectItem value="non_eu_business">{t('type_non_eu_business')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
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
            placeholder="+46 8 123 45 67"
            {...register('phone')}
          />
        </div>
      </div>

      {/* Business info */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">{t('business_section')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="org_number">{t('org_number_label')}</Label>
            <Input
              id="org_number"
              placeholder={t('org_number_placeholder')}
              {...register('org_number')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vat_number">{t('vat_label')}</Label>
            <Input
              id="vat_number"
              placeholder={t('vat_placeholder_se')}
              {...register('vat_number')}
            />
          </div>
        </div>
      </div>

      {/* Address */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">{t('address_section')}</h3>
        <div className="space-y-2">
          <Label htmlFor="address_line1">{t('street_label')}</Label>
          <Input
            id="address_line1"
            placeholder="Storgatan 1"
            {...register('address_line1')}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="postal_code">{t('postal_label')}</Label>
            <Input id="postal_code" placeholder="123 45" {...register('postal_code')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">{t('city_label')}</Label>
            <Input id="city" placeholder="Stockholm" {...register('city')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">{t('country_label')}</Label>
            <Input id="country" placeholder="SE" {...register('country')} />
          </div>
        </div>
      </div>

      {/* Payment details */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">{t('payment_section')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="bankgiro">{t('bankgiro_label')}</Label>
            <Input id="bankgiro" placeholder={t('bankgiro_placeholder')} {...register('bankgiro')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plusgiro">{t('plusgiro_label')}</Label>
            <Input id="plusgiro" placeholder="XXXXXXX-X" {...register('plusgiro')} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="iban">{t('iban_label')}</Label>
            <Input id="iban" placeholder={t('iban_placeholder')} {...register('iban')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bic">{t('swift_label')}</Label>
            <Input id="bic" placeholder="SWEDSESS" {...register('bic')} />
          </div>
        </div>
      </div>

      {/* Defaults */}
      <div className="space-y-4 pt-4 border-t">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="default_expense_account">{t('default_account_label')}</Label>
            <Input
              id="default_expense_account"
              placeholder={t('default_account_placeholder')}
              {...register('default_expense_account')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment_terms">{t('default_payment_terms_label')}</Label>
            <Input
              id="payment_terms"
              type="number"
              {...register('default_payment_terms', { valueAsNumber: true })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="default_currency">{t('default_currency_label')}</Label>
            <Controller
              name="default_currency"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                  <SelectTrigger>
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
        </div>
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
