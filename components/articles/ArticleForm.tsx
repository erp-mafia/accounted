'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSeg,
  SettingsSelect,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { ChevronDown, Loader2, Lock } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany } from '@/contexts/CompanyContext'
import { createClient } from '@/lib/supabase/client'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { AddAccountDialog } from '@/components/bookkeeping/AddAccountDialog'
import type { CreateArticleInput } from '@/types'
import { INVOICE_POSTING_ACCOUNT_REGEX } from '@/lib/invoices/posting-account'
import {
  ROT_WORK_TYPES,
  RUT_WORK_TYPES,
  normalizeHouseworkType,
} from '@/lib/invoices/rot-rut-rules'

// A row from the currencies reference table (lib migration
// 20260630110000_currencies_reference_table.sql).
interface CurrencyOption {
  code: string
  name: string
}

// Unit list mirrors the invoice line editor (app/(dashboard)/invoices/new/page.tsx).
const UNITS = ['st', 'tim', 'dag', 'månad', 'km', 'kg'] as const

// Legal Swedish VAT rates as integer percent. Matches vatRatePercent in
// lib/api/schemas.ts (25 | 12 | 6 | 0).
const VAT_RATES = [25, 12, 6, 0] as const

/** Money is rounded to öre with arithmetic, never toFixed (CLAUDE.md rule 6). */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// SettingsInput is a bare input, so it does not carry the wheel guard that
// components/ui/input.tsx applies to type="number". Without it, scrolling the
// page with the cursor over a focused price field silently edits the amount.
function blurOnWheel(e: React.WheelEvent<HTMLInputElement>) {
  e.currentTarget.blur()
}

