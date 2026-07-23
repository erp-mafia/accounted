'use client'

import { useEffect, useMemo, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChevronDown, Loader2, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany } from '@/contexts/CompanyContext'
import { createClient } from '@/lib/supabase/client'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { AddAccountDialog } from '@/components/bookkeeping/AddAccountDialog'
import type { BASAccount, CreateArticleInput } from '@/types'

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

interface ArticleFormProps {
  onSubmit: (data: CreateArticleInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<CreateArticleInput>
}

export default function ArticleForm({
  onSubmit,
  isLoading,
  initialData,
}: ArticleFormProps) {
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  const supabase = createClient()
  const t = useTranslations('form_article')
  // Active class 1-3 posting accounts for the combobox. The combobox accepts
  // unknown 4-digit numbers optimistically: the API answers with
  // ACCOUNTS_NOT_IN_CHART for activatable BAS accounts, and the host page's
  // ActivateAccountsDialog flow takes over (same UX as the journal entry form).
  const [postingAccounts, setPostingAccounts] = useState<BASAccount[]>([])
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

  async function fetchRevenueAccounts() {
    try {
      const res = await fetch('/api/bookkeeping/accounts')
      const body = await res.json()
      const accounts = ((body?.data as BASAccount[]) || [])
        .filter((account) => account.account_class >= 1 && account.account_class <= 3)
      setPostingAccounts(accounts)
    } catch {
      // Non-fatal: the combobox degrades to free 4-digit entry.
    }
  }

  useEffect(() => {
    fetchRevenueAccounts()
  }, [])

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
  // Open the advanced section by default when it already holds data, so an
  // edit never hides a value the user previously set.
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      (initialData?.currency && initialData.currency !== 'SEK') ||
        initialData?.revenue_account ||
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
          .regex(/^[123]\d{3}$/, t('posting_account_invalid'))
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
      housework_type: initialData?.housework_type || '',
      notes: initialData?.notes || '',
    },
  })

  const type = watch('type')

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

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* Type + article number */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t('type_label')}</Label>
          <Controller
            name="type"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                <SelectTrigger>
                  <SelectValue placeholder={t('type_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vara">{t('type_vara')}</SelectItem>
                  <SelectItem value="tjanst">{t('type_tjanst')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="article_number">{t('number_label')}</Label>
          <Input
            id="article_number"
            className="tabular-nums"
            {...register('article_number')}
          />
          {errors.article_number ? (
            <p className="text-sm text-destructive">{errors.article_number.message}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('number_hint')}</p>
          )}
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

      {/* English name */}
      <div className="space-y-2">
        <Label htmlFor="name_en">{t('name_en_label')}</Label>
        <Input
          id="name_en"
          placeholder={t('name_en_placeholder')}
          {...register('name_en')}
        />
        <p className="text-xs text-muted-foreground">{t('name_en_hint')}</p>
      </div>

      {/* Unit + price + VAT (moms hidden for non-momsregistrerade) */}
      <div className={`grid grid-cols-1 gap-4 ${vatRegistered ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <div className="space-y-2">
          <Label>{t('unit_label')}</Label>
          <Controller
            name="unit"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u} value={u}>{u}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="price_excl_vat">{t('price_label')}</Label>
          <Input
            id="price_excl_vat"
            type="number"
            step="0.01"
            min="0"
            className="tabular-nums"
            {...register('price_excl_vat', { valueAsNumber: true })}
          />
          {errors.price_excl_vat && (
            <p className="text-sm text-destructive">{errors.price_excl_vat.message}</p>
          )}
        </div>
        {vatRegistered && (
        <div className="space-y-2">
          <Label>{t('vat_rate_label')}</Label>
          <Controller
            name="vat_rate"
            control={control}
            render={({ field }) => (
              <Select
                value={String(field.value)}
                onValueChange={(v) => { if (v) field.onChange(Number(v)) }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VAT_RATES.map((rate) => (
                    <SelectItem key={rate} value={String(rate)}>{rate} %</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        )}
      </div>

      {/* Advanced (collapsible) */}
      <div className="pt-4 border-t">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={advancedOpen}
        >
          <ChevronDown
            className={cn('h-4 w-4 transition-transform duration-200', advancedOpen && 'rotate-180')}
          />
          {t('advanced_section')}
        </button>

        {advancedOpen && (
          <div className="space-y-4 pt-4">
            {/* Revenue account */}
            <div className="space-y-2">
              <Label>{t('revenue_account_label')}</Label>
              <Controller
                name="revenue_account"
                control={control}
                render={({ field }) => (
                  <AccountCombobox
                    value={field.value || ''}
                    accounts={postingAccounts}
                    onChange={field.onChange}
                    onCreateAccount={(prefill) => setCreateAccountPrefill(prefill)}
                  />
                )}
              />
              {errors.revenue_account && (
                <p className="text-sm text-destructive">{errors.revenue_account.message}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('revenue_account_hint')}</p>
            </div>

            {/* Cost price */}
            <div className="space-y-2">
              <Label htmlFor="cost_price">{t('cost_price_label')}</Label>
              <Input
                id="cost_price"
                type="number"
                step="0.01"
                min="0"
                className="tabular-nums"
                {...register('cost_price', {
                  setValueAs: (v) => (v === '' || v == null ? undefined : Number(v)),
                })}
              />
              <p className="text-xs text-muted-foreground">{t('cost_price_hint')}</p>
            </div>

            {/* Currency */}
            <div className="space-y-2">
              <Label>{t('currency_label')}</Label>
              <Controller
                name="currency"
                control={control}
                render={({ field }) => {
                  // Always keep the current value selectable, even before the
                  // fetch resolves or if it's since been deactivated.
                  const codes = currencies.map((c) => c.code)
                  const options = codes.includes(field.value)
                    ? codes
                    : [field.value, ...codes]
                  return (
                    <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((c) => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )
                }}
              />
              <p className="text-xs text-muted-foreground">{t('currency_hint')}</p>
            </div>

            {/* EAN */}
            <div className="space-y-2">
              <Label htmlFor="ean">{t('ean_label')}</Label>
              <Input
                id="ean"
                placeholder={t('ean_placeholder')}
                className="tabular-nums"
                {...register('ean')}
              />
            </div>

            {/* Housework type (tjänst only) */}
            {type === 'tjanst' && (
              <div className="space-y-2">
                <Label>{t('housework_label')}</Label>
                <Controller
                  name="housework_type"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value || 'none'}
                      onValueChange={(v) => field.onChange(v === 'none' ? '' : v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('housework_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('housework_none')}</SelectItem>
                        <SelectItem value="ROT">{t('housework_rot')}</SelectItem>
                        <SelectItem value="RUT">{t('housework_rut')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">{t('housework_hint')}</p>
              </div>
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="notes">{t('notes_label')}</Label>
              <Textarea
                id="notes"
                placeholder={t('notes_placeholder')}
                {...register('notes')}
              />
            </div>
          </div>
        )}
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
          await fetchRevenueAccounts()
          setValue('revenue_account', account.account_number, { shouldDirty: true })
          setCreateAccountPrefill(null)
        }}
      />
    </form>
  )
}
