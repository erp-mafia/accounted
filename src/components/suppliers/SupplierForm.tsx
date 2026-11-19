'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { FormSubmitRow } from '@/components/common/FormSubmitRow'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { XMarkIcon } from '@/components/icons'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { useCompanySettings } from '@/components/settings/useSettings'
import { AttnLine } from '@/components/ui/attn-line'
import { lookupCreditorName, probeCreditorLookup, type CreditorLookupResult } from '@/components/payments/payments-client'
import { creditorNameMatches } from '@/lib/payments/creditor-name-match'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getCountryOptions, normalizeCountryCode } from '@/lib/vat/country-codes'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { registryFormFill, type RegistryFormField } from '@/lib/parties/registry-form-fill'
import { useRegistryAutofill } from '@/components/parties/use-registry-autofill'
import { RegistryAutofillNote } from '@/components/parties/RegistryAutofillNote'
import type { CreateSupplierInput } from '@/types'

interface SupplierFormProps {
  onSubmit: (data: CreateSupplierInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<CreateSupplierInput>
  /** Set by a host that owns the primary (a drawer's fixed footer): the form takes this id and renders no submit row of its own; the host's button submits it through the `form` attribute. */
  formId?: string
}

type GiroField = 'bankgiro' | 'plusgiro'

/** One check of a typed giro against Bankgirot's register: what was asked, and the answer once it came. */
type GiroCheck = { field: GiroField; giro: string; state: 'checking' } | { field: GiroField; giro: string; state: 'done'; result: CreditorLookupResult }

const CHECK_FAILED: CreditorLookupResult = { enabled: true, available: false, reason: 'provider_refused', creditor_name: null, ocr_valid: null, warnings: [] }

export default function SupplierForm({
  onSubmit,
  isLoading,
  initialData,
  formId,
}: SupplierFormProps) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('form_supplier')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const countryOptions = useMemo(() => getCountryOptions(locale), [locale])
  // Chart of accounts from the session cache (lib/reference-data): the
  // konto combobox is populated on the first paint; without the chart it
  // still accepts a typed 4-digit number.
  const { accounts } = useAccounts()
  // The default dimensions are offered where the company tags lines at all
  // (company_settings.dimensions_enabled, the voucher form's gate).
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true

  // The default account seeds expense lines on supplier invoices, so the
  // browsable list is cost classes 4-7. Any other 4-digit number can still be
  // typed in; the API only enforces the format.
  const expenseAccounts = useMemo(
    () => accounts.filter((a) => a.account_class >= 4 && a.account_class <= 7),
    [accounts]
  )
  const accountNameByNumber = useMemo(
    () => new Map(accounts.map((a) => [a.account_number, a.account_name])),
    [accounts]
  )

