'use client'

import { useMemo, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, CheckCircle, XCircle, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  EMAIL_PATTERN,
  MAX_INVOICE_EMAIL_COPY_RECIPIENTS,
  parseInvoiceRecipientText,
} from '@/lib/invoices/email-recipients'
import {
  PERSONAL_NUMBER_INPUT_RE,
  UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
  isMaskedPersonalNumber,
} from '@/lib/customers/mask-personal-number'
import { looksLikeSwedishPersonalNumber } from '@/lib/customers/personal-number-shape'
import { registryFormFill, type RegistryFormField } from '@/lib/parties/registry-form-fill'
import { useRegistryAutofill } from '@/components/parties/use-registry-autofill'
import { RegistryAutofillNote } from '@/components/parties/RegistryAutofillNote'
import {
  COUNTRY_CONSISTENCY_MESSAGES,
  checkCountryConsistency,
  getCountryOptions,
  normalizeCountryCode,
} from '@/lib/vat/country-codes'
import type { CreateCustomerInput } from '@/types'

/**
 * What the register may fill on a Swedish company's org number. No VAT
 * number: the form shows no VAT field for a Swedish customer, and nothing
 * lands in a field the person cannot see (the row gets it from "Hämta
 * uppgifter" on the customer page, with provenance).
 */
