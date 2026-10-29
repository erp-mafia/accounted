'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatAmountInput, parseAmountInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { TaxAdjustmentLossRegister } from '@/lib/bokslut/types'
import type { LossCarryforwardSource } from '@/lib/bokslut/loss-carryforward/schemas'
import type { LossCarryforwardView, LossCarryforwardWarning } from '@/lib/bokslut/loss-carryforward/register'
import type { LossCarryforwardProposal } from '@/lib/bokslut/loss-carryforward/proposal'

type Source = LossCarryforwardSource
type Warning = LossCarryforwardWarning
/** A year as the register answers it; a dry run of a new year has no id yet. */
type LossYear = Omit<LossCarryforwardView, 'tax_loss_carryforward_id'> & { tax_loss_carryforward_id: string | null }
type Proposal = Omit<LossCarryforwardProposal, 'existing'> & { existing: LossYear | null }

interface FormState {
  broughtForward: string
  source: Source
  noticeId: string | null
  result: string
  groupContributions: string
  hasChange: boolean
  changeDate: string
  amountBlock: boolean
  acquisitionCost: string
  capitalContributions: string
  groupBlock: boolean
  groupBlockLastYear: string
  manualReductions: boolean
  amountBlockReduction: string
  groupBlockReduction: string
  note: string
}

const amountText = (n: number | null | undefined): string => (n === null || n === undefined ? '' : formatAmountInput(n))

function formFrom(proposal: Proposal): FormState {
  const row = proposal.existing
  if (row) {
    const change = row.ownership_change
    return {
      broughtForward: amountText(row.brought_forward),
      source: row.source,
      noticeId: row.tax_assessment_notice_id,
      result: amountText(row.result_before_deficit),
      groupContributions: row.group_contributions_received ? amountText(row.group_contributions_received) : '',
      hasChange: Boolean(change),
      changeDate: change?.date ?? '',
      amountBlock: Boolean(change?.amount_block),
      acquisitionCost: amountText(change?.acquisition_cost ?? null),
      capitalContributions: change?.capital_contributions ? amountText(change.capital_contributions) : '',
      groupBlock: Boolean(change?.group_block),
      groupBlockLastYear: change?.group_block_last_year ? String(change.group_block_last_year) : '',
      manualReductions: row.amount_block_manual || row.group_block_manual,
      amountBlockReduction: row.amount_block_manual ? amountText(row.amount_block_reduction) : '',
      groupBlockReduction: row.group_block_manual ? amountText(row.group_block_reduction) : '',
      note: row.note ?? '',
    }
  }
  // A new year starts from the register's own roll-forward when the year
  // before carries a deficit; it is saved only when the user saves.
  const rolled = proposal.candidates.find((c) => c.source === 'computed' && c.amount !== null)
  return {
    broughtForward: rolled ? amountText(rolled.amount) : '',
    source: rolled ? 'computed' : 'manual',
    noticeId: null,
    result: '',
    groupContributions: '',
    hasChange: false,
    changeDate: '',
    amountBlock: false,
    acquisitionCost: '',
    capitalContributions: '',
    groupBlock: false,
    groupBlockLastYear: '',
    manualReductions: false,
    amountBlockReduction: '',
    groupBlockReduction: '',
    note: '',
  }
}

/** An optional amount: '' is null, anything else must parse. */
function optionalAmount(text: string): number | null | undefined {
  if (text.trim() === '') return null
  const n = parseAmountInput(text)
  return n === null ? undefined : n
}

/** The body the save route takes, or null when an amount does not parse. */
function toBody(periodId: string, form: FormState, documentId: string | null): Record<string, unknown> | null {
  const broughtForward = optionalAmount(form.broughtForward)
  const result = optionalAmount(form.result)
  const groupContributions = optionalAmount(form.groupContributions)
  const acquisitionCost = optionalAmount(form.acquisitionCost)
  const contributions = optionalAmount(form.capitalContributions)
  const amountBlockReduction = optionalAmount(form.amountBlockReduction)
  const groupBlockReduction = optionalAmount(form.groupBlockReduction)
  const parsed = [broughtForward, result, groupContributions, acquisitionCost, contributions, amountBlockReduction, groupBlockReduction]
  if (parsed.some((v) => v === undefined)) return null
  const lastYear = form.groupBlockLastYear.trim() === '' ? null : Number.parseInt(form.groupBlockLastYear, 10)
  return {
    fiscal_period_id: periodId,
    brought_forward: broughtForward ?? 0,
    source: form.source,
    result_before_deficit: result,
    group_contributions_received: groupContributions ?? 0,
    amount_block_reduction: form.manualReductions ? amountBlockReduction ?? 0 : null,
    group_block_reduction: form.manualReductions ? groupBlockReduction ?? 0 : null,
    ownership_change: form.hasChange
      ? {
          date: form.changeDate,
          amount_block: form.amountBlock,
          acquisition_cost: form.amountBlock ? acquisitionCost : null,
          capital_contributions: form.amountBlock ? contributions ?? 0 : 0,
          group_block: form.groupBlock,
          group_block_last_year: form.groupBlock && Number.isInteger(lastYear) ? lastYear : null,
        }
      : null,
    note: form.note.trim() || null,
    document_id: documentId,
    tax_assessment_notice_id: form.noticeId,
  }
}