  const schema = useMemo(() => z.object({
    name: z.string().min(1, t('name_required')),
    supplier_type: z.enum(['swedish_business', 'eu_business', 'non_eu_business']),
    email: z.string().email(t('email_invalid')).optional().or(z.literal('')),
    phone: z.string().optional(),
    address_line1: z.string().optional(),
    address_line2: z.string().optional(),
    postal_code: z.string().optional(),
    city: z.string().optional(),
    // ISO 3166-1 alpha-2; an unmapped legacy name is shown as-is and has to
    // be replaced before the form saves.
    country: z.string().refine((v) => normalizeCountryCode(v) !== null, t('country_invalid')),
    org_number: z.string().optional(),
    vat_number: z.string().optional(),
    bankgiro: z.string().optional(),
    plusgiro: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    clearing_number: z.string().optional(),
    account_number: z.string().optional(),
    default_expense_account: z.string().optional(),
    // Whole days 0-365; 0 = betalning direkt (issue #2070, same as CustomerForm).
    default_payment_terms: z
      .number({ message: t('default_payment_terms_invalid') })
      .int(t('default_payment_terms_invalid'))
      .min(0, t('default_payment_terms_invalid'))
      .max(365, t('default_payment_terms_invalid')),
    default_currency: z.string().optional(),
    // The self-billing agreement with the supplier (crm#1367): with one, a
    // självfaktura can be issued to it from the supplier invoice form.
    self_billing_agreement_ref: z.string().max(128, t('self_billing_agreement_invalid')).optional(),
    // How the supplier is paid (crm#1463): by the company, or debited by the
    // supplier itself (autogiro, account debit).
    auto_debit: z.boolean(),
    // Tags its new supplier invoices take (accounted#144); the invoice
    // editor prefills them and they can be changed there.
    default_dimensions: z.record(z.string(), z.string()),
    notes: z.string().optional(),
  }), [t])

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    control,
    watch,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialData?.name || '',
      supplier_type: initialData?.supplier_type || 'swedish_business',
      email: initialData?.email || '',
      phone: initialData?.phone || '',
      address_line1: initialData?.address_line1 || '',
      address_line2: initialData?.address_line2 || '',
      postal_code: initialData?.postal_code || '',
      city: initialData?.city || '',
      country: normalizeCountryCode(initialData?.country) ?? initialData?.country ?? 'SE',
      // Stored as 10 digits, shown as XXXXXX-XXXX (the placeholder's shape);
      // the API canonicalises what the user submits.
      org_number: formatOrgNumberDisplay(initialData?.org_number),
      vat_number: initialData?.vat_number || '',
      bankgiro: initialData?.bankgiro || '',
      plusgiro: initialData?.plusgiro || '',
      iban: initialData?.iban || '',
      bic: initialData?.bic || '',
      clearing_number: initialData?.clearing_number || '',
      account_number: initialData?.account_number || '',
      default_expense_account: initialData?.default_expense_account || '',
      // ?? not ||: a stored 0 (betalning direkt) must not reopen as 30.
      default_payment_terms: initialData?.default_payment_terms ?? 30,
      default_currency: initialData?.default_currency || 'SEK',
      self_billing_agreement_ref: initialData?.self_billing_agreement_ref || '',
      auto_debit: initialData?.auto_debit ?? false,
      default_dimensions: initialData?.default_dimensions ?? {},
      notes: initialData?.notes || '',
    },
  })

  const supplierType = watch('supplier_type')
  const orgNumber = watch('org_number')
  // A complete org number of a Swedish company is looked up in SCB's
  // register once, and the fields it knows are filled where nothing has
  // been typed (issue #2218). Quiet when the environment has no SCB
  // credentials. The VAT number is among the fields here: the form shows it.
  const autofill = useRegistryAutofill({
    orgNumber,
    enabled: canWrite && supplierType === 'swedish_business',
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
      )
      for (const [field, value] of Object.entries(patch)) {
        setValue(field as RegistryFormField, value ?? '', { shouldDirty: true, shouldValidate: true })
      }
      return Object.keys(patch)
    },
  })

  // Bankgiro Lookup (premium, behind OPENPAYMENTS_BANKGIRO_LOOKUP on the
  // server): a "Kontrollera" beside the giro fields shows the name Bankgirot
  // has registered for the number, so a typo or a fraudulent card is caught
  // when it is saved. The probe says whether the installation offers it.
  const [giroLookupEnabled, setGiroLookupEnabled] = useState(false)
  const [giroCheck, setGiroCheck] = useState<GiroCheck | null>(null)
  useEffect(() => {
    if (!canWrite) return
    let cancelled = false
    probeCreditorLookup()
      .then((enabled) => {
        if (!cancelled) setGiroLookupEnabled(enabled)
      })
      .catch(() => {
        // Quiet: without the probe's answer the check is simply not offered.
      })
    return () => {
      cancelled = true
    }
  }, [canWrite])

  async function checkGiro(field: GiroField) {
    const giro = (getValues(field) ?? '').trim()
    if (!giro) return
    setGiroCheck({ field, giro, state: 'checking' })
    try {
      const result = await lookupCreditorName({ giro, type: field })
      setGiroCheck({ field, giro, state: 'done', result })
    } catch {
      setGiroCheck({ field, giro, state: 'done', result: CHECK_FAILED })
    }
  }

  const bankgiroValue = watch('bankgiro')
  const plusgiroValue = watch('plusgiro')
  const supplierName = watch('name')

  /** The check's answer under its field, as long as the field still holds the number that was checked. */
  function giroCheckLine(field: GiroField, current: string | undefined) {
    if (!giroCheck || giroCheck.field !== field || giroCheck.giro !== (current ?? '').trim()) return null
    if (giroCheck.state === 'checking') return <p className="text-xs text-muted-foreground">{t('check_giro_checking')}</p>
    const result = giroCheck.result
    if (!result.enabled) return null
    if (!result.available || !result.creditor_name) {
      const key = result.reason === 'not_found' ? 'giro_not_found' : result.reason === 'invalid_number' ? 'giro_invalid' : 'giro_check_unavailable'
      return <p className="text-xs text-muted-foreground">{t(key)}</p>
    }
    const name = result.creditor_name
    if (creditorNameMatches(name, supplierName ?? '')) {
      return <p className="text-xs text-muted-foreground">{t(field === 'bankgiro' ? 'giro_registered_name_bankgiro' : 'giro_registered_name_plusgiro', { name })}</p>
    }
    return <AttnLine>{t('giro_registered_name_differs', { name, supplier: supplierName?.trim() || t('giro_no_supplier_name') })}</AttnLine>
  }

  const countryValue = watch('country')
  // A stored value the picker does not list (an unmapped legacy name, or a
  // code outside the curated list) still has to be visible, or the field
  // would look empty while holding something.
  const countryValueUnlisted =
    countryValue && !countryOptions.some((option) => option.code === countryValue)

  // Empty strings go through as-is: the API schemas normalize them (dropped on
  // create, null on update so a cleared field actually clears the column).
  // The default dimensions travel only while the form shows them, so a
  // company that has dimensions off never rewrites a bag set elsewhere.
  const onFormSubmit = (data: FormData) => {
    const { default_dimensions: defaultDimensions, ...rest } = data
    onSubmit(dimensionsEnabled ? { ...rest, default_dimensions: defaultDimensions } : rest)
  }

  return (
    <form id={formId} onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
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

      {/* Identification first: on a Swedish company's org number the register fills the rest */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="org_number">{t('org_number_label')}</Label>
          <Input
            id="org_number"
            placeholder={t('org_number_placeholder')}
            {...register('org_number')}
          />
          <RegistryAutofillNote state={autofill} />
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
          <Label htmlFor="email" optional>{t('email_label')}</Label>
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
          <Label htmlFor="phone" optional>{t('phone_label')}</Label>
          <Input
            id="phone"
            placeholder="+46 8 123 45 67"
            {...register('phone')}
          />
        </div>
      </div>

      {/* Address */}
      <div className="space-y-4 pt-4 border-t">
        <h3>{t('address_section')}</h3>
        <div className="space-y-2">
          <Label htmlFor="address_line1" optional>{t('street_label')}</Label>
          <Input
            id="address_line1"
            placeholder="Storgatan 1"
            {...register('address_line1')}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="address_line2" optional>{t('address_line2_label')}</Label>
          <Input
            id="address_line2"
            placeholder={t('address_line2_placeholder')}
            {...register('address_line2')}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="postal_code" optional>{t('postal_label')}</Label>
            <Input id="postal_code" placeholder="123 45" {...register('postal_code')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city" optional>{t('city_label')}</Label>
            <Input id="city" placeholder="Stockholm" {...register('city')} />
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

      {/* Payment details */}
      <div className="space-y-4 pt-4 border-t">
        <h3>{t('payment_section')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="bankgiro">{t('bankgiro_label')}</Label>
            <div className="flex items-center gap-2">
              <Input id="bankgiro" placeholder={t('bankgiro_placeholder')} {...register('bankgiro')} />
              {giroLookupEnabled && (
                <Button type="button" variant="outline" onClick={() => checkGiro('bankgiro')} disabled={!bankgiroValue?.trim()}>
                  {t('check_giro')}
                </Button>
              )}
            </div>
            {giroCheckLine('bankgiro', bankgiroValue)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="plusgiro">{t('plusgiro_label')}</Label>
            <div className="flex items-center gap-2">
              <Input id="plusgiro" placeholder="XXXXXXX-X" {...register('plusgiro')} />
              {giroLookupEnabled && (
                <Button type="button" variant="outline" onClick={() => checkGiro('plusgiro')} disabled={!plusgiroValue?.trim()}>
                  {t('check_giro')}
                </Button>
              )}
            </div>
            {giroCheckLine('plusgiro', plusgiroValue)}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="clearing_number">{t('clearing_label')}</Label>
            <Input id="clearing_number" placeholder="XXXX" {...register('clearing_number')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account_number">{t('account_number_label')}</Label>
            <Input id="account_number" placeholder="XXXXXXXXX" {...register('account_number')} />
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
            <Label>{t('default_account_label')}</Label>
            <Controller
              name="default_expense_account"
              control={control}
              render={({ field }) => (
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <AccountCombobox
                      value={field.value || ''}
                      accounts={expenseAccounts}
                      onChange={field.onChange}
                      selectedName={accountNameByNumber.get(field.value || '')}
                    />
                  </div>
                  {field.value ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('default_account_clear')}
                      onClick={() => field.onChange('')}
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment_terms">{t('default_payment_terms_label')}</Label>
            <Input
              id="payment_terms"
              type="number"
              min={0}
              max={365}
              step={1}
              {...register('default_payment_terms', { valueAsNumber: true })}
            />
            <p className="text-xs text-muted-foreground">{t('default_payment_terms_help')}</p>
            {errors.default_payment_terms && (
              <p className="text-sm text-destructive">{errors.default_payment_terms.message}</p>
            )}
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

      {/* Förvalda dimensioner (accounted#144) */}
      {dimensionsEnabled && (
        <div className="space-y-2">
          <Label>{t('default_dimensions_label')}</Label>
          <Controller
            name="default_dimensions"
            control={control}
            render={({ field }) => (
              <LineDimensionFields
                dimensions={field.value}
                disabled={!canWrite}
                onChange={(dimNo, code) => {
                  const next = { ...field.value }
                  const trimmed = code?.trim()
                  if (trimmed) next[dimNo] = trimmed
                  else delete next[dimNo]
                  field.onChange(next)
                }}
              />
            )}
          />
          <p className="text-xs text-muted-foreground">{t('default_dimensions_help')}</p>
        </div>
      )}

      {/* Betalningssätt (crm#1463) */}
      <div className="space-y-2">
        <Label htmlFor="auto_debit">{t('payment_method_label')}</Label>
        <Controller
          name="auto_debit"
          control={control}
          render={({ field }) => (
            <Select value={field.value ? 'auto_debit' : 'pay'} onValueChange={(v) => field.onChange(v === 'auto_debit')}>
              <SelectTrigger id="auto_debit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pay">{t('payment_method_pay')}</SelectItem>
                <SelectItem value="auto_debit">{t('payment_method_auto_debit')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs text-muted-foreground">{t('payment_method_help')}</p>
      </div>

      {/* Självfaktureringsavtal (crm#1367) */}
      <div className="space-y-2">
        <Label htmlFor="self_billing_agreement_ref" optional>{t('self_billing_agreement_label')}</Label>
        <Input
          id="self_billing_agreement_ref"
          placeholder={t('self_billing_agreement_placeholder')}
          autoComplete="off"
          {...register('self_billing_agreement_ref')}
        />
        <p className="text-xs text-muted-foreground">{t('self_billing_agreement_help')}</p>
        {errors.self_billing_agreement_ref && (
          <p className="text-sm text-destructive">{errors.self_billing_agreement_ref.message}</p>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes" optional>{t('notes_label')}</Label>
        <Textarea
          id="notes"
          placeholder={t('notes_placeholder')}
          {...register('notes')}
        />
      </div>

      {/* Submit: the host's footer carries it when the form has an id. */}
      {!formId && (
        <FormSubmitRow
          canWrite={canWrite}
          isLoading={isLoading}
          label={t('submit_save')}
          savingLabel={t('submit_saving')}
          viewerTitle={t('viewer_disabled_tooltip')}
        />
      )}
    </form>
  )
}
