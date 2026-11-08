'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { FyPicker } from '@/components/common/FyPicker'
import { SettingsGroup, SettingsRow, SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type {
  ContractRevenueSettings as Settings,
  ContractRevenueYearPreview as Preview,
  ContractRow as Contract,
} from '@/lib/bokslut/pagaende-arbeten/types'

type Form = Record<string, string>

const EMPTY_FORM: Form = {
  name: '',
  kind: 'fast_pris',
  figures_as_of: '',
  contract_value: '',
  expected_total_cost: '',
  costs_to_date: '',
  billed_to_date: '',
  retained_amounts: '',
  reliable_outcome: 'true',
  grade_method: 'utgifter',
  stated_grade: '',
  reimbursable_costs: '',
  value_worked: '',
  substantially_complete: 'false',
}

const text = (value: number | string | null) => (value === null ? '' : String(value))

function formFromContract(c: Contract): Form {
  return {
    name: c.name,
    kind: c.kind,
    figures_as_of: c.figures_as_of,
    contract_value: text(c.contract_value),
    expected_total_cost: text(c.expected_total_cost),
    costs_to_date: text(c.costs_to_date),
    billed_to_date: text(c.billed_to_date),
    retained_amounts: text(c.retained_amounts),
    reliable_outcome: String(c.reliable_outcome),
    grade_method: c.grade_method,
    stated_grade: c.stated_grade === null ? '' : String(Number(c.stated_grade) * 100),
    reimbursable_costs: text(c.reimbursable_costs),
    value_worked: text(c.value_worked),
    substantially_complete: String(c.substantially_complete),
  }
}

/** The form as the routes take it, or null when a number does not parse. */
function toBody(form: Form): Record<string, unknown> | null {
  const amount = (value: string) => (value.trim() === '' ? 0 : parseAmountInput(value))
  const optional = (value: string) => (value.trim() === '' ? null : parseAmountInput(value))
  const required = ['contract_value', 'expected_total_cost', 'costs_to_date', 'billed_to_date', 'retained_amounts'] as const
  const amounts = Object.fromEntries(required.map((key) => [key, amount(form[key])]))
  const reimbursable = optional(form.reimbursable_costs)
  const worked = optional(form.value_worked)
  const grade = form.stated_grade.trim() === '' ? null : parseDecimalInput(form.stated_grade)
  if (Object.values(amounts).some((v) => v === null)) return null
  if (form.reimbursable_costs.trim() !== '' && reimbursable === null) return null
  if (form.value_worked.trim() !== '' && worked === null) return null
  if (form.stated_grade.trim() !== '' && grade === null) return null
  return {
    name: form.name.trim(),
    kind: form.kind,
    figures_as_of: form.figures_as_of,
    ...amounts,
    reliable_outcome: form.reliable_outcome === 'true',
    grade_method: form.grade_method,
    stated_grade: grade === null ? null : grade / 100,
    reimbursable_costs: reimbursable,
    value_worked: worked,
    substantially_complete: form.substantially_complete === 'true',
  }
}

/**
 * Pågående arbeten under K3 kapitel 23: the method and the adjustment
 * account, the uppdrag with their figures on balansdagen, what booking the
 * chosen year would do, and "Bokför året". Behind
 * NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED.
 */
export function ContractRevenueRegister() {
  const t = useTranslations('contract_revenue')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [method, setMethod] = useState<Settings['method']>('successiv')
  const [account, setAccount] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [contracts, setContracts] = useState<Contract[]>([])
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [editing, setEditing] = useState<Contract | 'new' | null>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Contract | null>(null)
  const [confirmBook, setConfirmBook] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const fail = useCallback(
    (title: string, body: unknown): void => {
      toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' })
    },
    [locale, toast],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/bookkeeping/contract-revenue')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('load_failed'), body)
      const saved: Settings | null = body.data?.settings ?? null
      setSettings(saved)
      if (saved) {
        setMethod(saved.method)
        setAccount(saved.revenue_account)
      } else {
        setMethod('successiv')
        setAccount('')
      }
      setContracts(body.data?.contracts ?? [])
    } finally {
      setLoading(false)
    }
  }, [fail, t])

  const loadPreview = useCallback(async () => {
    if (!periodId || !settings) return setPreview(null)
    const res = await fetch(`/api/bookkeeping/contract-revenue/year?fiscal_period_id=${encodeURIComponent(periodId)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('load_failed'), body)
    setPreview(body.data ?? null)
  }, [periodId, settings, fail, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview, contracts])

  async function saveSettings() {
    setSavingSettings(true)
    try {
      const res = await fetch('/api/bookkeeping/contract-revenue', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, revenue_account: account.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('settings_failed'), body)
      setSettings(body.data)
      toast({ title: t('settings_saved') })
    } finally {
      setSavingSettings(false)
    }
  }

  async function removeSettings() {
    const res = await fetch('/api/bookkeeping/contract-revenue', { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('settings_remove_failed'), body)
    toast({ title: t('settings_removed') })
    setPreview(null)
    await load()
  }

  function openEditor(contract: Contract | 'new') {
    setForm(contract === 'new' ? { ...EMPTY_FORM, figures_as_of: preview?.balansdag ?? '' } : formFromContract(contract))
    setEditing(contract)
  }

  async function saveContract() {
    const body = toBody(form)
    if (!body) {
      toast({ title: t('invalid_numbers'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const isNew = editing === 'new'
      const res = await fetch(
        isNew ? '/api/bookkeeping/contract-revenue/contracts' : `/api/bookkeeping/contract-revenue/contracts/${(editing as Contract).id}`,
        { method: isNew ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('save_failed'), json)
      toast({ title: t('saved') })
      setEditing(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function removeContract() {
    if (!deleting) return
    const res = await fetch(`/api/bookkeeping/contract-revenue/contracts/${deleting.id}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('save_failed'), body)
    toast({ title: t('deleted') })
    await load()
  }

  async function bookYear() {
    if (!periodId) return
    const res = await fetch('/api/bookkeeping/contract-revenue/year', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiscal_period_id: periodId }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('book_failed'), body)
    toast({ title: body.data ? t('book_done', { voucher: formatVoucher(body.data) }) : t('book_nothing') })
    await loadPreview()
  }

  const field = (key: string) => ({
    id: `contract-${key}`,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })

  const notK3 = preview !== null && preview.framework !== 'k3'
  // What the accounts hold beyond the register: named on the page and again
  // before booking, since the booking leaves it as it is.
  const unregistered = preview && preview.unregistered.length > 0
    ? t('unregistered_attn', {
        amounts: preview.unregistered.map((u) => `${u.account} ${formatCurrency(u.amount)}`).join(', '),
      })
    : null
  const attention = !loading && !settings
    ? t('not_configured_attn')
    : notK3
      ? t('not_k3_attn', { framework: preview?.framework.toUpperCase() ?? '' })
      : preview && preview.stated_on_other_day.length > 0
        ? t('other_day_attn', { contracts: preview.stated_on_other_day.join(', '), date: preview.balansdag })
        : preview && preview.issues.length > 0
          ? t('issues_attn', { contracts: [...new Set(preview.issues.map((i) => i.contract))].join(', ') })
          : unregistered

  const money = (value: number | string) => formatCurrency(Number(value))

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={<p className="text-sm">{t('help')}</p>}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canWrite && (
              <Button size="sm" variant="outline" onClick={() => openEditor('new')}>
                {t('add')}
              </Button>
            )}
            {canWrite && settings && (
              <Button size="sm" onClick={() => setConfirmBook(true)} disabled={!periodId || !preview || notK3}>
                {t('book')}
              </Button>
            )}
            <FyPicker value={periodId} onChange={(id) => setPeriodId(id)} includeAllOption={false} hideFuturePeriods />
          </div>
        }
      />

      {attention && <AttnLine>{attention}</AttnLine>}

      <SettingsGroup label={t('settings_heading')}>
        <SettingsRow label={t('method_label')} htmlFor="contract-revenue-method">
          <SettingsSelect
            id="contract-revenue-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as Settings['method'])}
            disabled={!canWrite}
          >
            <option value="successiv">{t('method_successiv')}</option>
            <option value="fardigstallande">{t('method_fardigstallande')}</option>
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow label={t('account_label')} htmlFor="contract-revenue-account" help={t('account_help')}>
          <Input
            id="contract-revenue-account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            inputMode="numeric"
            maxLength={4}
            className="font-mono"
            disabled={!canWrite}
          />
          {canWrite && (
            <Button size="sm" variant="outline" onClick={saveSettings} loading={savingSettings} disabled={account.trim().length !== 4}>
              {t('settings_save')}
            </Button>
          )}
          {canWrite && settings && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
              {t('settings_remove')}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : contracts.length === 0 ? (
        <EmptyState
          title={t('empty_title')}
          description={t('empty_description')}
          {...(canWrite ? { actionLabel: t('add'), onAction: () => openEditor('new') } : {})}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="stagger-enter w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_name')}</th>
                <th className={TH_CLASS}>{t('col_kind')}</th>
                <th className={TH_CLASS}>{t('col_as_of')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_value')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_costs')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_total_cost')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_billed')}</th>
                <th className={TH_CLASS} />
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id} className="hover:bg-secondary/35">
                  <td className={TD_CLASS} data-ph-mask="">{c.name}</td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')}>{t(`kind_${c.kind}`)}</td>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(c.figures_as_of)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{money(c.contract_value)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{money(c.costs_to_date)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{money(c.expected_total_cost)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{money(c.billed_to_date)}</td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                    {canWrite && (
                      <span className="inline-flex gap-3">
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => openEditor(c)}>
                          {t('edit')}
                        </button>
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => setDeleting(c)}>
                          {t('delete')}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && preview.positions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('preview_heading', { date: formatDate(preview.balansdag) })}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_name')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_grade')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_earned')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_net')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_loss')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.positions.map((p) => (
                  <tr key={p.id}>
                    <td className={TD_CLASS} data-ph-mask="">{p.name}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                      {p.fardigstallandegrad_procent === null ? '' : `${p.fardigstallandegrad_procent} %`}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(p.upparbetad_intakt)}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(p.netto)}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(p.befarad_forlust)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.lines.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('preview_no_lines')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_account')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_debit')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_credit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((line, i) => (
                    <tr key={`${line.account_number}-${i}`}>
                      <td className={cn(TD_CLASS, 'font-mono')}>{line.account_number}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{line.debit_amount ? formatCurrency(line.debit_amount) : ''}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{line.credit_amount ? formatCurrency(line.credit_amount) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmBook}
        onOpenChange={setConfirmBook}
        title={t('book_confirm_title', { date: preview?.balansdag ?? '' })}
        description={unregistered ? `${t('book_confirm_description')} ${unregistered}` : t('book_confirm_description')}
        confirmLabel={t('book')}
        onConfirm={bookYear}
      />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('settings_remove_confirm_title')}
        description={t('settings_remove_confirm_description')}
        confirmLabel={t('settings_remove')}
        destructive
        onConfirm={removeSettings}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('delete_confirm_title', { name: deleting?.name ?? '' })}
        description={t('delete_confirm_description')}
        confirmLabel={t('delete')}
        destructive
        onConfirm={removeContract}
      />

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? t('add') : t('edit')}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-4 overflow-y-auto sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="contract-name">{t('field_name')}</Label>
              <Input {...field('name')} maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contract-kind">{t('field_kind')}</Label>
              <SettingsSelect {...field('kind')}>
                <option value="fast_pris">{t('kind_fast_pris')}</option>
                <option value="lopande_rakning">{t('kind_lopande_rakning')}</option>
              </SettingsSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="contract-figures_as_of">{t('field_as_of')}</Label>
              <Input {...field('figures_as_of')} type="date" />
            </div>
            {(
              [
                ['contract_value', 'field_value'],
                ['expected_total_cost', 'field_total_cost'],
                ['costs_to_date', 'field_costs'],
                ['billed_to_date', 'field_billed'],
                ['retained_amounts', 'field_retained'],
                ['reimbursable_costs', 'field_reimbursable'],
                ['value_worked', 'field_value_worked'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`contract-${key}`}>{t(label)}</Label>
                <Input {...field(key)} inputMode="decimal" className="tabular-nums" />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="contract-reliable_outcome">{t('field_reliable')}</Label>
              <SettingsSelect {...field('reliable_outcome')}>
                <option value="true">{t('yes')}</option>
                <option value="false">{t('no')}</option>
              </SettingsSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="contract-grade_method">{t('field_grade_method')}</Label>
              <SettingsSelect {...field('grade_method')}>
                <option value="utgifter">{t('grade_utgifter')}</option>
                <option value="undersokning">{t('grade_undersokning')}</option>
                <option value="fysisk">{t('grade_fysisk')}</option>
              </SettingsSelect>
            </div>
            {form.grade_method !== 'utgifter' && (
              <div className="space-y-1">
                <Label htmlFor="contract-stated_grade">{t('field_grade')}</Label>
                <Input {...field('stated_grade')} inputMode="decimal" className="tabular-nums" />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="contract-substantially_complete">{t('field_complete')}</Label>
              <SettingsSelect {...field('substantially_complete')}>
                <option value="false">{t('no')}</option>
                <option value="true">{t('yes')}</option>
              </SettingsSelect>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={saveContract} loading={saving} disabled={!form.name.trim() || !form.figures_as_of}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