const REGISTRY_FIELDS: readonly RegistryFormField[] = ['name', 'email', 'phone', 'address_line1', 'address_line2', 'postal_code', 'city']

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
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const countryOptions = useMemo(() => getCountryOptions(locale), [locale])
  const [isValidatingVat, setIsValidatingVat] = useState(false)
  const [vatValidationResult, setVatValidationResult] = useState<{
    valid: boolean
    name?: string
  } | null>(null)

  const schema = useMemo(() => z.object({
    name: z.string().min(1, t('name_required')),
    customer_type: z.enum(['individual', 'swedish_business', 'eu_business', 'non_eu_business']),
    customer_number: z.string().trim().max(32, t('customer_number_too_long')).optional(),
    contact_person: z.string().max(200, t('contact_person_too_long')).optional(),
    email: z.string().email(t('email_invalid')).optional().or(z.literal('')),
    phone: z.string().optional(),
    invoice_email_cc_addresses: z.string().optional(),
    invoice_email_bcc_addresses: z.string().optional(),
    address_line1: z.string().optional(),
    address_line2: z.string().optional(),
    postal_code: z.string().optional(),
    city: z.string().optional(),
    // ISO 3166-1 alpha-2. A row from before 2026-09 can still carry a name
    // the backfill could not map; it is shown as-is in the picker and has to
    // be replaced before the form saves.
    country: z.string().refine((v) => normalizeCountryCode(v) !== null, t('country_invalid')),
    org_number: z.string().optional(),
    vat_number: z.string().optional(),
    // Accepts a plaintext personnummer or either mask the API returns. The
    // '********-????' placeholder has to pass: it is what a row whose stored
    // value cannot be decrypted renders as, and rejecting it here blocked the
    // whole edit dialog, so the customer's name and address became unsavable
    // over a field the user could not fix.
    personal_number: z
      .string()
      .regex(PERSONAL_NUMBER_INPUT_RE, t('personal_number_invalid'))
      .optional()
      .or(z.literal('')),
    language: z.enum(['sv', 'en']).optional(),
    // 0 is a real value (betalning direkt). The old min(1) made the form
    // unsavable on "0" with no message at all (issue #2070); now the rule is
    // whole days 0-365 and the field says so when it does not hold.
    default_payment_terms: z
      .number({ message: t('payment_terms_invalid') })
      .int(t('payment_terms_invalid'))
      .min(0, t('payment_terms_invalid'))
      .max(365, t('payment_terms_invalid')),
    notes: z.string().optional(),
  }).superRefine((customer, ctx) => {
    // Country vs customer type vs VAT prefix (#2025): an EU customer with
    // land Sverige got reverse charge and nothing objected until the
    // periodisk sammanställning, after the invoice was sent. The API refuses
    // the same combinations with a 400; saying it here keeps the fix one
    // click away instead of one failed save away.
    const countryIssue = checkCountryConsistency({
      partyType: customer.customer_type,
      country: customer.country,
      vatNumber: customer.vat_number,
    })
    if (countryIssue) {
      ctx.addIssue({
        code: 'custom',
        path: ['country'],
        message: COUNTRY_CONSISTENCY_MESSAGES[countryIssue][locale],
      })
    }
    // A personnummer entered as a business org number would be shown
    // unmasked in every list (only individual customers are masked).
    if (
      customer.org_number &&
      customer.customer_type !== 'individual' &&
      looksLikeSwedishPersonalNumber(customer.org_number)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['org_number'],
        message: t('org_number_looks_personal'),
      })
    }
    const cc = parseInvoiceRecipientText(customer.invoice_email_cc_addresses ?? '')
    const bcc = parseInvoiceRecipientText(customer.invoice_email_bcc_addresses ?? '')
    for (const [field, addresses] of [
      ['invoice_email_cc_addresses', cc],
      ['invoice_email_bcc_addresses', bcc],
    ] as const) {
      const invalid = addresses.find((address) => !EMAIL_PATTERN.test(address))
      if (invalid) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: t('invoice_email_invalid', { address: invalid }),
        })
      }
    }
    if (cc.length + bcc.length > MAX_INVOICE_EMAIL_COPY_RECIPIENTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['invoice_email_cc_addresses'],
        message: t('invoice_email_too_many', { count: MAX_INVOICE_EMAIL_COPY_RECIPIENTS }),
      })
    }
  }), [t, locale])

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    watch,
    control,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialData?.name || '',
      customer_type: initialData?.customer_type || 'swedish_business',
      customer_number: initialData?.customer_number || '',
      contact_person: initialData?.contact_person ?? '',
      email: initialData?.email || '',
      phone: initialData?.phone || '',
      invoice_email_cc_addresses: initialData?.invoice_email_cc_addresses?.join('\n') ?? '',
      invoice_email_bcc_addresses: initialData?.invoice_email_bcc_addresses?.join('\n') ?? '',
      address_line1: initialData?.address_line1 || '',
      address_line2: initialData?.address_line2 || '',
      postal_code: initialData?.postal_code || '',
      city: initialData?.city || '',
      country: normalizeCountryCode(initialData?.country) ?? initialData?.country ?? 'SE',
      org_number: initialData?.org_number || '',
      vat_number: initialData?.vat_number || '',
      personal_number: initialData?.personal_number || '',
      language: initialData?.language || 'sv',
      // ?? not ||: a stored 0 (betalning direkt) must not reopen as 30.
      default_payment_terms: initialData?.default_payment_terms ?? 30,
      notes: initialData?.notes || '',
    },
  })

  const customerType = watch('customer_type')
  const vatNumber = watch('vat_number')
  const orgNumber = watch('org_number')
  // A complete org number of a Swedish company is looked up in SCB's
  // register once, and the fields it knows are filled where nothing has
  // been typed (issue #2218). Never for a privatperson's personnummer, and
  // quiet when the environment has no SCB credentials.
  const autofill = useRegistryAutofill({
    orgNumber,
    enabled: canWrite && customerType === 'swedish_business',
    initialOrgNumber: initialData?.org_number,
    apply: (now, before) => {
      const v = getValues()
      const patch = registryFormFill(
        {
          name: v.name ?? '',
          email: v.email ?? '',
          phone: v.phone ?? '',
          address_line1: v.address_line1 ?? '',
          address_line2: v.address_line2 ?? '',
          postal_code: v.postal_code ?? '',
          city: v.city ?? '',
          vat_number: v.vat_number ?? '',
        },
        now,
        before,
        REGISTRY_FIELDS,
      )
      for (const [field, value] of Object.entries(patch)) {
        setValue(field as RegistryFormField, value ?? '', { shouldDirty: true, shouldValidate: true })
      }
      return Object.keys(patch)
    },
  })
  const countryValue = watch('country')
  // A stored value the picker does not list (an unmapped legacy name, or a
  // code outside the curated list) still has to be visible, or the field
  // would look empty while holding something.
  const countryValueUnlisted =
    countryValue && !countryOptions.some((option) => option.code === countryValue)
  // The stored value could not be decrypted. The field is editable (typing a
  // fresh personnummer replaces it); say so, because the placeholder on its own
  // reads like a rendering fault.
  const personalNumberUnreadable = watch('personal_number') === UNDECRYPTABLE_PERSONAL_NUMBER_MASK

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

      if (!response.ok) {
        // Map the parsed body plus the status: on this path `result.error` is
        // the canonical envelope OBJECT (the route is withRouteContext), and
        // rendering it as a toast description would crash the React render.
        toast({
          title: t('vat_failed_title'),
          description: getErrorMessage(result, { statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }

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
    const {
      invoice_email_cc_addresses: ccText,
      invoice_email_bcc_addresses: bccText,
      ...customerData
    } = data
    const isEditing = initialData !== undefined
    const payload: CreateCustomerInput = {
      ...customerData,
      // NULL means never configured and lets a migration enrich the row.
      // Empty values on an existing row are explicit clears and survive sync.
      contact_person: data.contact_person?.trim() || (isEditing ? '' : null),
      email: data.email || undefined,
      personal_number: data.personal_number || null,
      invoice_email_cc_addresses: ccText
        ? parseInvoiceRecipientText(ccText)
        : isEditing ? [] : null,
      invoice_email_bcc_addresses: bccText
        ? parseInvoiceRecipientText(bccText)
        : isEditing ? [] : null,
    }
    // A mask means "unchanged", whichever form it is. Sending it would be
    // harmless (the route ignores masks too) but omitting it keeps the intent
    // legible in the request body.
    if (isMaskedPersonalNumber(data.personal_number)) {
      delete payload.personal_number
    }
    onSubmit(payload)
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

      {/* Identification first: on a Swedish company's org number the register fills the rest */}
      {customerType === 'individual' ? (
        <div className="space-y-2">
          <Label htmlFor="personal_number">{t('personal_number_label')}</Label>
          <Input
            id="personal_number"
            placeholder={t('personal_number_placeholder')}
            {...register('personal_number')}
          />
          {errors.personal_number ? (
            <p className="text-sm text-destructive">{errors.personal_number.message}</p>
          ) : personalNumberUnreadable ? (
            <AttnLine>{t('personal_number_unreadable')}</AttnLine>
          ) : null}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="org_number">{t('org_number_label')}</Label>
            <Input
              id="org_number"
              placeholder={t('org_number_placeholder')}
              {...register('org_number')}
            />
            {errors.org_number ? (
              <p className="text-sm text-destructive">{errors.org_number.message}</p>
            ) : (
              <RegistryAutofillNote state={autofill} />
            )}
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
        </>
      )}

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

      {/* Customer number */}
      <div className="space-y-2">
        <Label htmlFor="customer_number">{t('customer_number_label')}</Label>
        <Input
          id="customer_number"
          placeholder={t('customer_number_placeholder')}
          {...register('customer_number')}
        />
        {errors.customer_number ? (
          <p className="text-sm text-destructive">{errors.customer_number.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('customer_number_hint')}</p>
        )}
      </div>

      {/* Contact */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="contact_person">{t('contact_person_label')}</Label>
          <Input
            id="contact_person"
            placeholder={t('contact_person_placeholder')}
            {...register('contact_person')}
          />
          {errors.contact_person && (
            <p className="text-sm text-destructive">{errors.contact_person.message}</p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
      </div>

      {/* Customer-specific invoice recipients */}
      <div className="space-y-4">
        <h3 className="text-sm">{t('invoice_email_section')}</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="invoice_email_cc_addresses">{t('invoice_email_cc_label')}</Label>
            <Textarea
              id="invoice_email_cc_addresses"
              rows={3}
              placeholder={t('invoice_email_placeholder')}
              {...register('invoice_email_cc_addresses')}
            />
            {errors.invoice_email_cc_addresses && (
              <p className="text-sm text-destructive">{errors.invoice_email_cc_addresses.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoice_email_bcc_addresses">{t('invoice_email_bcc_label')}</Label>
            <Textarea
              id="invoice_email_bcc_addresses"
              rows={3}
              placeholder={t('invoice_email_placeholder')}
              {...register('invoice_email_bcc_addresses')}
            />
            {errors.invoice_email_bcc_addresses && (
              <p className="text-sm text-destructive">{errors.invoice_email_bcc_addresses.message}</p>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('invoice_email_hint')}</p>
      </div>

      {/* Address */}
      <div className="space-y-4">
        <h3>{t('address_section')}</h3>
        <div className="space-y-2">
          <Label htmlFor="address_line1">{t('street_label')}</Label>
          <Input
            id="address_line1"
            placeholder={t('street_placeholder')}
            {...register('address_line1')}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="address_line2">{t('address_line2_label')}</Label>
          <Input
            id="address_line2"
            placeholder={t('address_line2_placeholder')}
            {...register('address_line2')}
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
            <Controller
              name="country"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                  <SelectTrigger id="country">
                    <SelectValue placeholder={t('country_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {countryValueUnlisted && (
                      <SelectItem value={countryValue}>
                        {normalizeCountryCode(countryValue)
                          ? countryValue
                          : t('country_unknown_option', { value: countryValue })}
                      </SelectItem>
                    )}
                    {countryOptions.map((option) => (
                      <SelectItem key={option.code} value={option.code}>
                        {locale === 'en' ? option.nameEn : option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.country && (
              <p className="text-sm text-destructive">{errors.country.message}</p>
            )}
          </div>
        </div>
      </div>

      {/* Payment terms */}
      <div className="space-y-2">
        <Label htmlFor="payment_terms">{t('payment_terms_label')}</Label>
        <Input
          id="payment_terms"
          type="number"
          min={0}
          max={365}
          step={1}
          {...register('default_payment_terms', { valueAsNumber: true })}
        />
        <p className="text-xs text-muted-foreground">{t('payment_terms_help')}</p>
        {errors.default_payment_terms && (
          <p className="text-sm text-destructive">{errors.default_payment_terms.message}</p>
        )}
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
