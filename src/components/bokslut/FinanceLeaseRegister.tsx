'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { PlusIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany } from '@/contexts/CompanyContext'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { FINANCE_LEASE_DEFAULT_ACCOUNTS } from '@/lib/bokslut/leasing/schemas'

interface LeaseListRow {
  id: string
  name: string
  start_date: string
  payment: number | string
  number_of_payments: number
  initial_asset: number
  initial_entry_id: string | null
}

interface ScheduleRow {
  index: number
  date: string
  payment: number
  interest: number
  amortisation: number
  liability: number
}

interface Voucher {
  voucher_series: string | null
  voucher_number: number | null
}

type FormState = Record<string, string>

const EMPTY_FORM: FormState = {
  name: '',
  start_date: '',
  fair_value: '',
  payment: '',
  number_of_payments: '',
  periods_per_year: '12',
  payments_in_advance: 'true',
  annual_rate_percent: '',
  guaranteed_residual: '',
  direct_costs: '',
  direct_cost_account: '',
  useful_life_months: '',
  ownership_transfers: 'false',
  ...FINANCE_LEASE_DEFAULT_ACCOUNTS,
}

const ACCOUNT_FIELDS: Array<[keyof typeof FINANCE_LEASE_DEFAULT_ACCOUNTS, string]> = [
  ['asset_account', 'field_asset_account'],
  ['accumulated_depreciation_account', 'field_accumulated_account'],
  ['liability_account', 'field_liability_account'],
  ['lease_cost_account', 'field_cost_account'],
  ['interest_account', 'field_interest_account'],
  ['accrued_interest_account', 'field_accrued_account'],
  ['depreciation_account', 'field_depreciation_account'],
]

/** The form as the create route takes it, or null when a number does not parse. */
function toBody(form: FormState): Record<string, unknown> | null {
  const fairValue = parseAmountInput(form.fair_value)
  const payment = parseAmountInput(form.payment)
  const rate = parseDecimalInput(form.annual_rate_percent)
  const count = Number.parseInt(form.number_of_payments, 10)
  const life = Number.parseInt(form.useful_life_months, 10)
  const residual = form.guaranteed_residual.trim() === '' ? 0 : parseAmountInput(form.guaranteed_residual)
  const direct = form.direct_costs.trim() === '' ? 0 : parseAmountInput(form.direct_costs)
  if (fairValue === null || payment === null || rate === null || residual === null || direct === null) return null
  if (!Number.isInteger(count) || !Number.isInteger(life)) return null
  return {
    name: form.name.trim(),
    start_date: form.start_date,
    fair_value: fairValue,
    payment,
    number_of_payments: count,
    periods_per_year: Number(form.periods_per_year),
    payments_in_advance: form.payments_in_advance === 'true',
    annual_rate_percent: rate,
    guaranteed_residual: residual,
    direct_costs: direct,
    direct_cost_account: form.direct_cost_account.trim() || null,
    useful_life_months: life,
    ownership_transfers: form.ownership_transfers === 'true',
    ...Object.fromEntries(ACCOUNT_FIELDS.map(([field]) => [field, form[field].trim()])),
  }
}

/**
 * The lessee's register of finansiella leasingavtal (K3 kapitel 20): the
 * company's choice against the 20.29 relief, the leases with their
 * schedules, and "Bokför året" (the start of each new lease and the
 * year-end adjustment). Behind NEXT_PUBLIC_FINANCE_LEASE_ENABLED.
 */
