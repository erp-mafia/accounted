'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BolagetHeader } from './BolagetHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { CAPITAL_CHANGE_KINDS, FONDEMISSION_SOURCE_ACCOUNTS, MINSKNING_PURPOSES } from '@/lib/bolaget/capital/types'
import { usePaymentBankLedger } from '@/lib/reference-data/hooks'
import type { CapitalView } from '@/lib/bolaget/capital/view'
import type { Ku31Status } from '@/lib/bolaget/capital/ku31'
import type { LedgerPayout } from '@/lib/bolaget/capital/dividends'
import { todayIsoStockholm } from '@/lib/dates/iso'

type FormState = Record<string, string>
type Preview = Record<string, unknown>

interface PageData extends CapitalView {
  dividend_years: number[]
  can_download_ku31: boolean
}

interface Person {
  party_id: string
  name: string
  kind: 'person' | 'company'
}

const NEW_PARTY = '__new'

function intOrNull(value: string): number | null {
  const n = Number.parseInt(value.replace(/\s/g, ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The new-dividend form as POST /api/bolaget/capital/dividends takes it. */
export function dividendBody(form: FormState): Record<string, unknown> {
  const amount = form.amount_mode === 'per_share' ? parseDecimalInput(form.amount) : parseAmountInput(form.amount)
  const body: Record<string, unknown> = {
    decided_on: form.decided_on,
    decided_by: form.decided_by,
    payment_date: form.payment_date || null,
    record_date_basis: form.record_date_basis,
    prudence_confirmed: form.prudence_confirmed === 'true',
  }
  if (form.amount_mode === 'per_share') body.amount_per_share = amount
  else body.total_amount = amount
  if (form.record_date_basis === 'other') body.record_date = form.record_date || null
  if (form.note.trim()) body.note = form.note.trim()
  return body
}

/**
 * Kapital och utdelning: the dividends from the stämma decision to the
 * payout with each holder's part, KU31 per inkomstår, the changes of
 * aktiekapital and the aktieägartillskott. Every booking is previewed
 * before it posts (design convention 10).
 */
export function CapitalEvents() {
  const t = useTranslations('bolaget_capital')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const paymentLedger = usePaymentBankLedger()

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<PageData | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [busy, setBusy] = useState(false)

  const [ku31Year, setKu31Year] = useState<number>(() => {
    const now = todayIsoStockholm()
    return now.slice(5, 7) === '01' ? Number(now.slice(0, 4)) - 1 : Number(now.slice(0, 4))
  })
  const [ku31, setKu31] = useState<Ku31Status | null>(null)
  const [ku31Form, setKu31Form] = useState<FormState>({ famansforetag: '', contact_name: '', contact_phone: '', contact_email: '' })

  const [dividendForm, setDividendForm] = useState<FormState | null>(null)
  const [split, setSplit] = useState<PageData['dividends'][number] | null>(null)
  const [action, setAction] = useState<{ kind: 'book' | 'pay'; dividend: PageData['dividends'][number]; form: FormState } | null>(null)
  const [contributionForm, setContributionForm] = useState<FormState | null>(null)
  const [changeForm, setChangeForm] = useState<FormState | null>(null)
  const [changeBook, setChangeBook] = useState<{ change: PageData['capital_changes'][number]; form: FormState } | null>(null)
  const [ledger, setLedger] = useState<{ payouts: LedgerPayout[]; form: FormState; rows: FormState[] } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)

  const fail = useCallback(
    (title: string, body: unknown) => toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' }),
    [locale, toast],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [capital, register] = await Promise.all([fetch('/api/bolaget/capital'), fetch('/api/bolaget/share-register')])
      const body = await capital.json().catch(() => ({}))
      if (!capital.ok) return fail(t('load_failed'), body)
      setData(body.data as PageData)
      const reg = await register.json().catch(() => ({}))
      if (register.ok) setPeople(((reg.data?.people ?? []) as Person[]).map((p) => ({ party_id: p.party_id, name: p.name, kind: p.kind })))
    } finally {
      setLoading(false)
    }
  }, [fail, t])

  const loadKu31 = useCallback(async () => {
    const res = await fetch(`/api/bolaget/capital/ku31/${ku31Year}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('load_failed'), body)
    const status = body.data as Ku31Status
    setKu31(status)
    setKu31Form({
      famansforetag: status.famansforetag === null ? '' : String(status.famansforetag),
      contact_name: status.contact.name ?? '',
      contact_phone: status.contact.phone ?? '',
      contact_email: status.contact.email ?? '',
    })
  }, [fail, ku31Year, t])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadKu31()
  }, [loadKu31])

  const years = useMemo(() => {
    const set = new Set([...(data?.dividend_years ?? []), ku31Year])
    return [...set].sort((a, b) => b - a)
  }, [data, ku31Year])

  async function post(url: string, body: unknown, dryRun: boolean, failTitle: string): Promise<{ ok: boolean; data?: Preview; warnings?: Array<{ message_sv: string; message_en: string }> }> {
    setBusy(true)
    try {
      const res = await fetch(`${url}${dryRun ? '?dry_run=true' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        fail(failTitle, json)
        return { ok: false }
      }
      return { ok: true, data: json.data as Preview, warnings: json.warnings }
    } finally {
      setBusy(false)
    }
  }

  function done(title: string, warnings?: Array<{ message_sv: string; message_en: string }>) {
    const note = (warnings ?? []).map((w) => (locale === 'en' ? w.message_en : w.message_sv)).join(' ')
    toast({ title, ...(note ? { description: note } : {}) })
    setPreview(null)
    void load()
    void loadKu31()
  }

  // ── Dividends ──────────────────────────────────────────────────────

  async function submitDividend(dryRun: boolean) {
    if (!dividendForm) return
    const result = await post('/api/bolaget/capital/dividends', dividendBody(dividendForm), dryRun, t('dividend_failed'))
    if (!result.ok) return
    if (dryRun) return setPreview(result.data ?? null)
    setDividendForm(null)
    done(t('dividend_saved'), result.warnings)
  }

  async function submitAction(dryRun: boolean) {
    if (!action) return
    const url = `/api/bolaget/capital/dividends/${action.dividend.dividend_id}/${action.kind}`
    const body =
      action.kind === 'book'
        ? { prudence_confirmed: action.form.prudence_confirmed === 'true' || null }
        : { paid_on: action.form.paid_on || null, bank_account: action.form.bank_account || null }
    const result = await post(url, body, dryRun, action.kind === 'book' ? t('book_failed') : t('pay_failed'))
    if (!result.ok) return
    if (dryRun) return setPreview(result.data ?? null)
    setAction(null)
    done(action.kind === 'book' ? t('book_saved') : t('pay_saved'), result.warnings)
  }

  async function cancelDividend(dividendId: string) {
    const result = await post(`/api/bolaget/capital/dividends/${dividendId}/cancel`, {}, false, t('cancel_failed'))
    if (result.ok) done(t('cancel_saved'))
  }

  // ── KU31 ───────────────────────────────────────────────────────────

  async function saveKu31() {
    setBusy(true)
    try {
      const res = await fetch(`/api/bolaget/capital/ku31/${ku31Year}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          famansforetag: ku31Form.famansforetag === '' ? null : ku31Form.famansforetag === 'true',
          contact_name: ku31Form.contact_name,
          contact_phone: ku31Form.contact_phone,
          contact_email: ku31Form.contact_email,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('ku31_save_failed'), body)
      setKu31(body.data as Ku31Status)
      toast({ title: t('ku31_saved') })
    } finally {
      setBusy(false)
    }
  }

  // ── Contributions and capital changes ──────────────────────────────

  function partyFields(form: FormState, prefix: string): Record<string, unknown> {
    const chosen = form[`${prefix}party`]
    if (chosen && chosen !== NEW_PARTY) return { party_id: chosen }
    return { name: form[`${prefix}name`]?.trim() || null, kind: form[`${prefix}party_kind`] || 'person' }
  }

  async function submitContribution(dryRun: boolean) {
    if (!contributionForm) return
    const holder = partyFields(contributionForm, '')
    const body = {
      kind: contributionForm.kind,
      ...(contributionForm.kind === 'repayment'
        ? { repays_contribution_id: contributionForm.repays_contribution_id || null, decided_on: contributionForm.decided_on || null, decided_by: contributionForm.decided_by || null }
        : { party_id: holder.party_id ?? null, holder_name: holder.name ?? null, holder_kind: holder.kind ?? null, conditional: contributionForm.conditional === 'true' }),
      promised_on: contributionForm.promised_on,
      amount: parseAmountInput(contributionForm.amount),
      counter_account: contributionForm.counter_account || null,
    }
    const result = await post('/api/bolaget/capital/contributions', body, dryRun, t('contribution_failed'))
    if (!result.ok) return
    if (dryRun) return setPreview(result.data ?? null)
    setContributionForm(null)
    done(t('contribution_saved'), result.warnings)
  }

  async function submitChange(dryRun: boolean) {
    if (!changeForm) return
    const kind = changeForm.kind
    const body: Record<string, unknown> = {
      kind,
      decided_on: changeForm.decided_on,
      decided_by: changeForm.decided_by,
      share_count: intOrNull(changeForm.share_count) ?? 0,
    }
    const capital = parseAmountInput(changeForm.share_capital_amount)
    if (capital !== null) body.share_capital_amount = capital
    if (kind === 'nyemission') {
      body.price_per_share = parseDecimalInput(changeForm.price_per_share)
      const count = intOrNull(changeForm.allot_count)
      if (count) body.allotments = [{ ...partyFields(changeForm, 'allot_'), share_count: count }]
    }
    if (kind === 'fondemission') body.source_account = changeForm.source_account
    if (kind === 'minskning') body.purpose = changeForm.purpose
    const result = await post('/api/bolaget/capital/changes', body, dryRun, t('change_failed'))
    if (!result.ok) return
    if (dryRun) return setPreview(result.data ?? null)
    setChangeForm(null)
    done(t('change_saved'), result.warnings)
  }

  async function submitChangeBook(dryRun: boolean) {
    if (!changeBook) return
    const body = { step: changeBook.form.step, date: changeBook.form.date, bank_account: changeBook.form.bank_account || null }
    const result = await post(`/api/bolaget/capital/changes/${changeBook.change.capital_change_id}/book`, body, dryRun, t('change_book_failed'))
    if (!result.ok) return
    if (dryRun) return setPreview(result.data ?? null)
    setChangeBook(null)
    done(t('change_book_saved'))
  }

  // ── Who received (dividends booked before the aktiebok) ────────────

  async function openLedger(year: number) {
    const res = await fetch(`/api/bolaget/capital/dividends/ledger?year=${year}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('load_failed'), body)
    setPreview(null)
    setLedger({ payouts: body.data.payouts as LedgerPayout[], form: { year: String(year), payout: '', decided_on: '', decided_by: 'arsstamma' }, rows: [{ party: '', name: '', amount: '' }] })
  }

  async function submitLedger(dryRun: boolean) {
    if (!ledger) return
    const payout = ledger.payouts.find((p) => p.journal_entry_id === ledger.form.payout)
    const body = {
      decided_on: ledger.form.decided_on || payout?.entry_date,
      decided_by: ledger.form.decided_by,
      paid_on: payout?.entry_date,
      payout_entry_id: ledger.form.payout,
      recipients: ledger.rows.map((r) => ({ ...partyFields(r, ''), amount: parseAmountInput(r.amount) })),
    }
    const result = await post('/api/bolaget/capital/dividends/ledger', body, dryRun, t('ledger_failed'))
    if (!result.ok) return
    if (dryRun) return setPreview(result.data ?? null)
    setLedger(null)
    done(t('ledger_saved'))
  }

  // ── Rendering helpers ──────────────────────────────────────────────

  const field = <S extends FormState>(state: S, set: (s: S) => void, key: string) => ({
    id: `cap-${key}`,
    value: state[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ ...state, [key]: e.target.value }),
  })

  function partyPicker<S extends FormState>(state: S, set: (s: S) => void, prefix: string, label: string) {
    const chosen = state[`${prefix}party`] ?? ''
    return (
      <>
        <div className="space-y-1">
          <Label htmlFor={`cap-${prefix}party`}>{label}</Label>
          <SettingsSelect id={`cap-${prefix}party`} value={chosen || NEW_PARTY} onChange={(e) => set({ ...state, [`${prefix}party`]: e.target.value })}>
            <option value={NEW_PARTY}>{t('party_new')}</option>
            {people.map((p) => (
              <option key={p.party_id} value={p.party_id}>
                {p.name}
              </option>
            ))}
          </SettingsSelect>
        </div>
        {(!chosen || chosen === NEW_PARTY) && (
          <div className="space-y-1">
            <Label htmlFor={`cap-${prefix}name`}>{t('party_name')}</Label>
            <Input {...field(state, set, `${prefix}name`)} maxLength={200} data-ph-mask="" />
          </div>
        )}
      </>
    )
  }

  function previewBlock() {
    if (!preview) return null
    const lines = (preview.lines as Array<{ account_number: string; debit: number; credit: number }> | undefined) ?? []
    const holders = (preview.holders as Array<{ party_id: string; name: string; identity: string | null; share_count: number; amount: number }> | undefined) ?? []
    const warnings = (preview.warnings as string[] | undefined) ?? []
    return (
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('preview_heading')}</h3>
        {typeof preview.total_amount === 'number' && (
          <p className="text-[13px]">
            {t('preview_total')}: <span className="tabular-nums">{formatCurrency(preview.total_amount)}</span>
          </p>
        )}
        {holders.length > 0 && (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_holder')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {holders.map((h) => (
                <tr key={h.party_id}>
                  <td className={TD_CLASS} data-ph-mask="">
                    {h.name}
                    {h.identity ? <span className="ml-2 text-muted-foreground tabular-nums">{h.identity}</span> : null}
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.share_count.toLocaleString('sv-SE')}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(h.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {lines.length > 0 && (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_account')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_debit')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_credit')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.account_number}-${i}`}>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{l.account_number}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{l.debit ? formatCurrency(l.debit) : ''}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{l.credit ? formatCurrency(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {warnings.map((w) => (
          <AttnLine key={w}>{w}</AttnLine>
        ))}
      </div>
    )
  }

  function confirmFooter(onCancel: () => void, submit: (dryRun: boolean) => void, confirmLabel: string) {
    return (
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
        {preview ? (
          <Button onClick={() => submit(false)} loading={busy}>
            {confirmLabel}
          </Button>
        ) : (
          <Button onClick={() => submit(true)} loading={busy}>
            {t('preview_action')}
          </Button>
        )}
      </DialogFooter>
    )
  }

  const statusLabel = (status: string) => t(`status_${status}`)

  /** A KU31 blocker in the reader's language; the server's Swedish sentence for a code without a key. */
  function blockerText(b: Ku31Status['blockers'][number]): string {
    switch (b.code) {
      case 'KU31_SCHEMA_YEAR':
        return t('blocker_schema_year', { year: ku31Year })
      case 'KU31_NO_RECIPIENTS':
        return t('blocker_no_recipients', { year: ku31Year })
      case 'KU31_PERSONNUMMER_MISSING':
        return t('blocker_personnummer_missing', { name: ku31?.recipients.find((r) => r.party_id === b.party_id)?.name ?? '' })
      case 'KU31_FAMANS_UNANSWERED':
        return t('blocker_famans_unanswered')
      case 'KU31_CONTACT_MISSING':
        return t('blocker_contact_missing')
      case 'KU31_PAYER_ORG_NUMBER':
        return t('blocker_payer_org_number')
      default:
        return b.message_sv
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-8">
        <BolagetHeader title={t('title')} subtitle={t('subtitle')} help={t('help')} />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const dividends = data?.dividends ?? []
  const contributions = data?.contributions ?? []
  const changes = data?.capital_changes ?? []
  const villkorade = contributions.filter((c) => c.kind === 'contribution' && c.conditional && c.status === 'booked')

  return (
    <div className="space-y-8">
      <BolagetHeader
        title={t('title')}
        subtitle={t('subtitle')}
        help={t('help')}
        action={
          canWrite ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setPreview(null)
                  setDividendForm({ decided_on: todayIsoStockholm(), decided_by: 'arsstamma', amount_mode: 'per_share', amount: '', payment_date: '', record_date_basis: 'decision_date', record_date: '', prudence_confirmed: '', note: '' })
                }}
              >
                {t('new_dividend')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    {t('more_actions')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      setPreview(null)
                      setContributionForm({ kind: 'contribution', party: '', name: '', party_kind: 'person', promised_on: todayIsoStockholm(), amount: '', conditional: '', counter_account: paymentLedger, repays_contribution_id: '', decided_on: '', decided_by: 'arsstamma' })
                    }}
                  >
                    {t('new_contribution')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setPreview(null)
                      setChangeForm({ kind: 'nyemission', decided_on: todayIsoStockholm(), decided_by: 'extra_stamma', share_count: '', share_capital_amount: '', price_per_share: '', source_account: FONDEMISSION_SOURCE_ACCOUNTS[0], purpose: 'forlusttackning', allot_party: '', allot_name: '', allot_count: '' })
                    }}
                  >
                    {t('new_change')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void openLedger(ku31Year)}>{t('ledger_action')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : undefined
        }
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('dividends_heading')}</h2>
        {dividends.length === 0 ? (
          <EmptyState title={t('dividends_empty_title')} description={t('dividends_empty_body')} />
        ) : (
          <table className="w-full border-collapse text-[13px] stagger-enter">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_decided_on')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_per_share')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_total')}</th>
                <th className={TH_CLASS}>{t('col_payment_date')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={TH_CLASS} />
              </tr>
            </thead>
            <tbody>
              {dividends.map((d) => (
                <tr key={d.dividend_id} className="hover:bg-secondary/35">
                  <td className={cn(TD_CLASS, 'tabular-nums')}>
                    <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSplit(d)}>
                      {formatDate(d.decided_on)}
                    </button>
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{d.amount_per_share !== null ? formatCurrency(d.amount_per_share) : ''}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(d.total_amount)}</td>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(d.payment_date)}</td>
                  <td className={TD_CLASS}>
                    {d.status === 'paid' || d.status === 'cancelled' ? (
                      <span className="text-xs text-muted-foreground">{statusLabel(d.status)}</span>
                    ) : (
                      <Badge variant="outline">{statusLabel(d.status)}</Badge>
                    )}
                  </td>
                  <td className={cn(TD_CLASS, 'text-right')}>
                    {canWrite && d.status === 'decided' && (
                      <span className="flex justify-end gap-3">
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => { setPreview(null); setAction({ kind: 'book', dividend: d, form: { prudence_confirmed: d.prudence_confirmed ? 'true' : '' } }) }}>
                          {t('book_action')}
                        </button>
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => void cancelDividend(d.dividend_id)}>
                          {t('cancel_action')}
                        </button>
                      </span>
                    )}
                    {canWrite && d.status === 'booked' && (
                      <button type="button" className={QUIET_LINK_CLASS} onClick={() => { setPreview(null); setAction({ kind: 'pay', dividend: d, form: { paid_on: d.payment_date <= todayIsoStockholm() ? d.payment_date : todayIsoStockholm(), bank_account: paymentLedger } }) }}>
                        {t('pay_action')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('ku31_heading')}</h2>
          <SettingsSelect aria-label={t('ku31_year')} value={String(ku31Year)} onChange={(e) => setKu31Year(Number(e.target.value))} wrapperClassName="w-32">
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </SettingsSelect>
        </div>
        {ku31 && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">{t('ku31_deadline', { date: formatDate(ku31.deadline) })}</p>
            {ku31.recipients.length > 0 && (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_holder')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_reported')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {ku31.recipients.map((r) => (
                    <tr key={r.party_id} className="hover:bg-secondary/35">
                      <td className={TD_CLASS} data-ph-mask="">
                        {r.name}
                        {r.identity ? <span className="ml-2 text-muted-foreground tabular-nums">{r.identity}</span> : null}
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(r.amount)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{r.reported ? formatCurrency(r.reported_amount) : ''}</td>
                      <td className={TD_CLASS}>
                        {r.reason === 'legal_person' ? (
                          <span className="text-xs text-muted-foreground">{t('ku31_legal_person')}</span>
                        ) : r.reason === 'personnummer_missing' ? (
                          <Badge variant="warning">{t('ku31_personnummer_missing')}</Badge>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {ku31.blockers.length > 0 && <AttnLine>{ku31.blockers.map((b) => blockerText(b)).join(' ')}</AttnLine>}
            {ku31.unbooked_dividends > 0 && <p className="text-[12.5px] text-muted-foreground">{t('ku31_unbooked', { count: ku31.unbooked_dividends })}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="cap-famans">{t('ku31_famans_question')}</Label>
                <p className="text-[12.5px] text-muted-foreground">
                  {ku31.famansforetag_derivation.derived ? t('ku31_famans_suggest_yes', { pct: ku31.famansforetag_derivation.top_four_votes_pct }) : t('ku31_famans_suggest_no', { pct: ku31.famansforetag_derivation.top_four_votes_pct })}
                </p>
                <SettingsSelect id="cap-famans" value={ku31Form.famansforetag || 'unanswered'} onChange={(e) => setKu31Form({ ...ku31Form, famansforetag: e.target.value === 'unanswered' ? '' : e.target.value })} wrapperClassName="max-w-sm" disabled={!canWrite}>
                  <option value="unanswered">{t('ku31_famans_unanswered')}</option>
                  <option value="true">{t('ku31_famans_yes')}</option>
                  <option value="false">{t('ku31_famans_no')}</option>
                </SettingsSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-contact_name">{t('ku31_contact_name')}</Label>
                <Input {...field(ku31Form, setKu31Form, 'contact_name')} maxLength={50} disabled={!canWrite} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-contact_phone">{t('ku31_contact_phone')}</Label>
                <Input {...field(ku31Form, setKu31Form, 'contact_phone')} maxLength={20} disabled={!canWrite} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-contact_email">{t('ku31_contact_email')}</Label>
                <Input {...field(ku31Form, setKu31Form, 'contact_email')} type="email" maxLength={254} disabled={!canWrite} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canWrite && (
                <Button size="sm" variant="outline" onClick={saveKu31} loading={busy}>
                  {t('ku31_save')}
                </Button>
              )}
              {data?.can_download_ku31 && ku31.ready ? (
                <Button size="sm" asChild>
                  <a href={`/api/bolaget/capital/ku31/${ku31Year}/file`}>{t('ku31_download')}</a>
                </Button>
              ) : (
                <Button size="sm" disabled>
                  {t('ku31_download')}
                </Button>
              )}
              {!data?.can_download_ku31 && <span className="text-[12.5px] text-muted-foreground">{t('ku31_admin_only')}</span>}
            </div>
            <p className="text-[12.5px] text-muted-foreground">{t('ku31_how_to_file')}</p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('changes_heading')}</h2>
        {changes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('changes_empty')}</p>
        ) : (
          <table className="w-full border-collapse text-[13px] stagger-enter">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_kind')}</th>
                <th className={TH_CLASS}>{t('col_decided_on')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_share_capital')}</th>
                <th className={TH_CLASS}>{t('col_registered_on')}</th>
                <th className={TH_CLASS} />
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.capital_change_id} className="hover:bg-secondary/35">
                  <td className={TD_CLASS}>{t(`change_kind_${c.kind}`)}</td>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(c.decided_on)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{c.share_count.toLocaleString('sv-SE')}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(c.share_capital_amount)}</td>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{c.registered_on ? formatDate(c.registered_on) : <Badge variant="outline">{t('not_registered')}</Badge>}</td>
                  <td className={cn(TD_CLASS, 'text-right')}>
                    {canWrite && c.status === 'decided' && (
                      <span className="flex justify-end gap-3">
                        {c.kind === 'nyemission' && !c.payment_entry_id && (
                          <button type="button" className={QUIET_LINK_CLASS} onClick={() => { setPreview(null); setChangeBook({ change: c, form: { step: 'payment', date: todayIsoStockholm(), bank_account: paymentLedger } }) }}>
                            {t('change_pay_action')}
                          </button>
                        )}
                        {(c.kind !== 'nyemission' || c.payment_entry_id) && (
                          <button type="button" className={QUIET_LINK_CLASS} onClick={() => { setPreview(null); setChangeBook({ change: c, form: { step: 'registration', date: todayIsoStockholm(), bank_account: '' } }) }}>
                            {t('change_register_action')}
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('contributions_heading')}</h2>
        {contributions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('contributions_empty')}</p>
        ) : (
          <table className="w-full border-collapse text-[13px] stagger-enter">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_holder')}</th>
                <th className={TH_CLASS}>{t('col_date')}</th>
                <th className={TH_CLASS}>{t('col_kind')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {contributions.map((c) => (
                <tr key={c.shareholder_contribution_id} className="hover:bg-secondary/35">
                  <td className={TD_CLASS} data-ph-mask="">{c.name}</td>
                  <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(c.promised_on)}</td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')}>
                    {c.kind === 'repayment' ? t('contribution_repayment') : c.conditional ? t('contribution_conditional') : t('contribution_unconditional')}
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(c.kind === 'repayment' ? -c.amount : c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* The split of one dividend per holder. */}
      <Dialog open={Boolean(split)} onOpenChange={(open) => (open ? null : setSplit(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{split ? t('split_title', { date: formatDate(split.decided_on) }) : ''}</DialogTitle>
          </DialogHeader>
          {split && (
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">{t('split_basis', { date: formatDate(split.record_date) })}</p>
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_holder')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {split.holders.map((h) => (
                    <tr key={h.party_id}>
                      <td className={TD_CLASS} data-ph-mask="">
                        {h.name}
                        {h.identity ? <span className="ml-2 text-muted-foreground tabular-nums">{h.identity}</span> : null}
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.share_count.toLocaleString('sv-SE')}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(h.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* New dividend. */}
      <Dialog open={Boolean(dividendForm)} onOpenChange={(open) => (open ? null : setDividendForm(null))}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('new_dividend')}</DialogTitle>
          </DialogHeader>
          {dividendForm && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="cap-decided_on">{t('field_decided_on')}</Label>
                  <Input {...field(dividendForm, setDividendForm, 'decided_on')} type="date" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-decided_by">{t('field_decided_by')}</Label>
                  <SettingsSelect id="cap-decided_by" value={dividendForm.decided_by} onChange={(e) => setDividendForm({ ...dividendForm, decided_by: e.target.value })}>
                    <option value="arsstamma">{t('decided_by_arsstamma')}</option>
                    <option value="extra_stamma">{t('decided_by_extra_stamma')}</option>
                  </SettingsSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-amount_mode">{t('field_amount_mode')}</Label>
                  <SettingsSelect id="cap-amount_mode" value={dividendForm.amount_mode} onChange={(e) => setDividendForm({ ...dividendForm, amount_mode: e.target.value })}>
                    <option value="per_share">{t('amount_mode_per_share')}</option>
                    <option value="total">{t('amount_mode_total')}</option>
                  </SettingsSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-amount">{t('field_amount')}</Label>
                  <Input {...field(dividendForm, setDividendForm, 'amount')} inputMode="decimal" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-payment_date">{t('field_payment_date')}</Label>
                  <Input {...field(dividendForm, setDividendForm, 'payment_date')} type="date" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-record_date_basis">{t('field_record_date_basis')}</Label>
                  <SettingsSelect id="cap-record_date_basis" value={dividendForm.record_date_basis} onChange={(e) => setDividendForm({ ...dividendForm, record_date_basis: e.target.value })}>
                    <option value="decision_date">{t('record_basis_decision_date')}</option>
                    <option value="payment_date">{t('record_basis_payment_date')}</option>
                    <option value="other">{t('record_basis_other')}</option>
                  </SettingsSelect>
                </div>
                {dividendForm.record_date_basis === 'other' && (
                  <div className="space-y-1">
                    <Label htmlFor="cap-record_date">{t('field_record_date')}</Label>
                    <Input {...field(dividendForm, setDividendForm, 'record_date')} type="date" className="tabular-nums" />
                  </div>
                )}
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id="cap-prudence" checked={dividendForm.prudence_confirmed === 'true'} onCheckedChange={(v) => setDividendForm({ ...dividendForm, prudence_confirmed: v === true ? 'true' : '' })} />
                <Label htmlFor="cap-prudence" className="text-[13px] font-normal leading-5">
                  {t('field_prudence')}
                </Label>
              </div>
              {previewBlock()}
            </div>
          )}
          {confirmFooter(() => setDividendForm(null), (d) => void submitDividend(d), t('dividend_confirm'))}
        </DialogContent>
      </Dialog>

      {/* Book or pay a dividend. */}
      <Dialog open={Boolean(action)} onOpenChange={(open) => (open ? null : setAction(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{action?.kind === 'pay' ? t('pay_title') : t('book_title')}</DialogTitle>
          </DialogHeader>
          {action && (
            <div className="space-y-4">
              {action.kind === 'book' ? (
                <div className="flex items-start gap-2">
                  <Checkbox id="cap-book-prudence" checked={action.form.prudence_confirmed === 'true'} onCheckedChange={(v) => setAction({ ...action, form: { ...action.form, prudence_confirmed: v === true ? 'true' : '' } })} />
                  <Label htmlFor="cap-book-prudence" className="text-[13px] font-normal leading-5">
                    {t('field_prudence')}
                  </Label>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cap-paid_on">{t('field_paid_on')}</Label>
                    <Input id="cap-paid_on" type="date" className="tabular-nums" value={action.form.paid_on} onChange={(e) => setAction({ ...action, form: { ...action.form, paid_on: e.target.value } })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cap-bank_account">{t('field_bank_account')}</Label>
                    <Input id="cap-bank_account" inputMode="numeric" maxLength={4} className="tabular-nums" value={action.form.bank_account} onChange={(e) => setAction({ ...action, form: { ...action.form, bank_account: e.target.value } })} />
                  </div>
                </div>
              )}
              {previewBlock()}
            </div>
          )}
          {confirmFooter(() => setAction(null), (d) => void submitAction(d), action?.kind === 'pay' ? t('pay_confirm') : t('book_confirm'))}
        </DialogContent>
      </Dialog>

      {/* Aktieägartillskott. */}
      <Dialog open={Boolean(contributionForm)} onOpenChange={(open) => (open ? null : setContributionForm(null))}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('new_contribution')}</DialogTitle>
          </DialogHeader>
          {contributionForm && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="cap-contribution-kind">{t('field_contribution_kind')}</Label>
                  <SettingsSelect id="cap-contribution-kind" value={contributionForm.kind} onChange={(e) => setContributionForm({ ...contributionForm, kind: e.target.value })}>
                    <option value="contribution">{t('contribution_new')}</option>
                    <option value="repayment" disabled={villkorade.length === 0}>
                      {t('contribution_repayment')}
                    </option>
                  </SettingsSelect>
                </div>
                {contributionForm.kind === 'repayment' ? (
                  <>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="cap-repays">{t('field_repays')}</Label>
                      <SettingsSelect id="cap-repays" value={contributionForm.repays_contribution_id || 'none'} onChange={(e) => setContributionForm({ ...contributionForm, repays_contribution_id: e.target.value === 'none' ? '' : e.target.value })}>
                        <option value="none">{t('choose')}</option>
                        {villkorade.map((c) => (
                          <option key={c.shareholder_contribution_id} value={c.shareholder_contribution_id}>
                            {`${c.name}, ${formatDate(c.promised_on)}, ${formatCurrency(c.amount)}`}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="cap-decided_on">{t('field_repayment_decided_on')}</Label>
                      <Input {...field(contributionForm, setContributionForm, 'decided_on')} type="date" className="tabular-nums" />
                    </div>
                  </>
                ) : (
                  <>
                    {partyPicker(contributionForm, setContributionForm, '', t('field_holder'))}
                    <div className="flex items-start gap-2 sm:col-span-2">
                      <Checkbox id="cap-conditional" checked={contributionForm.conditional === 'true'} onCheckedChange={(v) => setContributionForm({ ...contributionForm, conditional: v === true ? 'true' : '' })} />
                      <Label htmlFor="cap-conditional" className="text-[13px] font-normal leading-5">
                        {t('field_conditional')}
                      </Label>
                    </div>
                  </>
                )}
                <div className="space-y-1">
                  <Label htmlFor="cap-promised_on">{contributionForm.kind === 'repayment' ? t('field_paid_on') : t('field_promised_on')}</Label>
                  <Input {...field(contributionForm, setContributionForm, 'promised_on')} type="date" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-amount">{t('field_amount')}</Label>
                  <Input {...field(contributionForm, setContributionForm, 'amount')} inputMode="decimal" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-counter_account">{t('field_counter_account')}</Label>
                  <Input {...field(contributionForm, setContributionForm, 'counter_account')} inputMode="numeric" maxLength={4} className="tabular-nums" />
                </div>
              </div>
              {previewBlock()}
            </div>
          )}
          {confirmFooter(() => setContributionForm(null), (d) => void submitContribution(d), t('contribution_confirm'))}
        </DialogContent>
      </Dialog>

      {/* Nyemission, fondemission, minskning. */}
      <Dialog open={Boolean(changeForm)} onOpenChange={(open) => (open ? null : setChangeForm(null))}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('new_change')}</DialogTitle>
          </DialogHeader>
          {changeForm && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="cap-change-kind">{t('field_change_kind')}</Label>
                  <SettingsSelect id="cap-change-kind" value={changeForm.kind} onChange={(e) => setChangeForm({ ...changeForm, kind: e.target.value })}>
                    {CAPITAL_CHANGE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`change_kind_${k}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-change-decided_by">{t('field_decided_by')}</Label>
                  <SettingsSelect id="cap-change-decided_by" value={changeForm.decided_by} onChange={(e) => setChangeForm({ ...changeForm, decided_by: e.target.value })}>
                    <option value="arsstamma">{t('decided_by_arsstamma')}</option>
                    <option value="extra_stamma">{t('decided_by_extra_stamma')}</option>
                    <option value="styrelse">{t('decided_by_styrelse')}</option>
                  </SettingsSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-decided_on">{t('field_decided_on')}</Label>
                  <Input {...field(changeForm, setChangeForm, 'decided_on')} type="date" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-share_count">{t('field_share_count')}</Label>
                  <Input {...field(changeForm, setChangeForm, 'share_count')} inputMode="numeric" className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-share_capital_amount">{t('field_share_capital_amount')}</Label>
                  <Input {...field(changeForm, setChangeForm, 'share_capital_amount')} inputMode="decimal" className="tabular-nums" placeholder={t('share_capital_placeholder')} />
                </div>
                {changeForm.kind === 'nyemission' && (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="cap-price_per_share">{t('field_price_per_share')}</Label>
                      <Input {...field(changeForm, setChangeForm, 'price_per_share')} inputMode="decimal" className="tabular-nums" />
                    </div>
                    {partyPicker(changeForm, setChangeForm, 'allot_', t('field_subscriber'))}
                    <div className="space-y-1">
                      <Label htmlFor="cap-allot_count">{t('field_allot_count')}</Label>
                      <Input {...field(changeForm, setChangeForm, 'allot_count')} inputMode="numeric" className="tabular-nums" />
                    </div>
                  </>
                )}
                {changeForm.kind === 'fondemission' && (
                  <div className="space-y-1">
                    <Label htmlFor="cap-source_account">{t('field_source_account')}</Label>
                    <SettingsSelect id="cap-source_account" value={changeForm.source_account} onChange={(e) => setChangeForm({ ...changeForm, source_account: e.target.value })}>
                      {FONDEMISSION_SOURCE_ACCOUNTS.map((a) => (
                        <option key={a} value={a}>
                          {t(`fund_${a}`)}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                )}
                {changeForm.kind === 'minskning' && (
                  <div className="space-y-1">
                    <Label htmlFor="cap-purpose">{t('field_purpose')}</Label>
                    <SettingsSelect id="cap-purpose" value={changeForm.purpose} onChange={(e) => setChangeForm({ ...changeForm, purpose: e.target.value })}>
                      {MINSKNING_PURPOSES.map((p) => (
                        <option key={p} value={p}>
                          {t(`purpose_${p}`)}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                )}
              </div>
              {previewBlock()}
            </div>
          )}
          {confirmFooter(() => setChangeForm(null), (d) => void submitChange(d), t('change_confirm'))}
        </DialogContent>
      </Dialog>

      {/* Book a capital change: payment or registration. */}
      <Dialog open={Boolean(changeBook)} onOpenChange={(open) => (open ? null : setChangeBook(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{changeBook?.form.step === 'payment' ? t('change_pay_action') : t('change_register_action')}</DialogTitle>
          </DialogHeader>
          {changeBook && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="cap-change-date">{changeBook.form.step === 'payment' ? t('field_paid_on') : t('field_registered_on')}</Label>
                  <Input id="cap-change-date" type="date" className="tabular-nums" value={changeBook.form.date} onChange={(e) => setChangeBook({ ...changeBook, form: { ...changeBook.form, date: e.target.value } })} />
                </div>
                {changeBook.form.step === 'payment' && (
                  <div className="space-y-1">
                    <Label htmlFor="cap-change-bank">{t('field_bank_account')}</Label>
                    <Input id="cap-change-bank" inputMode="numeric" maxLength={4} className="tabular-nums" value={changeBook.form.bank_account} onChange={(e) => setChangeBook({ ...changeBook, form: { ...changeBook.form, bank_account: e.target.value } })} />
                  </div>
                )}
              </div>
              {previewBlock()}
            </div>
          )}
          {confirmFooter(() => setChangeBook(null), (d) => void submitChangeBook(d), t('book_confirm'))}
        </DialogContent>
      </Dialog>

      {/* Who received a dividend already in the ledger. */}
      <Dialog open={Boolean(ledger)} onOpenChange={(open) => (open ? null : setLedger(null))}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('ledger_title')}</DialogTitle>
          </DialogHeader>
          {ledger && (
            <div className="space-y-4">
              <p className="text-[13px] text-muted-foreground">{t('ledger_intro', { year: ledger.form.year })}</p>
              {ledger.payouts.length === 0 ? (
                <p className="text-[13px]">{t('ledger_none')}</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="cap-ledger-payout">{t('field_payout')}</Label>
                    <SettingsSelect id="cap-ledger-payout" value={ledger.form.payout || 'none'} onChange={(e) => setLedger({ ...ledger, form: { ...ledger.form, payout: e.target.value === 'none' ? '' : e.target.value } })}>
                      <option value="none">{t('choose')}</option>
                      {ledger.payouts.map((p) => (
                        <option key={p.journal_entry_id} value={p.journal_entry_id}>
                          {`${p.voucher} ${formatDate(p.entry_date)} ${formatCurrency(p.amount)}`}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cap-ledger-decided_on">{t('field_decided_on')}</Label>
                    <Input id="cap-ledger-decided_on" type="date" className="tabular-nums" value={ledger.form.decided_on} onChange={(e) => setLedger({ ...ledger, form: { ...ledger.form, decided_on: e.target.value } })} />
                  </div>
                  {ledger.rows.map((row, i) => (
                    <div key={i} className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
                      {partyPicker(row, (next) => setLedger({ ...ledger, rows: ledger.rows.map((r, j) => (j === i ? next : r)) }), '', t('field_recipient'))}
                      <div className="space-y-1">
                        <Label htmlFor={`cap-ledger-amount-${i}`}>{t('field_amount')}</Label>
                        <Input
                          id={`cap-ledger-amount-${i}`}
                          inputMode="decimal"
                          className="tabular-nums"
                          value={row.amount ?? ''}
                          onChange={(e) => setLedger({ ...ledger, rows: ledger.rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)) })}
                        />
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={cn(QUIET_LINK_CLASS, 'justify-self-start')}
                    onClick={() => setLedger({ ...ledger, rows: [...ledger.rows, { party: '', name: '', amount: '' }] })}
                  >
                    {t('ledger_add_recipient')}
                  </button>
                </div>
              )}
              <p className="text-[12.5px] text-muted-foreground">{t('ledger_personnummer_hint')}</p>
              {previewBlock()}
            </div>
          )}
          {confirmFooter(() => setLedger(null), (d) => void submitLedger(d), t('ledger_confirm'))}
        </DialogContent>
      </Dialog>
    </div>
  )
}
