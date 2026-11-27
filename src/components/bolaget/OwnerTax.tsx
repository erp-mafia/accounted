'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BolagetHeader } from './BolagetHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { PlusIcon } from '@/components/icons'
import { ContextPicker } from '@/components/common/ContextPicker'
import { NAME_LINK_CLASS, ROW_ACTIONS_TD } from './register-table'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { DEFAULT_LOAN_ACCOUNTS, LOAN_EXCEPTIONS, LOAN_RELATIONS, type LoanDirection } from '@/lib/bolaget/owner-tax/types'
import type { K10OwnerView, K10YearView } from '@/lib/bolaget/owner-tax/k10'
import type { OwnerLoanView, OwnerLoansView, SpecialListRow } from '@/lib/bolaget/owner-tax/loans-view'
import type { Ku20Status } from '@/lib/bolaget/owner-tax/ku20'
import type { BoardLoansNote } from '@/lib/bolaget/owner-tax/arl-note'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { ownerTaxOpeningYear } from '@/lib/bolaget/filing-year'

type FormState = Record<string, string>
type Preview = Record<string, unknown>

interface PageData {
  year: number
  k10: K10YearView
  loans: OwnerLoansView
  special_list: SpecialListRow[]
  ku20: Ku20Status
  board_note: BoardLoansNote
  can_download_ku20: boolean
}

interface Person {
  party_id: string
  name: string
  kind: 'person' | 'company'
}

const NEW_PARTY = '__new'

/** An amount field: '' is null (cleared), anything else must parse. */
function amountOrNull(value: string): number | null | undefined {
  if (value.trim() === '') return null
  const n = parseAmountInput(value)
  return n === null ? undefined : n
}

/** The new-loan form as POST /api/bolaget/owner-tax/loans takes it. */
export function loanBody(form: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    direction: form.direction,
    kind: form.kind,
    relation: form.relation,
    principal: parseAmountInput(form.principal),
    start_date: form.start_date,
  }
  if (form.party && form.party !== NEW_PARTY) body.party_id = form.party
  else {
    body.party_name = form.name.trim()
    body.party_kind = form.party_kind
    if (form.party_kind === 'company' && form.org_number.trim()) body.party_org_number = form.org_number.trim()
  }
  if (form.relation === 'related_person' || form.relation === 'controlled_entity') body.related_to_party_id = form.related_to || null
  if (form.relation_detail.trim()) body.relation_detail = form.relation_detail.trim()
  if (form.kind === 'loan' && form.account.trim()) body.account = form.account.trim()
  if (form.interest_rate.trim()) body.interest_rate = parseDecimalInput(form.interest_rate)
  if (form.maturity_date) body.maturity_date = form.maturity_date
  if (form.terms.trim()) body.terms = form.terms.trim()
  if (form.exception !== 'none') body.exception = form.exception
  if (form.exception_note.trim()) body.exception_note = form.exception_note.trim()
  return body
}

/**
 * Ägarskatt och närstående: the K10 underlag per delägare and inkomstår,
 * the owner loan register with the låneförbud check and the ledger
 * reconciliation, the 21:10 special list, the ÅRL 5:18 note and KU20.
 * Nothing here books; every write is previewed first (design convention 10).
 */