export function FinanceLeaseRegister() {
  const t = useTranslations('finance_leases')
  // The top bar names Bokslut before the page (the menu row these pages sit under).
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { role } = useCompany()
  const isAdmin = role === 'owner' || role === 'admin'
  const saveSettings = useSaveSettings()

  const [loading, setLoading] = useState(true)
  // Failed loads say so in the page with "Försök igen" (Stil v3 states), never a toast.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [scheduleAttempt, setScheduleAttempt] = useState(0)
  const [chosen, setChosen] = useState(false)
  const [leases, setLeases] = useState<LeaseListRow[]>([])
  // The fiscal year is app-wide context (the sidebar); the register shows one started year.
  const { periodId, period } = useFiscalScope({ allowAll: false, hideFuture: true })
  const [selected, setSelected] = useState<LeaseListRow | null>(null)
  const [schedule, setSchedule] = useState<ScheduleRow[] | null>(null)
  const [confirmOptIn, setConfirmOptIn] = useState(false)
  const [confirmBook, setConfirmBook] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const fail = useCallback(
    (title: string, body: unknown): void => {
      toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' })
    },
    [locale, toast],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/bookkeeping/finance-leases')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadError(getErrorMessage(body, { locale, fallback: t('load_failed') }))
        return
      }
      setChosen(Boolean(body.data?.capitalisation_chosen))
      setLeases(body.data?.leases ?? [])
      setLoadError(null)
    } catch {
      setLoadError(t('load_failed'))
    } finally {
      setLoading(false)
    }
  }, [locale, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setSchedule(null)
    setScheduleError(null)
    void (async () => {
      try {
        const res = await fetch(`/api/bookkeeping/finance-leases/${selected.id}`)
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setScheduleError(getErrorMessage(body, { locale, fallback: t('load_failed') }))
          return
        }
        setSchedule(body.data?.schedule?.rows ?? [])
      } catch {
        if (!cancelled) setScheduleError(t('load_failed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selected, scheduleAttempt, locale, t])

  async function optIn() {
    const json = await saveSettings({ finance_lease_capitalisation: true }, { failedTitle: t('opt_in_failed') })
    if (json) await load()
  }

  async function bookYear() {
    if (!periodId) return
    const res = await fetch('/api/bookkeeping/finance-leases/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiscal_period_id: periodId }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('book_failed'), body)
    const vouchers: Voucher[] = [...(body.data?.initial_entries ?? []), ...(body.data?.year_end_entry ? [body.data.year_end_entry] : [])]
    toast({
      title: vouchers.length > 0 ? t('book_done', { vouchers: vouchers.map((v) => formatVoucher(v)).join(', ') }) : t('book_nothing'),
    })
    await load()
  }

  async function create() {
    const body = toBody(form)
    if (!body) {
      toast({ title: t('invalid_numbers'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/bookkeeping/finance-leases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('create_failed'), json)
      toast({ title: t('created') })
      setCreating(false)
      setForm(EMPTY_FORM)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const field = (key: string) => ({
    id: `lease-${key}`,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })

  return (
    <div className="space-y-8">
      <PageHeader
        parent={{ label: tNav('v2_closing'), href: '/bookkeeping/year-end' }}
        title={t('title')}
        help={<HelpPopover>{t('help')}</HelpPopover>}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {chosen && canWrite && (
              <Button size="toolbar" variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon className="h-4 w-4" aria-hidden />
                {t('add')}
              </Button>
            )}
            {chosen && canWrite && (
              <Button size="toolbar" onClick={() => setConfirmBook(true)} disabled={!periodId || leases.length === 0}>
                {t('book')}
              </Button>
            )}
          </div>
        }
      />

      {loadError && leases.length > 0 ? (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>{tCommon('refresh_failed')}</AttnLine>
      ) : !loading && !loadError && !chosen ? (
        <AttnLine action={isAdmin ? { label: t('opt_in_action'), onClick: () => setConfirmOptIn(true) } : undefined}>
          {t('relief_attn')}
        </AttnLine>
      ) : null}

      {loading ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </LateReveal>
      ) : loadError && leases.length === 0 ? (
        <LoadError
          title={t('load_failed')}
          description={loadError === t('load_failed') ? undefined : loadError}
          onRetry={() => void load()}
        />
      ) : leases.length === 0 ? (
        <EmptyState
          title={t('empty_title')}
          description={t('empty_description')}
          {...(chosen && canWrite ? { actionLabel: t('add'), onAction: () => setCreating(true) } : {})}
        />
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="stagger-enter w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_name')}</th>
                <th className={TH_CLASS}>{t('col_start')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_payment')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_payments')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_asset')}</th>
                <th className={TH_CLASS}>{t('col_start_booked')}</th>
              </tr>
            </thead>
            <tbody>
              {leases.map((lease) => (
                <tr
                  key={lease.id}
                  className="cursor-pointer hover:bg-secondary/35"
                  onClick={() => setSelected(lease)}
                >
                  <td className={TD_CLASS} data-ph-mask="">{lease.name}</td>
                  <td className={cn(TD_CLASS, 'date-figures')}>{formatDate(lease.start_date)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(Number(lease.payment))}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{lease.number_of_payments}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(lease.initial_asset)}</td>
                  <td className={TD_CLASS}>
                    {lease.initial_entry_id ? (
                      <span className="text-xs text-muted-foreground">{t('start_booked')}</span>
                    ) : (
                      <Badge variant="outline">{t('start_unbooked')}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-muted-foreground" data-ph-mask="">
              {t('schedule_heading', { name: selected.name })}
            </h2>
            <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSelected(null)}>
              {t('schedule_close')}
            </button>
          </div>
          {scheduleError ? (
            <LoadError
              title={t('load_failed')}
              description={scheduleError === t('load_failed') ? undefined : scheduleError}
              onRetry={() => setScheduleAttempt((n) => n + 1)}
            />
          ) : schedule === null ? (
            <LateReveal>
              <Skeleton className="h-24 w-full" />
            </LateReveal>
          ) : (
            <div className="-mx-2 overflow-x-auto">
              <table className="stagger-enter w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_date')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_payment')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_interest')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_amortisation')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_liability')}</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((row) => (
                    <tr key={row.index} className="hover:bg-secondary/35">
                      <td className={cn(TD_CLASS, 'date-figures')}>{formatDate(row.date)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.payment)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.interest)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.amortisation)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.liability)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmOptIn}
        onOpenChange={setConfirmOptIn}
        title={t('opt_in_confirm_title')}
        description={t('opt_in_confirm_description')}
        confirmLabel={t('opt_in_confirm')}
        onConfirm={optIn}
      />

      <ConfirmDialog
        open={confirmBook}
        onOpenChange={setConfirmBook}
        title={t('book_confirm_title', { year: period?.name ?? '' })}
        description={t('book_confirm_description', { date: period?.period_end ?? '' })}
        confirmLabel={t('book')}
        onConfirm={bookYear}
      />

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{t('add')}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-4 overflow-y-auto sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lease-name">{t('field_name')}</Label>
              <Input {...field('name')} maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-start_date">{t('field_start')}</Label>
              <Input {...field('start_date')} type="date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-fair_value">{t('field_fair_value')}</Label>
              <Input {...field('fair_value')} inputMode="decimal" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-payment">{t('field_payment')}</Label>
              <Input {...field('payment')} inputMode="decimal" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-number_of_payments">{t('field_number_of_payments')}</Label>
              <Input {...field('number_of_payments')} inputMode="numeric" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-periods_per_year">{t('field_periods_per_year')}</Label>
              <SettingsSelect {...field('periods_per_year')}>
                {['12', '4', '2', '1'].map((n) => (
                  <option key={n} value={n}>
                    {t(`periods_${n}`)}
                  </option>
                ))}
              </SettingsSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-payments_in_advance">{t('field_timing')}</Label>
              <SettingsSelect {...field('payments_in_advance')}>
                <option value="true">{t('timing_advance')}</option>
                <option value="false">{t('timing_arrears')}</option>
              </SettingsSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-annual_rate_percent">{t('field_rate')}</Label>
              <Input {...field('annual_rate_percent')} inputMode="decimal" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-useful_life_months">{t('field_useful_life')}</Label>
              <Input {...field('useful_life_months')} inputMode="numeric" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-guaranteed_residual">{t('field_residual')}</Label>
              <Input {...field('guaranteed_residual')} inputMode="decimal" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-ownership_transfers">{t('field_ownership')}</Label>
              <SettingsSelect {...field('ownership_transfers')}>
                <option value="false">{t('no')}</option>
                <option value="true">{t('yes')}</option>
              </SettingsSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-direct_costs">{t('field_direct_costs')}</Label>
              <Input {...field('direct_costs')} inputMode="decimal" className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lease-direct_cost_account">{t('field_direct_cost_account')}</Label>
              <Input {...field('direct_cost_account')} inputMode="numeric" maxLength={4} className="font-mono" />
            </div>
            {ACCOUNT_FIELDS.map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`lease-${key}`}>{t(label)}</Label>
                <Input {...field(key)} inputMode="numeric" maxLength={4} className="font-mono" />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={create} loading={saving} disabled={!form.name.trim() || !form.start_date}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