/**
 * Under the tax adjustments in the year-end step: what the register gives
 * 4.14 a, and whether the figure there overrides it. Renders nothing while
 * the register is not switched on (the snapshot then has no lossRegister).
 */
export function LossRegisterDeficitHint({ register }: { register?: TaxAdjustmentLossRegister }) {
  const t = useTranslations('bolagetLosses')
  if (!register?.row) return null
  const amount = formatCurrency(register.row.deductible)
  return (
    <p className="text-xs text-muted-foreground">
      {register.overridden
        ? t('overridden', { amount })
        : t('from_register', { source: t(`source_${register.row.source}`), amount })}
    </p>
  )
}

/**
 * The underskottsregister (IL 40 kap.) in the year-end step, beside the tax
 * adjustments: every year in the register, and the year being closed to
 * fill in from what the app already knows (the previous year's roll-forward,
 * its INK2, its slutskattebesked) and save. Nothing is written until the
 * user saves; saving refreshes the tax adjustments, which then prefill
 * 4.14 a from the register.
 */
export function LossCarryforwardRegister({ periodId, onSaved }: { periodId: string; onSaved: () => void }) {
  const t = useTranslations('bolagetLosses')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [years, setYears] = useState<LossYear[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [preview, setPreview] = useState<LossYear | null>(null)
  const [busy, setBusy] = useState<'calculate' | 'save' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [listRes, proposalRes] = await Promise.all([
        fetch('/api/bookkeeping/tax-loss-carryforwards'),
        fetch(`/api/bookkeeping/tax-loss-carryforwards/proposal?fiscal_period_id=${encodeURIComponent(periodId)}`),
      ])
      const [listBody, proposalBody] = await Promise.all([listRes.json(), proposalRes.json()])
      if (!listRes.ok || !proposalRes.ok) {
        const failed = (listRes.ok ? proposalBody : listBody)?.error
        setLoadError(failed ? getErrorMessage(failed, { locale }) : t('load_failed'))
        return
      }
      const next = proposalBody.data as Proposal
      setYears(listBody.data.tax_loss_carryforwards as LossYear[])
      setProposal(next)
      setForm(formFrom(next))
      setPreview(null)
    } catch {
      setLoadError(t('load_failed'))
    } finally {
      setLoading(false)
    }
  }, [periodId, locale, t])

  useEffect(() => {
    void load()
  }, [load])

  const submit = useCallback(
    async (dryRun: boolean) => {
      if (!form) return
      const body = toBody(periodId, form, proposal?.existing?.document_id ?? null)
      if (!body) {
        setFormError(t('invalid_amount'))
        return
      }
      setBusy(dryRun ? 'calculate' : 'save')
      setFormError(null)
      try {
        const res = await fetch(`/api/bookkeeping/tax-loss-carryforwards${dryRun ? '?dry_run=true' : ''}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) {
          setFormError(json?.error ? getErrorMessage(json.error, { locale }) : t('save_failed'))
          return
        }
        if (dryRun) {
          setPreview(json.data as LossYear)
          return
        }
        toast({ title: t('saved') })
        await load()
        onSaved()
      } catch {
        setFormError(t('save_failed'))
      } finally {
        setBusy(null)
      }
    },
    [form, periodId, proposal, locale, t, toast, load, onSaved],
  )

  const update = (patch: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev))
    setPreview(null)
  }
  const warningText = (w: Warning) => {
    const message = locale === 'en' ? w.message_en : w.message_sv
    return w.amount === undefined ? message : `${message} (${formatCurrency(w.amount)})`
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (loadError || !proposal || !form) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-destructive">{loadError ?? t('load_failed')}</p>
        </CardContent>
      </Card>
    )
  }

  const shown = preview ?? proposal.existing
  const yearWarnings = years.flatMap((y) => y.warnings.map((w) => ({ year: y.fiscal_period.name, text: warningText(w) })))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <InfoTooltip content={t('help')} variant="help" />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {years.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col_year')}</TableHead>
                  <TableHead className="text-right">{t('col_brought_forward')}</TableHead>
                  <TableHead className="text-right">{t('col_blocked')}</TableHead>
                  <TableHead className="text-right">{t('col_result')}</TableHead>
                  <TableHead className="text-right">{t('col_carried_forward')}</TableHead>
                  <TableHead>{t('col_source')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {years.map((y) => (
                  <TableRow key={y.fiscal_period_id}>
                    <TableCell className="tabular-nums">{y.fiscal_period.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(y.brought_forward)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(y.amount_block_reduction + y.group_block_reduction)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {y.result_before_deficit === null ? (
                        <span className="text-muted-foreground">{t('not_entered')}</span>
                      ) : (
                        formatCurrency(y.result_before_deficit)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {y.carried_forward === null ? (
                        <span className="text-muted-foreground">{t('not_entered')}</span>
                      ) : (
                        formatCurrency(y.carried_forward)
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t(`source_${y.source}`)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {yearWarnings.length > 0 && (
          <div role="status" className="space-y-1">
            {yearWarnings.map((w) => (
              <p key={`${w.year}:${w.text}`} className="text-[12.5px] text-attn">
                {w.year}: {w.text}
              </p>
            ))}
          </div>
        )}

        <div className="space-y-4 border-t border-border pt-6">
          <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t('year_heading', { name: proposal.fiscal_period.name })}
          </h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="loss-brought-forward">{t('field_brought_forward')}</Label>
              <Input
                id="loss-brought-forward"
                inputMode="decimal"
                value={form.broughtForward}
                disabled={!canWrite}
                onChange={(e) =>
                  update({ broughtForward: e.target.value, source: form.source === 'tax_assessment' ? 'tax_assessment' : 'manual' })
                }
              />
              <p className="text-xs text-muted-foreground">{t(`source_${form.source}`)}</p>
              {proposal.candidates.map((c) =>
                c.source === 'tax_assessment' ? (
                  <Button
                    key={`${c.source}:${c.tax_assessment_notice_id}`}
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto whitespace-normal p-0 text-left"
                    disabled={!canWrite}
                    onClick={() => update({ source: 'tax_assessment', noticeId: c.tax_assessment_notice_id ?? null })}
                  >
                    {t('use_tax_assessment', { year: c.fiscal_period_name, date: formatDate(c.decision_date ?? '') })}
                  </Button>
                ) : (
                  <Button
                    key={c.source}
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto whitespace-normal p-0 text-left"
                    disabled={!canWrite || c.amount === null}
                    onClick={() => update({ broughtForward: amountText(c.amount), source: c.source, noticeId: null })}
                  >
                    {t(c.source === 'computed' ? 'use_computed' : 'use_ink2_history', {
                      amount: formatCurrency(c.amount ?? 0),
                      year: c.fiscal_period_name,
                    })}
                  </Button>
                ),
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="loss-result">{t('field_result')}</Label>
              <Input
                id="loss-result"
                inputMode="decimal"
                value={form.result}
                disabled={!canWrite}
                onChange={(e) => update({ result: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('field_result_hint')}</p>
              {proposal.result_before_deficit !== null && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  disabled={!canWrite}
                  onClick={() => update({ result: amountText(proposal.result_before_deficit) })}
                >
                  {t('fetch_result')} ({formatCurrency(proposal.result_before_deficit)})
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="loss-ownership-change"
                checked={form.hasChange}
                disabled={!canWrite}
                onCheckedChange={(checked) => update({ hasChange: Boolean(checked) })}
              />
              <Label htmlFor="loss-ownership-change" className="cursor-pointer">
                {t('ownership_change')}
              </Label>
              <InfoTooltip content={t('ownership_change_help')} variant="help" />
            </div>

            {form.hasChange && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="loss-change-date">{t('field_change_date')}</Label>
                  <Input
                    id="loss-change-date"
                    type="date"
                    value={form.changeDate}
                    disabled={!canWrite}
                    onChange={(e) => update({ changeDate: e.target.value })}
                  />
                </div>
                <div className="space-y-3 sm:pt-8">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="loss-amount-block"
                      checked={form.amountBlock}
                      disabled={!canWrite}
                      onCheckedChange={(checked) => update({ amountBlock: Boolean(checked) })}
                    />
                    <Label htmlFor="loss-amount-block" className="cursor-pointer">{t('amount_block')}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="loss-group-block"
                      checked={form.groupBlock}
                      disabled={!canWrite}
                      onCheckedChange={(checked) => update({ groupBlock: Boolean(checked) })}
                    />
                    <Label htmlFor="loss-group-block" className="cursor-pointer">{t('group_block')}</Label>
                  </div>
                </div>
                {form.amountBlock && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="loss-acquisition-cost">{t('field_acquisition_cost')}</Label>
                      <Input
                        id="loss-acquisition-cost"
                        inputMode="decimal"
                        value={form.acquisitionCost}
                        disabled={!canWrite}
                        onChange={(e) => update({ acquisitionCost: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="loss-capital-contributions">{t('field_capital_contributions')}</Label>
                      <Input
                        id="loss-capital-contributions"
                        inputMode="decimal"
                        value={form.capitalContributions}
                        disabled={!canWrite}
                        onChange={(e) => update({ capitalContributions: e.target.value })}
                      />
                    </div>
                  </>
                )}
                {form.groupBlock && (
                  <div className="space-y-2">
                    <Label htmlFor="loss-group-block-last-year">{t('field_group_block_last_year')}</Label>
                    <Input
                      id="loss-group-block-last-year"
                      inputMode="numeric"
                      placeholder={String(Number.parseInt(proposal.fiscal_period.name, 10) + 5 || '')}
                      value={form.groupBlockLastYear}
                      disabled={!canWrite}
                      onChange={(e) => update({ groupBlockLastYear: e.target.value })}
                    />
                  </div>
                )}
              </div>
            )}

            {(form.groupBlock || proposal.existing?.group_block_active) && (
              <div className="space-y-2 sm:w-1/2 sm:pr-2">
                <Label htmlFor="loss-group-contributions">{t('field_group_contributions')}</Label>
                <Input
                  id="loss-group-contributions"
                  inputMode="decimal"
                  value={form.groupContributions}
                  disabled={!canWrite}
                  onChange={(e) => update({ groupContributions: e.target.value })}
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <Checkbox
                id="loss-manual-reductions"
                checked={form.manualReductions}
                disabled={!canWrite}
                onCheckedChange={(checked) => update({ manualReductions: Boolean(checked) })}
              />
              <Label htmlFor="loss-manual-reductions" className="cursor-pointer">{t('manual_reductions')}</Label>
            </div>
            {form.manualReductions && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="loss-amount-block-reduction">{t('field_amount_block_reduction')}</Label>
                  <Input
                    id="loss-amount-block-reduction"
                    inputMode="decimal"
                    value={form.amountBlockReduction}
                    disabled={!canWrite}
                    onChange={(e) => update({ amountBlockReduction: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="loss-group-block-reduction">{t('field_group_block_reduction')}</Label>
                  <Input
                    id="loss-group-block-reduction"
                    inputMode="decimal"
                    value={form.groupBlockReduction}
                    disabled={!canWrite}
                    onChange={(e) => update({ groupBlockReduction: e.target.value })}
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="loss-note">{t('field_note')}</Label>
              <Input
                id="loss-note"
                value={form.note}
                maxLength={2000}
                disabled={!canWrite}
                onChange={(e) => update({ note: e.target.value })}
              />
            </div>
          </div>

          {shown && (
            <div className="rounded-lg bg-muted/50 p-4 text-sm space-y-1">
              {shown.ownership_change?.amount_block_limit != null && (
                <ResultRow label={t('result_limit')} amount={shown.ownership_change.amount_block_limit} />
              )}
              <ResultRow label={t('result_amount_block')} amount={shown.amount_block_reduction} />
              <ResultRow label={t('result_group_block')} amount={shown.group_block_reduction} />
              <ResultRow label={t('result_deductible')} amount={shown.deductible} strong />
              <ResultRow label={t('result_carried_forward')} amount={shown.carried_forward} strong />
              {preview?.warnings.map((w) => (
                <p key={w.code} className="pt-1 text-[12.5px] text-attn">{warningText(w)}</p>
              ))}
            </div>
          )}

          {formError && <p className="text-sm text-destructive">{formError}</p>}
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void submit(true)} loading={busy === 'calculate'} disabled={busy !== null}>
                {t('calculate')}
              </Button>
              <Button type="button" onClick={() => void submit(false)} loading={busy === 'save'} disabled={busy !== null}>
                {t('save')}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ResultRow({ label, amount, strong = false }: { label: string; amount: number | null; strong?: boolean }) {
  const t = useTranslations('bolagetLosses')
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-medium' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{amount === null ? t('not_entered') : formatCurrency(amount)}</span>
    </div>
  )
}