interface ArticleFormProps {
  onSubmit: (data: CreateArticleInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<CreateArticleInput>
  /** Closes the host dialog. When omitted the cancel button is not rendered. */
  onCancel?: () => void
}

export default function ArticleForm({
  onSubmit,
  isLoading,
  initialData,
  onCancel,
}: ArticleFormProps) {
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  const supabase = createClient()
  const t = useTranslations('form_article')
  const tCommon = useTranslations('common')
  // Active class 1-3 posting accounts for the combobox. The combobox accepts
  // unknown 4-digit numbers optimistically: the API answers with
  // ACCOUNTS_NOT_IN_CHART for activatable BAS accounts, and the host page's
  // ActivateAccountsDialog flow takes over (same UX as the journal entry form).
  // Balance-sheet and revenue accounts for the posting override, from the
  // session cache (lib/reference-data): populated on the first paint.
  const { accounts: activeAccounts } = useAccounts()
  const postingAccounts = useMemo(
    () => activeAccounts.filter((account) => account.account_class >= 1 && account.account_class <= 3),
    [activeAccounts],
  )
  // Inline account creation: what the user typed in the combobox when they hit
  // "Skapa konto": non-null opens AddAccountDialog prefilled with it.
  const [createAccountPrefill, setCreateAccountPrefill] = useState<string | null>(null)
  // Momsregistrerad? A non-VAT-registered company never charges moms, so the
  // VAT field is hidden and the rate forced to 0: mirrors the invoice editor.
  const [vatRegistered, setVatRegistered] = useState(true)
  // Supported currencies, fetched from the currencies reference table rather
  // than hard-coded. Falls back to the article's own currency (or SEK) if the
  // fetch fails so the Select is never empty.
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([])

  // Currency options come from the currencies reference table: one source of
  // truth, no hard-coded list.
  useEffect(() => {
    let cancelled = false
    supabase
      .from('currencies')
      .select('code, name')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .then(({ data }) => {
        if (!cancelled && data) setCurrencies(data as CurrencyOption[])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    supabase
      .from('company_settings')
      .select('vat_registered')
      .eq('company_id', company.id)
      .single()
      .then(({ data }) => {
        if (!cancelled && typeof data?.vat_registered === 'boolean') {
          setVatRegistered(data.vat_registered)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  // Open "Fler fält" by default when it already holds data, so an edit never
  // hides a value the user previously set. Currency and posting account are no
  // longer in here: both are permanent rows.
  const [moreOpen, setMoreOpen] = useState(
    Boolean(
      initialData?.article_number ||
        initialData?.name_en ||
        initialData?.cost_price != null ||
        initialData?.ean ||
        initialData?.housework_type ||
        initialData?.notes,
    ),
  )

  // UI-local schema mirroring CreateArticleSchema (lib/api/schemas.ts).
  const schema = useMemo(
    () =>
      z.object({
        article_number: z.string().trim().max(64, t('number_too_long')).optional(),
        name: z.string().min(1, t('name_required')),
        name_en: z.string().optional(),
        type: z.enum(['vara', 'tjanst']),
        unit: z.string().min(1),
        price_excl_vat: z.number({ message: t('price_required') }).nonnegative(t('price_required')),
        vat_rate: z.union([z.literal(25), z.literal(12), z.literal(6), z.literal(0)]),
        // ISO 4217 alpha-3; the authoritative allow-list is the currencies
        // table (the DB FK rejects unknown codes).
        currency: z.string().regex(/^[A-Z]{3}$/),
        revenue_account: z
          .string()
          .regex(INVOICE_POSTING_ACCOUNT_REGEX, t('posting_account_invalid'))
          .or(z.literal(''))
          .optional(),
        cost_price: z.number().nonnegative().optional(),
        ean: z.string().optional(),
        housework_type: z.string().optional(),
        notes: z.string().optional(),
      }),
    [t],
  )

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    watch,
    control,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      article_number: initialData?.article_number || '',
      name: initialData?.name || '',
      name_en: initialData?.name_en || '',
      type: initialData?.type || 'tjanst',
      unit: initialData?.unit || 'st',
      price_excl_vat: initialData?.price_excl_vat ?? 0,
      vat_rate: (initialData?.vat_rate as FormData['vat_rate']) ?? 25,
      currency: initialData?.currency ?? 'SEK',
      revenue_account: initialData?.revenue_account || '',
      cost_price: initialData?.cost_price ?? undefined,
      ean: initialData?.ean || '',
      // Canonical form (work-type code, bare ROT/RUT, or ''): a stray value
      // from an import must not sit invisibly in the select as "Ingen".
      housework_type: normalizeHouseworkType(initialData?.housework_type) ?? '',
      notes: initialData?.notes || '',
    },
  })

  // Legacy articles carry only the kind ('ROT'/'RUT'), stored before this
  // form offered Skatteverket work types. Keep that choice selectable so an
  // edit never silently drops the flag; the user upgrades it to a real
  // arbetstyp when they want the invoice row's work type pre-filled too.
  const legacyHouseworkKind = (() => {
    const v = normalizeHouseworkType(initialData?.housework_type)
    return v === 'ROT' || v === 'RUT' ? v : null
  })()

  const type = watch('type')
  const watchedName = watch('name')
  const watchedUnit = watch('unit')
  const watchedPrice = watch('price_excl_vat')
  const watchedVat = watch('vat_rate')
  const watchedCurrency = watch('currency')
  const watchedAccount = watch('revenue_account')
  const watchedNumber = watch('article_number')

  // The summary strip: what this article becomes as a line on an invoice.
  // Display only, so it never posts anything, but it is the reason currency is
  // impossible to miss here.
  const price = Number.isFinite(watchedPrice) ? Number(watchedPrice) : 0
  const effectiveVat = vatRegistered ? Number(watchedVat) || 0 : 0
  const vatAmount = round2((price * effectiveVat) / 100)
  const totalInclVat = round2(price + vatAmount)
  const currency = watchedCurrency || 'SEK'

  // Keep the article's own currency selectable even before the fetch resolves
  // or if it has since been deactivated.
  const currencyCodes = useMemo(() => {
    const codes = currencies.map((c) => c.code)
    return codes.includes(currency) ? codes : [currency, ...codes]
  }, [currencies, currency])

  const onFormSubmit = (data: FormData) => {
    onSubmit({
      article_number: data.article_number?.trim() || null,
      name: data.name,
      name_en: data.name_en || null,
      type: data.type,
      unit: data.unit,
      price_excl_vat: data.price_excl_vat,
      vat_rate: vatRegistered ? data.vat_rate : 0,
      currency: data.currency,
      revenue_account: data.revenue_account || null,
      cost_price: data.cost_price ?? null,
      ean: data.ean || null,
      housework_type: type === 'tjanst' ? data.housework_type || null : null,
      notes: data.notes || null,
    })
  }

  const fieldError = (message?: string) =>
    message ? <p className="basis-full text-xs text-destructive">{message}</p> : null

  return (
    <form onSubmit={handleSubmit(onFormSubmit)}>
      <SettingsGroup label={t('group_article')}>
        <SettingsRow label={t('type_label')}>
          <Controller
            name="type"
            control={control}
            render={({ field }) => (
              <SettingsSeg
                value={field.value}
                onChange={field.onChange}
                aria-label={t('type_label')}
                options={[
                  { value: 'tjanst', label: t('type_tjanst') },
                  { value: 'vara', label: t('type_vara') },
                ]}
              />
            )}
          />
        </SettingsRow>

        <SettingsRow label={t('name_label')} htmlFor="article-name" align="baseline">
          <SettingsInput
            id="article-name"
            placeholder={t('name_placeholder')}
            {...register('name')}
          />
          {fieldError(errors.name?.message)}
        </SettingsRow>

        <SettingsRow label={t('price_label')} htmlFor="article-price" align="baseline">
          <span className="flex items-center gap-2">
            <SettingsInput
              id="article-price"
              type="number"
              step="0.01"
              min="0"
              className="w-28 flex-none tabular-nums"
              onWheel={blurOnWheel}
              {...register('price_excl_vat', { valueAsNumber: true })}
            />
            <Controller
              name="currency"
              control={control}
              render={({ field }) => (
                <SettingsSelect
                  aria-label={t('currency_label')}
                  className="text-muted-foreground"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                >
                  {currencyCodes.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </SettingsSelect>
              )}
            />
          </span>
          {fieldError(errors.price_excl_vat?.message)}
        </SettingsRow>

        {/* Enhet closes the group when the company charges no moms, so the
            group never ends on a dangling hairline. */}
        <SettingsRow label={t('unit_label')} htmlFor="article-unit" borderless={!vatRegistered}>
          <Controller
            name="unit"
            control={control}
            render={({ field }) => (
              <SettingsSelect
                id="article-unit"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
              >
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </SettingsSelect>
            )}
          />
        </SettingsRow>

        {vatRegistered && (
          <SettingsRow label={t('vat_rate_label')} htmlFor="article-vat" borderless>
            <Controller
              name="vat_rate"
              control={control}
              render={({ field }) => (
                <SettingsSelect
                  id="article-vat"
                  value={String(field.value)}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                >
                  {VAT_RATES.map((rate) => (
                    <option key={rate} value={String(rate)}>
                      {rate} %
                    </option>
                  ))}
                </SettingsSelect>
              )}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup label={t('group_accounting')}>
        <SettingsRow
          label={t('revenue_account_label')}
          align="baseline"
          borderless
          help={t('revenue_account_hint')}
        >
          <Controller
            name="revenue_account"
            control={control}
            render={({ field }) => (
              <AccountCombobox
                flat
                value={field.value || ''}
                accounts={postingAccounts}
                onChange={field.onChange}
                onCreateAccount={(prefill) => setCreateAccountPrefill(prefill)}
              />
            )}
          />
          {fieldError(errors.revenue_account?.message)}
        </SettingsRow>
      </SettingsGroup>

      {moreOpen && (
        <SettingsGroup label={t('more_fields')}>
          <SettingsRow
            label={t('number_label')}
            htmlFor="article-number"
            align="baseline"
            help={t('number_hint')}
          >
            <SettingsInput id="article-number" className="tabular-nums" {...register('article_number')} />
            {fieldError(errors.article_number?.message)}
          </SettingsRow>

          <SettingsRow
            label={t('name_en_label')}
            htmlFor="article-name-en"
            align="baseline"
            help={t('name_en_hint')}
          >
            <SettingsInput
              id="article-name-en"
              placeholder={t('name_en_placeholder')}
              {...register('name_en')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('cost_price_label')}
            htmlFor="article-cost"
            align="baseline"
            help={t('cost_price_hint')}
          >
            <SettingsInput
              id="article-cost"
              type="number"
              step="0.01"
              min="0"
              className="w-28 flex-none tabular-nums"
              onWheel={blurOnWheel}
              {...register('cost_price', {
                setValueAs: (v) => (v === '' || v == null ? undefined : Number(v)),
              })}
            />
          </SettingsRow>

          <SettingsRow label={t('ean_label')} htmlFor="article-ean" align="baseline">
            <SettingsInput
              id="article-ean"
              placeholder={t('ean_placeholder')}
              className="tabular-nums"
              {...register('ean')}
            />
          </SettingsRow>

          {type === 'tjanst' && (
            <SettingsRow
              label={t('housework_label')}
              htmlFor="article-housework"
              help={t('housework_hint')}
            >
              <Controller
                name="housework_type"
                control={control}
                render={({ field }) => (
                  <SettingsSelect
                    id="article-housework"
                    value={field.value || ''}
                    onChange={(e) => field.onChange(e.target.value)}
                  >
                    <option value="">{t('housework_none')}</option>
                    {legacyHouseworkKind && (
                      <option value={legacyHouseworkKind}>
                        {legacyHouseworkKind === 'ROT'
                          ? t('housework_legacy_rot')
                          : t('housework_legacy_rut')}
                      </option>
                    )}
                    <optgroup label={t('housework_rot')}>
                      {ROT_WORK_TYPES.map((w) => (
                        <option key={w.code} value={w.code}>
                          {w.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={t('housework_rut')}>
                      {RUT_WORK_TYPES.map((w) => (
                        <option key={w.code} value={w.code}>
                          {w.label}
                        </option>
                      ))}
                    </optgroup>
                  </SettingsSelect>
                )}
              />
            </SettingsRow>
          )}

          <SettingsRow label={t('notes_label')} htmlFor="article-notes" align="baseline" borderless>
            <SettingsTextarea
              id="article-notes"
              rows={2}
              placeholder={t('notes_placeholder')}
              {...register('notes')}
            />
          </SettingsRow>
        </SettingsGroup>
      )}

      <div className="px-1 pt-6">
        <button
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors duration-150 hover:text-foreground"
          aria-expanded={moreOpen}
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform duration-200', moreOpen && 'rotate-180')}
            aria-hidden="true"
          />
          {t('more_fields')}
        </button>
      </div>

      {/* The line this article becomes. Full-bleed against the dialog's p-6. */}
      <div className="-mx-6 mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border bg-muted/60 px-6 py-3 text-xs text-muted-foreground">
        <span className="max-w-[46%] break-words font-display text-[15px] leading-snug text-foreground">
          {watchedName || t('summary_unnamed')}
        </span>
        <span aria-hidden="true" className="opacity-50">·</span>
        <span className="tabular-nums">1 {watchedUnit}</span>
        <span aria-hidden="true" className="opacity-50">·</span>
        <span className="tabular-nums text-foreground">{formatCurrency(price, currency)}</span>
        {effectiveVat > 0 && (
          <>
            <span>{t('summary_plus_vat')}</span>
            <span className="tabular-nums text-foreground">{formatCurrency(vatAmount, currency)}</span>
          </>
        )}
        {watchedAccount ? (
          <>
            <span aria-hidden="true" className="opacity-50">·</span>
            <span className="tabular-nums">
              {t('summary_booked_on')} {watchedAccount}
            </span>
          </>
        ) : null}
        <span className="ml-auto font-display text-[17px] tabular-nums text-foreground">
          {formatCurrency(totalInclVat, currency)}
        </span>
      </div>

      <div className="-mx-6 -mb-6 flex flex-wrap items-center gap-3 px-6 pb-6 pt-4">
        {!watchedNumber && (
          <p className="max-w-[30ch] text-xs leading-relaxed text-muted-foreground">
            {t('number_hint')}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {tCommon('cancel')}
            </Button>
          )}
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
      </div>

      {/* Inline custom-account creation (renders in a portal, outside the form).
          After create: refresh the chart and select the new number as the
          article's posting account: mirrors the journal entry form. */}
      <AddAccountDialog
        open={createAccountPrefill != null}
        onOpenChange={(next) => {
          if (!next) setCreateAccountPrefill(null)
        }}
        initialAccountNumber={
          createAccountPrefill && /^\d{1,4}$/.test(createAccountPrefill)
            ? createAccountPrefill
            : undefined
        }
        initialAccountName={
          createAccountPrefill && !/^\d{1,4}$/.test(createAccountPrefill)
            ? createAccountPrefill
            : undefined
        }
        onCreated={async (account) => {
          // The new account must be in the shared chart before the field points at it.
          await invalidateReferenceData('ref:accounts')
          setValue('revenue_account', account.account_number, { shouldDirty: true })
          setCreateAccountPrefill(null)
        }}
      />
    </form>
  )
}
