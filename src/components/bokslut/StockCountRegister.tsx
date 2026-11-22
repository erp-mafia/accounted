'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { PlusIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyNoFiscalYear, EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput, sumOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { fetchSigningAvailability } from '@/components/signing/signing-client'
import {
  STOCK_CATEGORIES,
  categoryTotals,
  parseStockPaste,
  stockRowValue,
  type StockCategory,
} from '@/lib/bokslut/stock-count/valuation'

type Status = 'draft' | 'signed' | 'booked'

interface CountSummary {
  id: string
  balance_date: string
  count_date: string
  status: Status
  signing_request_id: string | null
  row_count: number
  total_value: number
}

interface CountRow {
  position: number
  description: string
  category: StockCategory
  unit: string | null
  quantity: number
  unit_cost: number
  write_down_percent: number
  value: number
  article_id: string | null
}

interface CountView {
  id: string
  fiscal_period_id: string
  balance_date: string
  count_date: string
  roll_forward_note: string | null
  note: string | null
  status: Status
  signer_name: string | null
  signed_at: string | null
  signed_document_id: string | null
  signing_request_id: string | null
  journal_entry_id: string | null
  rows: CountRow[]
  totals: Array<{ category: StockCategory; cost: number; write_down: number; value: number }>
  total_value: number
}

interface Adjustment {
  category: StockCategory
  stock_account: string
  change_account: string
  counted: number
  ledger: number
  adjustment: number
}

interface FormRow {
  description: string
  category: StockCategory
  unit: string
  quantity: string
  unit_cost: string
  write_down_percent: string
  article_id: string | null
}

interface DraftForm {
  id: string | null
  count_date: string
  roll_forward_note: string
  note: string
  rows: FormRow[]
}

const EMPTY_ROW: FormRow = { description: '', category: 'goods_for_resale', unit: '', quantity: '', unit_cost: '', write_down_percent: '', article_id: null }

const toInput = (n: number): string => String(n).replace('.', ',')

/** A form row as the route takes it, or null when a number does not parse. */
function rowBody(row: FormRow) {
  const quantity = parseDecimalInput(row.quantity)
  const unitCost = parseAmountInput(row.unit_cost)
  const writeDown = row.write_down_percent.trim() === '' ? 0 : parseDecimalInput(row.write_down_percent)
  if (quantity === null || unitCost === null || writeDown === null || quantity < 0 || unitCost < 0 || writeDown < 0 || writeDown > 100) {
    return null
  }
  return {
    description: row.description.trim(),
    category: row.category,
    unit: row.unit.trim() || null,
    quantity,
    unit_cost: unitCost,
    write_down_percent: writeDown,
    article_id: row.article_id,
  }
}

/**
 * The year-end stock count (inventeringslista, LIV 1955:257): enter or paste
 * the counted items, print the list, sign it på heder och samvete (BankID
 * where signing is open, otherwise by hand with an optional scan), and book
 * the lagerförändring against the ledger. Behind BOLAGET_COMPANY_IDS.
 */