export function OwnerTax() {
  const t = useTranslations('bolaget_owner_tax')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [year, setYear] = useState<number>(() => ownerTaxOpeningYear(todayIsoStockholm()))
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<PageData | null>(null)
  // The page could not be read. The year the data on screen belongs to
  // tells a failed refresh (keep it, one line above) from a failed year
  // change (another year's figures must not stand in for this one's).
  const [loadFailed, setLoadFailed] = useState(false)
  const [dataYear, setDataYear] = useState<number | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)

  const [owner, setOwner] = useState<K10OwnerView | null>(null)
  const [inputs, setInputs] = useState<{ owner: K10OwnerView; form: FormState } | null>(null)
  const [loanForm, setLoanForm] = useState<FormState | null>(null)
  const [loanEdit, setLoanEdit] = useState<{ loan: OwnerLoanView; form: FormState } | null>(null)
  const [interest, setInterest] = useState<{ loan: OwnerLoanView; form: FormState } | null>(null)

  const fail = useCallback(
    (title: string, body: unknown) => toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' }),
    [locale, toast],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, register] = await Promise.all([fetch(`/api/bolaget/owner-tax?year=${year}`), fetch('/api/bolaget/share-register')])
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      setData(body.data as PageData)
      setDataYear(year)
      setLoadFailed(false)
      const reg = await register.json().catch(() => ({}))
      if (register.ok) setPeople(((reg.data?.people ?? []) as Person[]).map((p) => ({ party_id: p.party_id, name: p.name, kind: p.kind })))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => {
    void load()
  }, [load])

  const years = useMemo(() => {
    const now = Number(todayIsoStockholm().slice(0, 4))
    return [...new Set([now + 1, now, now - 1, now - 2, ...(data?.k10.supported_years ?? []), year])].sort((a, b) => b - a)
  }, [data, year])

  /** Send a write: a dry run first (the preview), the real request when the preview is confirmed. */
  const send = useCallback(
    async (url: string, method: string, body: Record<string, unknown>, dryRun: boolean): Promise<Preview | null> => {
      setBusy(true)
      try {
        const res = await fetch(dryRun ? `${url}?dry_run=true` : url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          fail(t('save_failed'), json)
          return null
        }
        return (json.data ?? {}) as Preview
      } finally {
        setBusy(false)
      }
    },
    [fail, t],
  )

  const warningsOf = (p: Preview | null): string[] => (Array.isArray(p?.warnings) ? (p!.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : [])

  function previewBlock() {
    if (!preview) return null
    const ban = (preview.loan_ban ?? null) as { status?: string } | null
    return (
      <div className="space-y-2 rounded-lg p-4 text-[13px] bg-control shadow-raised">
        <div className="text-xs font-medium text-muted-foreground">{t('preview_heading')}</div>
        {ban?.status ? <div>{t(`ban_${ban.status}` as 'ban_prohibited')}</div> : null}
        {warningsOf(preview).map((w) => (
          <AttnLine key={w}>{w}</AttnLine>
        ))}
        {warningsOf(preview).length === 0 && !ban?.status ? <div className="text-muted-foreground">{t('preview_ok')}</div> : null}
      </div>
    )
  }

  function footer(onCancel: () => void, onPreview: () => void, onConfirm: () => void, confirmLabel: string) {
    return (
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        {preview ? (
          <Button loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        ) : (
          <Button loading={busy} onClick={onPreview}>
            {t('preview_action')}
          </Button>
        )}
      </DialogFooter>
    )
  }

  // ── K10 inputs ─────────────────────────────────────────────────────

  function openInputs(o: K10OwnerView) {
    setPreview(null)
    setOwner(null)
    const n = (v: number | null) => (v === null ? '' : String(v))
    setInputs({
      owner: o,
      form: {
        saved_dividend_space: String(o.inputs.saved_dividend_space || ''),
        cost_basis_override: n(o.inputs.cost_basis_override),
        payroll_base_override: n(o.inputs.payroll_base_override),
        own_pay_override: n(o.inputs.own_pay_override),
        uses_basic_amount: o.inputs.uses_basic_amount ? 'true' : '',
        note: o.inputs.note ?? '',
      },
    })
  }

  function inputsBody(form: FormState): Record<string, unknown> | null {
    const fields = ['cost_basis_override', 'payroll_base_override', 'own_pay_override'] as const
    const body: Record<string, unknown> = { uses_basic_amount: form.uses_basic_amount === 'true', note: form.note.trim() || null }
    const saved = amountOrNull(form.saved_dividend_space)
    if (saved === undefined) return null
    body.saved_dividend_space = saved ?? 0
    for (const f of fields) {
      const v = amountOrNull(form[f])
      if (v === undefined) return null
      body[f] = v
    }
    return body
  }

  async function submitInputs(dryRun: boolean) {
    if (!inputs) return
    const body = inputsBody(inputs.form)
    if (!body) return fail(t('save_failed'), { error: { message: t('amount_invalid') } })
    const result = await send(`/api/bolaget/owner-tax/k10/${year}/owners/${inputs.owner.party_id}`, 'PUT', body, dryRun)
    if (!result) return
    if (dryRun) return setPreview(result)
    setInputs(null)
    setPreview(null)
    toast({ title: t('inputs_saved') })
    void load()
  }

  // ── Loans ──────────────────────────────────────────────────────────

  function openLoan(direction: LoanDirection) {
    setPreview(null)
    setLoanForm({
      party: people[0]?.party_id ?? NEW_PARTY,
      name: '',
      party_kind: 'person',
      org_number: '',
      direction,
      kind: 'loan',
      relation: 'none',
      related_to: '',
      relation_detail: '',
      account: DEFAULT_LOAN_ACCOUNTS[direction].short,
      principal: '',
      interest_rate: '',
      start_date: todayIsoStockholm(),
      maturity_date: '',
      terms: '',
      exception: 'none',
      exception_note: '',
    })
  }

  async function submitLoan(dryRun: boolean) {
    if (!loanForm) return
    const body = loanBody(loanForm)
    if (body.principal === null) return fail(t('save_failed'), { error: { message: t('amount_invalid') } })
    const result = await send('/api/bolaget/owner-tax/loans', 'POST', body, dryRun)
    if (!result) return
    if (dryRun) return setPreview(result)
    setLoanForm(null)
    setPreview(null)
    toast({ title: t('loan_saved') })
    void load()
  }

  function openEdit(loan: OwnerLoanView) {
    setPreview(null)
    setLoanEdit({
      loan,
      form: {
        outstanding: String(loan.outstanding),
        interest_rate: loan.interest_rate === null ? '' : String(loan.interest_rate),
        terms: loan.terms ?? '',
        exception: loan.exception,
        exception_note: loan.exception_note ?? '',
        status: loan.status,
        repaid_on: loan.repaid_on ?? '',
      },
    })
  }

  async function submitEdit(dryRun: boolean) {
    if (!loanEdit) return
    const f = loanEdit.form
    const outstanding = parseAmountInput(f.outstanding)
    if (outstanding === null) return fail(t('save_failed'), { error: { message: t('amount_invalid') } })
    const body: Record<string, unknown> = {
      outstanding,
      interest_rate: f.interest_rate.trim() ? parseDecimalInput(f.interest_rate) : null,
      terms: f.terms.trim() || null,
      exception: f.exception,
      exception_note: f.exception_note.trim() || null,
      status: f.status,
    }
    if (f.status === 'repaid') body.repaid_on = f.repaid_on || null
    const result = await send(`/api/bolaget/owner-tax/loans/${loanEdit.loan.owner_loan_id}`, 'PATCH', body, dryRun)
    if (!result) return
    if (dryRun) return setPreview(result)
    setLoanEdit(null)
    setPreview(null)
    toast({ title: t('loan_saved') })
    void load()
  }

  function openInterest(loan: OwnerLoanView) {
    setPreview(null)
    const current = loan.interest.find((i) => i.income_year === year)
    setInterest({ loan, form: { income_year: String(year), interest_amount: current ? String(current.interest_amount) : '', tax_withheld: current ? String(current.tax_withheld) : '' } })
  }

  async function submitInterest(dryRun: boolean) {
    if (!interest) return
    const amount = parseAmountInput(interest.form.interest_amount)
    const tax = interest.form.tax_withheld.trim() ? parseAmountInput(interest.form.tax_withheld) : 0
    if (amount === null || tax === null) return fail(t('save_failed'), { error: { message: t('amount_invalid') } })
    const body = { income_year: Number(interest.form.income_year), interest_amount: amount, tax_withheld: tax }
    const result = await send(`/api/bolaget/owner-tax/loans/${interest.loan.owner_loan_id}/interest`, 'POST', body, dryRun)
    if (!result) return
    if (dryRun) return setPreview(result)
    setInterest(null)
    setPreview(null)
    toast({ title: t('interest_saved') })
    void load()
  }

  // ── Render ─────────────────────────────────────────────────────────

  const header = (
    <>
      <BolagetHeader
        title={t('title')}
        subtitle={t('subtitle')}
        help={t('help')}
        toolbar={
          <ContextPicker
            ariaLabel={t('year')}
            triggerLabel={`${t('year')} ${year}`}
            items={years.map((y) => ({ id: String(y), label: String(y) }))}
            value={String(year)}
            onChange={(id) => setYear(Number(id))}
          />
        }
        action={
          canWrite ? (
            <Button onClick={() => openLoan('borrows')}>
              <PlusIcon className="h-4 w-4" />
              {t('new_loan')}
            </Button>
          ) : undefined
        }
      />
    </>
  )

  if (loading && !data) {
    return (
      <div className="space-y-8">
        {header}
        <LateReveal className="space-y-8">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </LateReveal>
      </div>
    )
  }
  if (loadFailed && (!data || dataYear !== year)) {
    return (
      <div className="space-y-8">
        {header}
        <LoadError title={t('load_failed')} onRetry={() => void load()} />
      </div>
    )
  }
  if (!data) return <div className="space-y-8">{header}</div>

  const { k10, loans, ku20 } = data
  const field = (state: FormState, set: (s: FormState) => void, key: string, id: string) => ({
    id,
    value: state[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ ...state, [key]: e.target.value }),
  })
  const dirLabel = (l: OwnerLoanView) => (l.kind === 'security' ? t('kind_security') : l.direction === 'lends' ? t('direction_lends') : t('direction_borrows'))

  return (
    <div className="space-y-8">
      {header}

      {loadFailed && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>{tCommon('refresh_failed')}</AttnLine>
      )}

      {/* K10 */}
      <section className="space-y-3">
        <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('k10_heading', { year: k10.income_year })}</h2>
        {!k10.supported ? (
          <EmptyState title={t('k10_unsupported_title')} description={k10.unsupported_reason_sv ?? ''} />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {k10.famansforetag.value ? t('famans_yes') : t('famans_no')} {k10.famansforetag.confirmed ? t('famans_confirmed') : t('famans_derived')}{' '}
              {t('payroll_line', { year: k10.payroll.year, amount: formatCurrency(k10.payroll.total), runs: k10.payroll.runs })}
            </p>
            {k10.owners.length === 0 ? (
              <EmptyState title={t('k10_empty_title')} description={t('k10_empty_body')} />
            ) : (
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
<table className="stagger-enter w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_owner')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares_start')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_limit')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_dividend')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_carried')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {k10.owners.map((o) => (
                    <tr key={o.party_id} className="group hover:bg-secondary/35">
                      <td className={TD_CLASS} data-ph-mask="">
                        <button type="button" className={NAME_LINK_CLASS} onClick={() => setOwner(o)}>
                          {o.name}
                        </button>
                        {o.warnings.length > 0 ? (
                          <Badge variant="warning" className="ml-2">
                            {t('check_badge')}
                          </Badge>
                        ) : null}
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{o.shares_at_start.toLocaleString('sv-SE')}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(o.result.total_limit)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(o.result.dividend)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(o.result.saved_space_carried_forward)}</td>
                      <td className={ROW_ACTIONS_TD}>
                        <span className="flex justify-end">
                          {canWrite ? (
                            <Button variant="row" onClick={() => openInputs(o)}>
                              {t('edit_inputs')}
                            </Button>
                          ) : null}
                          <Button variant="row" asChild>
                            <a href={`/api/bolaget/owner-tax/k10/${k10.income_year}/owners/${o.party_id}/pdf`}>{t('pdf')}</a>
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
</div>
            )}
            {k10.company_holders.length > 0 ? <p className="text-xs text-muted-foreground">{t('company_holders', { names: k10.company_holders.map((c) => c.name).join(', ') })}</p> : null}
          </>
        )}
      </section>

      {/* Owner loans */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('loans_heading')}</h2>
          {canWrite ? (
            <Button variant="ghost" onClick={() => openLoan('lends')}>
              <PlusIcon className="h-4 w-4" />
              {t('new_loan_lends')}
            </Button>
          ) : null}
        </div>
        {loans.flagged > 0 ? <AttnLine>{t('flagged', { count: loans.flagged })}</AttnLine> : null}
        {loans.loans.length === 0 ? (
          <EmptyState title={t('loans_empty_title')} description={t('loans_empty_body')} />
        ) : (
          <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
<table className="stagger-enter w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_counterparty')}</th>
                <th className={TH_CLASS}>{t('col_direction')}</th>
                <th className={TH_CLASS}>{t('col_account')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_outstanding')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_rate')}</th>
                <th className={TH_CLASS}>{t('col_start')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={TH_CLASS} />
              </tr>
            </thead>
            <tbody>
              {loans.loans.map((l) => (
                <tr key={l.owner_loan_id} className="group hover:bg-secondary/35">
                  <td className={TD_CLASS} data-ph-mask="">
                    {l.party.name}
                  </td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')}>{dirLabel(l)}</td>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{l.account ?? ''}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(l.kind === 'security' ? l.principal : l.outstanding)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{l.interest_rate === null ? '' : `${l.interest_rate.toLocaleString('sv-SE')} %`}</td>
                  <td className={cn(TD_CLASS, 'date-figures')}>{formatDate(l.start_date)}</td>
                  <td className={TD_CLASS}>
                    {l.status === 'active' && l.loan_ban.status === 'prohibited' ? (
                      <Badge variant="warning">{t('ban_prohibited_chip')}</Badge>
                    ) : l.status === 'active' && l.loan_ban.special_list ? (
                      <Badge variant="outline">{t('special_list_chip')}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t(`status_${l.status}` as 'status_active')}</span>
                    )}
                  </td>
                  <td className={ROW_ACTIONS_TD}>
                    {canWrite && l.status !== 'cancelled' ? (
                      <span className="flex justify-end">
                        {l.kind === 'loan' ? (
                          <Button variant="row" onClick={() => openInterest(l)}>
                            {t('interest_action')}
                          </Button>
                        ) : null}
                        <Button variant="row" onClick={() => openEdit(l)}>
                          {t('edit_action')}
                        </Button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
        {loans.reconciliation.length > 0 ? (
          <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
<table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_account')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_register')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_ledger', { date: formatDate(loans.as_of) })}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_difference')}</th>
              </tr>
            </thead>
            <tbody>
              {loans.reconciliation.map((r) => (
                <tr key={r.account} className="hover:bg-secondary/35">
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{r.account}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(r.register_amount)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{r.ledger_amount === null ? t('ledger_unread') : formatRowAmount(r.ledger_amount)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                    {r.matches === false ? <Badge variant="warning">{formatRowAmount(r.difference ?? 0)}</Badge> : <span className="text-xs text-muted-foreground">{r.matches ? t('matches') : ''}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t('special_list_line', { year, count: data.special_list.length })}{' '}
          <a className={QUIET_LINK_CLASS} href={`/api/bolaget/owner-tax/special-list/${year}`}>
            {t('special_list_pdf')}
          </a>
        </p>
      </section>

      {/* ÅRL 5:18 note */}
      <section className="space-y-3">
        <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('note_heading', { date: formatDate(data.board_note.balance_date) })}</h2>
        {data.board_note.applicable ? (
          <div className="space-y-1 text-[13px]">
            <div className="font-medium">{data.board_note.heading_sv}</div>
            <p>{data.board_note.text_sv}</p>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t('note_none')}</p>
        )}
      </section>

      {/* KU20 */}
      <section className="space-y-3">
        <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('ku20_heading', { year: ku20.income_year })}</h2>
        {ku20.recipients.length === 0 ? (
          ku20.blockers.length === 0 && ku20.warnings.length === 0 && <p className="text-[13px] text-muted-foreground">{t('ku20_empty', { year: ku20.income_year })}</p>
        ) : (
          <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
<table className="stagger-enter w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_recipient')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_interest')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_tax')}</th>
                <th className={TH_CLASS}>{t('col_delagare')}</th>
              </tr>
            </thead>
            <tbody>
              {ku20.recipients.map((r) => (
                <tr key={r.party_id} className="hover:bg-secondary/35">
                  <td className={TD_CLASS} data-ph-mask="">
                    {r.name}
                    {r.identity ? <span className="ml-2 text-muted-foreground tabular-nums">{r.identity}</span> : null}
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(r.reported_interest)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                    {r.expected_tax !== null && r.expected_tax !== r.tax_withheld ? <Badge variant="warning">{formatRowAmount(r.reported_tax)}</Badge> : formatRowAmount(r.reported_tax)}
                  </td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')}>{r.delagare ? t('yes') : t('no')}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
        {ku20.blockers.length > 0 || ku20.warnings.length > 0 ? (
          <ul className="max-w-[760px] space-y-1 text-[13px] text-muted-foreground">
            {[...ku20.blockers, ...ku20.warnings].map((b) => (
              <li key={`${b.code}-${b.party_id ?? ''}`}>{b.message_sv}</li>
            ))}
          </ul>
        ) : null}
        {data.can_download_ku20 && ku20.ready ? (
          <Button variant="outline" asChild>
            <a href={`/api/bolaget/owner-tax/ku20/${ku20.income_year}/file`}>{t('ku20_download')}</a>
          </Button>
        ) : null}
      </section>

      {/* One owner's K10 underlag. */}
      <Dialog open={Boolean(owner)} onOpenChange={(open) => (open ? null : setOwner(null))}>
        <DialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{owner ? t('owner_title', { name: owner.name, year: k10.income_year }) : ''}</DialogTitle>
          </DialogHeader>
          {owner ? (
            <div className="space-y-3">
              {owner.warnings.map((w) => (
                <AttnLine key={w.code}>{w.message_sv}</AttnLine>
              ))}
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_line')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                    <th className={TH_CLASS}>{t('col_source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {owner.result.lines.map((l) => (
                    <tr key={l.key}>
                      <td className={TD_CLASS}>{l.label_sv}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{l.unit === 'percent' ? `${l.amount.toLocaleString('sv-SE')} %` : formatRowAmount(l.amount)}</td>
                      <td className={cn(TD_CLASS, 'text-muted-foreground')}>{l.detail_sv}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <DialogFooter>
            {owner && canWrite ? (
              <Button variant="outline" onClick={() => openInputs(owner)}>
                {t('edit_inputs')}
              </Button>
            ) : null}
            {owner ? (
              <Button asChild>
                <a href={`/api/bolaget/owner-tax/k10/${k10.income_year}/owners/${owner.party_id}/pdf`}>{t('pdf')}</a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The owner's own K10 figures. */}
      <Dialog open={Boolean(inputs)} onOpenChange={(open) => (open ? null : setInputs(null))}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{inputs ? t('inputs_title', { name: inputs.owner.name, year: k10.income_year }) : ''}</DialogTitle>
          </DialogHeader>
          {inputs ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {(['saved_dividend_space', 'cost_basis_override', 'payroll_base_override', 'own_pay_override'] as const).map((key) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`k10-${key}`}>{t(`field_${key}`)}</Label>
                    <Input {...field(inputs.form, (form) => { setPreview(null); setInputs({ ...inputs, form }) }, key, `k10-${key}`)} inputMode="decimal" className="tabular-nums" />
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('inputs_hint')}</p>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="k10-basic"
                  checked={inputs.form.uses_basic_amount === 'true'}
                  onCheckedChange={(v) => {
                    setPreview(null)
                    setInputs({ ...inputs, form: { ...inputs.form, uses_basic_amount: v === true ? 'true' : '' } })
                  }}
                />
                <Label htmlFor="k10-basic" className="text-[13px] font-normal leading-5">
                  {t('field_uses_basic_amount')}
                </Label>
              </div>
              {preview ? <div className="rounded-lg p-4 text-[13px] text-muted-foreground bg-control shadow-raised">{t('inputs_preview')}</div> : null}
            </div>
          ) : null}
          {footer(() => setInputs(null), () => void submitInputs(true), () => void submitInputs(false), t('save'))}
        </DialogContent>
      </Dialog>

      {/* New loan or security. */}
      <Dialog open={Boolean(loanForm)} onOpenChange={(open) => (open ? null : setLoanForm(null))}>
        <DialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{loanForm?.direction === 'lends' ? t('new_loan_lends') : t('new_loan')}</DialogTitle>
          </DialogHeader>
          {loanForm ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="loan-party">{t('field_counterparty')}</Label>
                  <SettingsSelect id="loan-party" value={loanForm.party} onChange={(e) => { setPreview(null); setLoanForm({ ...loanForm, party: e.target.value }) }}>
                    {people.map((p) => (
                      <option key={p.party_id} value={p.party_id}>
                        {p.name}
                      </option>
                    ))}
                    <option value={NEW_PARTY}>{t('new_person')}</option>
                  </SettingsSelect>
                </div>
                {loanForm.party === NEW_PARTY ? (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="loan-name">{t('field_name')}</Label>
                      <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'name', 'loan-name')} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="loan-party-kind">{t('field_party_kind')}</Label>
                      <SettingsSelect id="loan-party-kind" value={loanForm.party_kind} onChange={(e) => { setPreview(null); setLoanForm({ ...loanForm, party_kind: e.target.value }) }}>
                        <option value="person">{t('party_kind_person')}</option>
                        <option value="company">{t('party_kind_company')}</option>
                      </SettingsSelect>
                    </div>
                    {loanForm.party_kind === 'company' ? (
                      <div className="space-y-1">
                        <Label htmlFor="loan-org">{t('field_org_number')}</Label>
                        <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'org_number', 'loan-org')} className="tabular-nums" />
                      </div>
                    ) : null}
                  </>
                ) : null}
                <div className="space-y-1">
                  <Label htmlFor="loan-direction">{t('field_direction')}</Label>
                  <SettingsSelect
                    id="loan-direction"
                    value={loanForm.direction}
                    onChange={(e) => {
                      const direction = e.target.value as LoanDirection
                      setPreview(null)
                      setLoanForm({ ...loanForm, direction, kind: direction === 'borrows' ? 'loan' : loanForm.kind, account: DEFAULT_LOAN_ACCOUNTS[direction].short })
                    }}
                  >
                    <option value="borrows">{t('direction_borrows')}</option>
                    <option value="lends">{t('direction_lends')}</option>
                  </SettingsSelect>
                </div>
                {loanForm.direction === 'lends' ? (
                  <div className="space-y-1">
                    <Label htmlFor="loan-kind">{t('field_kind')}</Label>
                    <SettingsSelect id="loan-kind" value={loanForm.kind} onChange={(e) => { setPreview(null); setLoanForm({ ...loanForm, kind: e.target.value }) }}>
                      <option value="loan">{t('kind_loan')}</option>
                      <option value="security">{t('kind_security')}</option>
                    </SettingsSelect>
                  </div>
                ) : null}
                <div className="space-y-1">
                  <Label htmlFor="loan-principal">{t('field_principal')}</Label>
                  <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'principal', 'loan-principal')} inputMode="decimal" className="tabular-nums" />
                </div>
                {loanForm.kind === 'loan' ? (
                  <div className="space-y-1">
                    <Label htmlFor="loan-account">{t('field_account')}</Label>
                    <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'account', 'loan-account')} inputMode="numeric" className="tabular-nums" />
                  </div>
                ) : null}
                <div className="space-y-1">
                  <Label htmlFor="loan-rate">{t('field_interest_rate')}</Label>
                  <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'interest_rate', 'loan-rate')} inputMode="decimal" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="loan-start">{t('field_start_date')}</Label>
                  <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'start_date', 'loan-start')} type="date" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="loan-relation">{t('field_relation')}</Label>
                  <SettingsSelect id="loan-relation" value={loanForm.relation} onChange={(e) => { setPreview(null); setLoanForm({ ...loanForm, relation: e.target.value }) }}>
                    {LOAN_RELATIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`relation_${r}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
                {loanForm.relation === 'related_person' || loanForm.relation === 'controlled_entity' ? (
                  <div className="space-y-1">
                    <Label htmlFor="loan-related">{t('field_related_to')}</Label>
                    <SettingsSelect id="loan-related" value={loanForm.related_to} onChange={(e) => { setPreview(null); setLoanForm({ ...loanForm, related_to: e.target.value }) }}>
                      <option value="">{t('choose')}</option>
                      {people.map((p) => (
                        <option key={p.party_id} value={p.party_id}>
                          {p.name}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                ) : null}
                {loanForm.direction === 'lends' ? (
                  <div className="space-y-1">
                    <Label htmlFor="loan-exception">{t('field_exception')}</Label>
                    <SettingsSelect id="loan-exception" value={loanForm.exception} onChange={(e) => { setPreview(null); setLoanForm({ ...loanForm, exception: e.target.value }) }}>
                      {LOAN_EXCEPTIONS.map((x) => (
                        <option key={x} value={x}>
                          {t(`exception_${x}`)}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="loan-terms">{t('field_terms')}</Label>
                <Input {...field(loanForm, (f) => { setPreview(null); setLoanForm(f) }, 'terms', 'loan-terms')} />
              </div>
              {previewBlock()}
            </div>
          ) : null}
          {footer(() => setLoanForm(null), () => void submitLoan(true), () => void submitLoan(false), t('save'))}
        </DialogContent>
      </Dialog>

      {/* Change a loan. */}
      <Dialog open={Boolean(loanEdit)} onOpenChange={(open) => (open ? null : setLoanEdit(null))}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{loanEdit ? t('edit_title', { name: loanEdit.loan.party.name }) : ''}</DialogTitle>
          </DialogHeader>
          {loanEdit ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="edit-status">{t('field_status')}</Label>
                  <SettingsSelect id="edit-status" value={loanEdit.form.status} onChange={(e) => { setPreview(null); setLoanEdit({ ...loanEdit, form: { ...loanEdit.form, status: e.target.value } }) }}>
                    <option value="active">{t('status_active')}</option>
                    <option value="repaid">{t('status_repaid')}</option>
                    <option value="cancelled">{t('status_cancelled')}</option>
                  </SettingsSelect>
                </div>
                {loanEdit.form.status === 'repaid' ? (
                  <div className="space-y-1">
                    <Label htmlFor="edit-repaid">{t('field_repaid_on')}</Label>
                    <Input {...field(loanEdit.form, (form) => { setPreview(null); setLoanEdit({ ...loanEdit, form }) }, 'repaid_on', 'edit-repaid')} type="date" className="tabular-nums" />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="edit-outstanding">{t('field_outstanding')}</Label>
                    <Input {...field(loanEdit.form, (form) => { setPreview(null); setLoanEdit({ ...loanEdit, form }) }, 'outstanding', 'edit-outstanding')} inputMode="decimal" className="tabular-nums" />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="edit-rate">{t('field_interest_rate')}</Label>
                  <Input {...field(loanEdit.form, (form) => { setPreview(null); setLoanEdit({ ...loanEdit, form }) }, 'interest_rate', 'edit-rate')} inputMode="decimal" className="tabular-nums" />
                </div>
                {loanEdit.loan.direction === 'lends' ? (
                  <div className="space-y-1">
                    <Label htmlFor="edit-exception">{t('field_exception')}</Label>
                    <SettingsSelect id="edit-exception" value={loanEdit.form.exception} onChange={(e) => { setPreview(null); setLoanEdit({ ...loanEdit, form: { ...loanEdit.form, exception: e.target.value } }) }}>
                      {LOAN_EXCEPTIONS.map((x) => (
                        <option key={x} value={x}>
                          {t(`exception_${x}`)}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-terms">{t('field_terms')}</Label>
                <Input {...field(loanEdit.form, (form) => { setPreview(null); setLoanEdit({ ...loanEdit, form }) }, 'terms', 'edit-terms')} />
              </div>
              {previewBlock()}
            </div>
          ) : null}
          {footer(() => setLoanEdit(null), () => void submitEdit(true), () => void submitEdit(false), t('save'))}
        </DialogContent>
      </Dialog>

      {/* The year's interest. */}
      <Dialog open={Boolean(interest)} onOpenChange={(open) => (open ? null : setInterest(null))}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{interest ? t('interest_title', { name: interest.loan.party.name }) : ''}</DialogTitle>
          </DialogHeader>
          {interest ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="int-year">{t('year')}</Label>
                  <Input {...field(interest.form, (form) => { setPreview(null); setInterest({ ...interest, form }) }, 'income_year', 'int-year')} inputMode="numeric" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="int-amount">{t('field_interest_amount')}</Label>
                  <Input {...field(interest.form, (form) => { setPreview(null); setInterest({ ...interest, form }) }, 'interest_amount', 'int-amount')} inputMode="decimal" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="int-tax">{t('field_tax_withheld')}</Label>
                  <Input {...field(interest.form, (form) => { setPreview(null); setInterest({ ...interest, form }) }, 'tax_withheld', 'int-tax')} inputMode="decimal" className="tabular-nums" />
                </div>
              </div>
              {previewBlock()}
            </div>
          ) : null}
          {footer(() => setInterest(null), () => void submitInterest(true), () => void submitInterest(false), t('save'))}
        </DialogContent>
      </Dialog>
    </div>
  )
}