export function StockCountRegister() {
  const t = useTranslations('stock_count')
  // The top bar names Bokslut before the page (the menu row these pages sit under).
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  // The fiscal year is app-wide context (the sidebar); the count belongs to one started year.
  const { periodId, period, ready: scopeReady } = useFiscalScope({ allowAll: false, hideFuture: true })
  const [loading, setLoading] = useState(true)
  // A failed load says so in the page with "Försök igen" (Stil v3 states), never a toast.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [counts, setCounts] = useState<CountSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [count, setCount] = useState<CountView | null>(null)
  const [adjustments, setAdjustments] = useState<Adjustment[] | null>(null)
  const [form, setForm] = useState<DraftForm | null>(null)
  const [paste, setPaste] = useState('')
  const [saving, setSaving] = useState(false)
  const [bankIdAvailable, setBankIdAvailable] = useState(false)
  const [signOpen, setSignOpen] = useState(false)
  // Another year closes any open count form (adjusting state during render).
  const [shownPeriodId, setShownPeriodId] = useState(periodId)
  if (periodId !== shownPeriodId) {
    setShownPeriodId(periodId)
    setForm(null)
    setSelectedId(null)
  }
  const [signMode, setSignMode] = useState<'bankid' | 'manual'>('manual')
  const [signerName, setSignerName] = useState('')
  const [signerEmail, setSignerEmail] = useState('')
  const [signedOn, setSignedOn] = useState(todayIsoStockholm())
  const [signedCopy, setSignedCopy] = useState<File | null>(null)
  const [signingUrl, setSigningUrl] = useState<string | null>(null)
  const [confirmBook, setConfirmBook] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const fail = useCallback(
    (title: string, body: unknown): void => {
      toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' })
    },
    [locale, toast],
  )

  useEffect(() => {
    void fetchSigningAvailability()
      .then((a) => {
        setBankIdAvailable(a.available)
        if (a.available) setSignMode('bankid')
      })
      .catch(() => setBankIdAvailable(false))
  }, [])

  const loadCounts = useCallback(async () => {
    // No started year: nothing to load (the page says so), not a skeleton forever.
    if (!periodId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/bookkeeping/inventory-counts?fiscal_period_id=${periodId}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadError(getErrorMessage(body, { locale, fallback: t('load_failed') }))
        return
      }
      const list = (body.data?.counts ?? []) as CountSummary[]
      setCounts(list)
      setSelectedId((current) => (current && list.some((c) => c.id === current) ? current : (list[0]?.id ?? null)))
      setLoadError(null)
    } catch {
      setLoadError(t('load_failed'))
    } finally {
      setLoading(false)
    }
  }, [periodId, locale, t])

  useEffect(() => {
    void loadCounts()
  }, [loadCounts])

  const loadCount = useCallback(async () => {
    if (!selectedId) {
      setCount(null)
      setAdjustments(null)
      return
    }
    try {
      const res = await fetch(`/api/bookkeeping/inventory-counts/${selectedId}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadError(getErrorMessage(body, { locale, fallback: t('load_failed') }))
        return
      }
      setCount(body.data?.count ?? null)
      setAdjustments(body.data?.booking?.adjustments ?? null)
      setLoadError(null)
    } catch {
      setLoadError(t('load_failed'))
    }
  }, [selectedId, locale, t])

  useEffect(() => {
    void loadCount()
  }, [loadCount])

  const reload = useCallback(async () => {
    await loadCounts()
    await loadCount()
  }, [loadCounts, loadCount])

  function startNew() {
    if (!period) return
    setForm({ id: null, count_date: period.period_end, roll_forward_note: '', note: '', rows: [{ ...EMPTY_ROW }] })
    setPaste('')
  }

  function startEdit(view: CountView) {
    setForm({
      id: view.id,
      count_date: view.count_date,
      roll_forward_note: view.roll_forward_note ?? '',
      note: view.note ?? '',
      rows: view.rows.map((r) => ({
        description: r.description,
        category: r.category,
        unit: r.unit ?? '',
        quantity: toInput(r.quantity),
        unit_cost: toInput(r.unit_cost),
        write_down_percent: r.write_down_percent ? toInput(r.write_down_percent) : '',
        article_id: r.article_id,
      })),
    })
    setPaste('')
  }

  const formRows = useMemo(() => (form ? form.rows.map(rowBody) : []), [form])
  const formTotals = useMemo(
    () => categoryTotals(formRows.flatMap((r) => (r ? [r] : []))),
    [formRows],
  )

  function setRow(index: number, patch: Partial<FormRow>) {
    setForm((f) => (f ? { ...f, rows: f.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) } : f))
  }

  function applyPaste() {
    const parsed = parseStockPaste(paste)
    if (parsed.rejected.length > 0) {
      toast({ title: t('paste_rejected', { count: parsed.rejected.length, lines: parsed.rejected.join(', ') }), variant: 'destructive' })
    }
    if (parsed.rows.length === 0) return
    setForm((f) => {
      if (!f) return f
      const kept = f.rows.filter((r) => r.description.trim() || r.quantity.trim() || r.unit_cost.trim())
      const added = parsed.rows.map((r) => ({
        description: r.description,
        category: r.category,
        unit: r.unit ?? '',
        quantity: toInput(r.quantity),
        unit_cost: toInput(r.unit_cost),
        write_down_percent: r.write_down_percent ? toInput(r.write_down_percent) : '',
        article_id: null,
      }))
      return { ...f, rows: [...kept, ...added] }
    })
    setPaste('')
  }

  async function saveForm() {
    if (!form || !periodId) return
    const filled = form.rows.filter((r) => r.description.trim() || r.quantity.trim() || r.unit_cost.trim())
    const rows = filled.map(rowBody)
    if (rows.some((r) => r === null || !r.description)) {
      toast({ title: t('invalid_numbers'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(form.id ? `/api/bookkeeping/inventory-counts/${form.id}` : '/api/bookkeeping/inventory-counts', {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: periodId,
          count_date: form.count_date,
          roll_forward_note: form.roll_forward_note.trim() || null,
          note: form.note.trim() || null,
          rows,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('save_failed'), body)
      toast({ title: t('saved') })
      setForm(null)
      setSelectedId(body.data?.id ?? null)
      await reload()
    } finally {
      setSaving(false)
    }
  }

  async function deleteDraft() {
    if (!count) return
    const res = await fetch(`/api/bookkeeping/inventory-counts/${count.id}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('delete_failed'), body)
    toast({ title: t('deleted') })
    setSelectedId(null)
    await reload()
  }

  async function sign() {
    if (!count || !signerName.trim()) return
    setSaving(true)
    try {
      if (signMode === 'bankid') {
        const res = await fetch(`/api/bookkeeping/inventory-counts/${count.id}/bankid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signer_name: signerName.trim(), email: signerEmail.trim() || null }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return fail(t('sign_failed'), body)
        const url = (body.data?.signers?.[0]?.url as string | null | undefined) ?? null
        setSignOpen(false)
        if (url) {
          setSigningUrl(url)
          window.location.assign(url)
          return
        }
        toast({ title: t('bankid_started') })
      } else {
        const data = new FormData()
        data.set('signer_name', signerName.trim())
        data.set('signed_on', signedOn)
        if (signedCopy) data.set('file', signedCopy)
        const res = await fetch(`/api/bookkeeping/inventory-counts/${count.id}/sign`, { method: 'POST', body: data })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return fail(t('sign_failed'), body)
        toast({ title: t('sign_done') })
        setSignOpen(false)
      }
      await reload()
    } finally {
      setSaving(false)
    }
  }

  async function cancelSigning() {
    if (!count?.signing_request_id) return
    const res = await fetch(`/api/signing-requests/${count.signing_request_id}/cancel`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('sign_failed'), body)
    toast({ title: t('bankid_cancelled') })
    setSigningUrl(null)
    await reload()
  }

  async function book() {
    if (!count) return
    const res = await fetch(`/api/bookkeeping/inventory-counts/${count.id}/book`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return fail(t('book_failed'), body)
    toast({
      title: body.data?.journal_entry_id
        ? t('book_done', { voucher: formatVoucher({ voucher_series: body.data.voucher_series, voucher_number: body.data.voucher_number }) })
        : t('book_nothing'),
    })
    await reload()
  }

  const categoryLabel = (c: StockCategory) => t(`category_${c}`)
  const pendingSigning = count?.status === 'draft' && Boolean(count.signing_request_id)
  const statusLabel = (c: { status: Status; signing_request_id: string | null }) =>
    c.status === 'draft' && c.signing_request_id ? t('status_signing') : t(`status_${c.status}`)

  // Without a started year the page shows the way to one, not a grey button.
  const headerAction = !canWrite || form || !period ? null : count?.status === 'signed' ? (
    <Button size="toolbar" onClick={() => setConfirmBook(true)}>{t('book')}</Button>
  ) : count?.status === 'draft' && !pendingSigning ? (
    <Button size="toolbar" onClick={() => setSignOpen(true)} disabled={count.rows.length === 0}>{t('sign')}</Button>
  ) : (
    <Button size="toolbar" variant="outline" onClick={startNew}><PlusIcon className="h-4 w-4" aria-hidden />{t('new')}</Button>
  )

  return (
    <div className="space-y-8">
      <PageHeader
        parent={{ label: tNav('v2_closing'), href: '/bookkeeping/year-end' }}
        title={t('title')}
        help={<HelpPopover>{t('help')}</HelpPopover>}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {headerAction}
          </div>
        }
      />

      {form ? (
        <section className="space-y-6">
          {/* The count's own fields are a form column (760px); the rows table below fills the panel. */}
          <div className="grid max-w-[760px] gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="stock-balance-date">{t('field_balance_date')}</Label>
              <Input id="stock-balance-date" value={period?.period_end ?? ''} disabled className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="stock-count-date">{t('field_count_date')}</Label>
              <Input
                id="stock-count-date"
                type="date"
                value={form.count_date}
                onChange={(e) => setForm((f) => (f ? { ...f, count_date: e.target.value } : f))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="stock-note">{t('field_note')}</Label>
              <Input
                id="stock-note"
                value={form.note}
                maxLength={2000}
                onChange={(e) => setForm((f) => (f ? { ...f, note: e.target.value } : f))}
              />
            </div>
          </div>
          {period && form.count_date !== period.period_end && (
            <div className="space-y-1">
              <Label htmlFor="stock-roll-forward">{t('field_roll_forward')}</Label>
              <p className="text-xs text-muted-foreground">{t('roll_forward_hint')}</p>
              <Textarea
                id="stock-roll-forward"
                value={form.roll_forward_note}
                maxLength={4000}
                rows={3}
                onChange={(e) => setForm((f) => (f ? { ...f, roll_forward_note: e.target.value } : f))}
              />
            </div>
          )}

          <div className="-mx-2 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_description')}</th>
                  <th className={TH_CLASS}>{t('col_category')}</th>
                  <th className={TH_CLASS}>{t('col_unit')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_quantity')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_unit_cost')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_write_down')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_value')}</th>
                  <th className={TH_CLASS} />
                </tr>
              </thead>
              <tbody>
                {form.rows.map((row, i) => {
                  const parsed = formRows[i]
                  return (
                    <tr key={i}>
                      <td className={TD_CLASS}>
                        <Input aria-label={t('col_description')} value={row.description} maxLength={300} onChange={(e) => setRow(i, { description: e.target.value })} />
                      </td>
                      <td className={TD_CLASS}>
                        <SettingsSelect aria-label={t('col_category')} value={row.category} onChange={(e) => setRow(i, { category: e.target.value as StockCategory })}>
                          {STOCK_CATEGORIES.map((c) => (
                            <option key={c} value={c}>{categoryLabel(c)}</option>
                          ))}
                        </SettingsSelect>
                      </td>
                      <td className={TD_CLASS}>
                        <Input aria-label={t('col_unit')} value={row.unit} maxLength={20} className="w-20" onChange={(e) => setRow(i, { unit: e.target.value })} />
                      </td>
                      <td className={TD_CLASS}>
                        <Input aria-label={t('col_quantity')} value={row.quantity} inputMode="decimal" className="w-24 text-right tabular-nums" onChange={(e) => setRow(i, { quantity: e.target.value })} />
                      </td>
                      <td className={TD_CLASS}>
                        <Input aria-label={t('col_unit_cost')} value={row.unit_cost} inputMode="decimal" className="w-28 text-right tabular-nums" onChange={(e) => setRow(i, { unit_cost: e.target.value })} />
                      </td>
                      <td className={TD_CLASS}>
                        <Input aria-label={t('col_write_down')} value={row.write_down_percent} inputMode="decimal" className="w-20 text-right tabular-nums" onChange={(e) => setRow(i, { write_down_percent: e.target.value })} />
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{parsed ? formatRowAmount(stockRowValue(parsed)) : ''}</td>
                      <td className={TD_CLASS}>
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() => setForm((f) => (f ? { ...f, rows: f.rows.filter((_, j) => j !== i) } : f))}
                        >
                          {t('remove_row')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={QUIET_LINK_CLASS}
            onClick={() => setForm((f) => (f ? { ...f, rows: [...f.rows, { ...EMPTY_ROW }] } : f))}
          >
            {t('add_row')}
          </button>

          <div className="space-y-1">
            <Label htmlFor="stock-paste">{t('paste_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('paste_hint')}</p>
            <Textarea id="stock-paste" value={paste} rows={4} onChange={(e) => setPaste(e.target.value)} className="font-mono text-xs" />
            <Button variant="outline" onClick={applyPaste} disabled={!paste.trim()}>
              {t('paste_apply')}
            </Button>
          </div>

          <TotalsTable totals={formTotals} label={categoryLabel} t={t} />

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={saveForm} loading={saving}>{t('save')}</Button>
          </div>
        </section>
      ) : scopeReady && !periodId ? (
        <EmptyNoFiscalYear />
      ) : loading || !periodId ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </LateReveal>
      ) : loadError && !count ? (
        <LoadError
          title={t('load_failed')}
          description={loadError === t('load_failed') ? undefined : loadError}
          onRetry={() => void reload()}
        />
      ) : !count ? (
        <EmptyState
          title={t('empty_title')}
          description={t('empty_description')}
          {...(canWrite && period ? { actionLabel: t('new'), onAction: startNew } : {})}
        />
      ) : (
        <section className="space-y-6">
          {loadError ? (
            <AttnLine action={{ label: tCommon('retry'), onClick: () => void reload() }}>
              {tCommon('refresh_failed')}
            </AttnLine>
          ) : pendingSigning && (
            <AttnLine
              action={
                signingUrl
                  ? { label: t('bankid_open'), href: signingUrl }
                  : canWrite
                    ? { label: t('bankid_cancel'), onClick: () => void cancelSigning() }
                    : undefined
              }
            >
              {t('bankid_pending')}
            </AttnLine>
          )}

          <dl className="grid gap-4 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">{t('field_balance_date')}</dt>
              <dd className="tabular-nums">{formatDate(count.balance_date)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('field_count_date')}</dt>
              <dd className="tabular-nums">{formatDate(count.count_date)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('col_status')}</dt>
              <dd>
                {count.status === 'draft'
                  ? statusLabel(count)
                  : t('signed_by', { name: count.signer_name ?? '', date: count.signed_at ? todayIsoStockholm(new Date(count.signed_at)) : '' })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('total')}</dt>
              <dd className="tabular-nums">{formatCurrency(count.total_value)}</dd>
            </div>
          </dl>
          {count.roll_forward_note && (
            <div className="text-[13px]">
              <div className="text-muted-foreground">{t('field_roll_forward')}</div>
              <div data-ph-mask="">{count.roll_forward_note}</div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 text-[13px]">
            <a className={QUIET_LINK_CLASS} href={`/api/bookkeeping/inventory-counts/${count.id}/pdf`}>{t('pdf')}</a>
            {count.signed_document_id && (
              <a className={QUIET_LINK_CLASS} href={`/api/documents/${count.signed_document_id}/inline`} target="_blank" rel="noreferrer">
                {t('signed_copy_open')}
              </a>
            )}
            {count.journal_entry_id && (
              <a className={QUIET_LINK_CLASS} href={`/bookkeeping/${count.journal_entry_id}`}>{t('open_voucher')}</a>
            )}
            {canWrite && count.status === 'draft' && !pendingSigning && (
              <>
                <button type="button" className={QUIET_LINK_CLASS} onClick={() => startEdit(count)}>{t('edit')}</button>
                <button type="button" className={QUIET_LINK_CLASS} onClick={() => setConfirmDelete(true)}>{t('delete')}</button>
              </>
            )}
          </div>

          <div className="-mx-2 overflow-x-auto">
            <table className="stagger-enter w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_description')}</th>
                  <th className={TH_CLASS}>{t('col_category')}</th>
                  <th className={TH_CLASS}>{t('col_unit')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_quantity')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_unit_cost')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_write_down')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_value')}</th>
                </tr>
              </thead>
              <tbody>
                {count.rows.map((row) => (
                  <tr key={row.position} className="hover:bg-secondary/35">
                    <td className={TD_CLASS} data-ph-mask="">{row.description}</td>
                    <td className={TD_CLASS}>{categoryLabel(row.category)}</td>
                    <td className={TD_CLASS}>{row.unit ?? ''}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.quantity}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.unit_cost)}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.write_down_percent || ''}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <TotalsTable totals={count.totals} label={categoryLabel} t={t} />

          {adjustments && adjustments.length > 0 && (
            // overflow-x-auto on a wrapper wide enough for the 8px bleed, so the
            // bleed is not clipped while a narrow screen scrolls the table.
            <div className="-mx-2 space-y-2 overflow-x-auto px-2">
              <h2 className="text-sm font-medium text-muted-foreground">{t('booking_heading')}</h2>
              <table className="-mx-2 w-[calc(100%+1rem)] border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_category')}</th>
                    <th className={TH_CLASS}>{t('col_account')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_ledger')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_counted')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_adjustment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((a) => (
                    <tr key={a.category}>
                      <td className={TD_CLASS}>{categoryLabel(a.category)}</td>
                      <td className={cn(TD_CLASS, 'font-mono')}>{a.stock_account} / {a.change_account}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(a.ledger)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(a.counted)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(a.adjustment)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {counts.length > 1 && (
            <div className="-mx-2 space-y-2 overflow-x-auto px-2">
              <h2 className="text-sm font-medium text-muted-foreground">{t('earlier_counts')}</h2>
              <table className="-mx-2 w-[calc(100%+1rem)] border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_count_date')}</th>
                    <th className={TH_CLASS}>{t('col_status')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_rows')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map((c) => (
                    <tr
                      key={c.id}
                      className={cn('cursor-pointer hover:bg-secondary/35', c.id === count.id && 'bg-secondary/35')}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <td className={cn(TD_CLASS, 'date-figures')}>{formatDate(c.count_date)}</td>
                      <td className={TD_CLASS}>{statusLabel(c)}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{c.row_count}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(c.total_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('sign_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm">{t('sign_statement')}</p>
            {bankIdAvailable && (
              <SegmentedControl
                value={signMode}
                onChange={setSignMode}
                options={[
                  { value: 'bankid', label: t('sign_bankid') },
                  { value: 'manual', label: t('sign_manual') },
                ]}
                aria-label={t('sign')}
              />
            )}
            <div className="space-y-1">
              <Label htmlFor="stock-signer-name">{t('signer_name')}</Label>
              <Input id="stock-signer-name" value={signerName} maxLength={200} onChange={(e) => setSignerName(e.target.value)} />
            </div>
            {signMode === 'bankid' ? (
              <div className="space-y-1">
                <Label htmlFor="stock-signer-email">{t('signer_email')}</Label>
                <Input id="stock-signer-email" type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} />
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="stock-signed-on">{t('signed_on')}</Label>
                  <Input id="stock-signed-on" type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="stock-signed-copy">{t('signed_copy')}</Label>
                  <Input
                    id="stock-signed-copy"
                    type="file"
                    accept="application/pdf,image/*"
                    onChange={(e) => setSignedCopy(e.target.files?.[0] ?? null)}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignOpen(false)} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={sign} loading={saving} disabled={!signerName.trim()}>
              {signMode === 'bankid' ? t('sign_bankid') : t('sign')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmBook}
        onOpenChange={setConfirmBook}
        title={t('book_confirm_title')}
        description={t('book_confirm_description', { date: count?.balance_date ?? '' })}
        confirmLabel={t('book')}
        onConfirm={book}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_description')}
        confirmLabel={t('delete')}
        destructive
        onConfirm={deleteDraft}
      />
    </div>
  )
}

function TotalsTable({
  totals,
  label,
  t,
}: {
  totals: Array<{ category: StockCategory; cost: number; write_down: number; value: number }>
  label: (c: StockCategory) => string
  t: ReturnType<typeof useTranslations>
}) {
  if (totals.length === 0) return null
  const total = sumOre(totals.map((row) => row.value))
  return (
    <div className="-mx-2 space-y-2 overflow-x-auto px-2">
      <h2 className="text-sm font-medium text-muted-foreground">{t('totals_heading')}</h2>
      <table className="-mx-2 w-[calc(100%+1rem)] border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('col_category')}</th>
            <th className={cn(TH_CLASS, 'text-right')}>{t('col_cost')}</th>
            <th className={cn(TH_CLASS, 'text-right')}>{t('col_write_down_amount')}</th>
            <th className={cn(TH_CLASS, 'text-right')}>{t('col_value')}</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((row) => (
            <tr key={row.category}>
              <td className={TD_CLASS}>{label(row.category)}</td>
              <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.cost)}</td>
              <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.write_down)}</td>
              <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatRowAmount(row.value)}</td>
            </tr>
          ))}
          <tr>
            <td className={cn(TD_CLASS, 'font-medium')}>{t('total')}</td>
            <td className={TD_CLASS} />
            <td className={TD_CLASS} />
            <td className={cn(TD_CLASS, 'text-right font-medium tabular-nums')}>{formatCurrency(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
