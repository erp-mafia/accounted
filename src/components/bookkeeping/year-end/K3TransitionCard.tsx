'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlusIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { parseAmountInput, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { K3_RELIEF_RULES, type K3ReliefRule } from '@/lib/bokslut/k3-transition/transition'
import type {
  K3TransitionPreview,
  K3TransitionState,
  K3TransitionYear,
} from '@/lib/bokslut/k3-transition/transition-service'
import type { TransitionSplitCandidate } from '@/lib/bokslut/assets/transition-split-service'
import { VoucherLinesTable } from '@/components/bookkeeping/assets/VoucherLinesTable'
import { manualDifferencesOf, ManualDifferencesEditor, type ManualDraft } from './ManualDifferencesEditor'
import { TransitionSplitDialog } from './TransitionSplitDialog'

type State = K3TransitionState & { year: K3TransitionYear | null }

interface AdjustmentDraft {
  key: number
  account: string
  amount: string
  description: string
}

let adjustmentKey = 0
function adjustmentDraft(): AdjustmentDraft {
  adjustmentKey += 1
  return { key: adjustmentKey, account: '', amount: '', description: '' }
}

/**
 * The transition to K3 in the first K3 year (BFNAR 2012:1 kap. 35): the
 * component split of the fixed assets (35.18), the opening deferred tax or
 * the 35.27 relief, other adjustments against equity (35.11), and the facts
 * the transition notes state (35.31, 35.33). Posting is confirmed up front.
 */
export function K3TransitionCard({ periodId }: { periodId: string }) {
  const t = useTranslations('k3_transition')
  const { toast } = useToast()
  const [state, setState] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [splitting, setSplitting] = useState<TransitionSplitCandidate | null>(null)
  const [lossDeficit, setLossDeficit] = useState('')
  const [lossReason, setLossReason] = useState('')
  const [manual, setManual] = useState<ManualDraft[]>([])
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>([])
  const [reliefRules, setReliefRules] = useState<K3ReliefRule[]>([])
  const [principles, setPrinciples] = useState('')
  const [preview, setPreview] = useState<K3TransitionPreview | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/bookkeeping/k3-transition?fiscal_period_id=${periodId}`)
      const body = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(body?.error) || t('load_failed'))
        return
      }
      const data = body.data as State
      setState(data)
      setReliefRules(data.transition?.relief_rules ?? [])
      setPrinciples(data.transition?.changed_principles ?? '')
    } catch (err) {
      setError(getErrorMessage(err) || t('load_failed'))
    } finally {
      setLoading(false)
    }
  }, [periodId, t])

  useEffect(() => {
    void load()
  }, [load])

  const call = async (path: string, method: string, body?: unknown): Promise<unknown | null> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(json?.error) || t('save_failed'))
        return null
      }
      return json.data
    } catch (err) {
      setError(getErrorMessage(err) || t('save_failed'))
      return null
    } finally {
      setBusy(false)
    }
  }

  /** The posting request, or null (with the error shown) when a row is incomplete. */
  const postingInput = () => {
    const items = manualDifferencesOf(manual)
    const deficit = lossDeficit.trim() ? parseAmountInput(lossDeficit) : null
    const rows = adjustments.map((row) => ({
      account_number: row.account.trim(),
      amount: parseAmountInput(row.amount),
      description: row.description.trim(),
    }))
    if (
      !items ||
      (lossDeficit.trim() && (deficit === null || !lossReason.trim())) ||
      rows.some((row) => !ACCOUNT_NUMBER_RE.test(row.account_number) || row.amount === null || !row.description)
    ) {
      setError(t('error_input'))
      return null
    }
    return {
      adjustments: rows.map((row) => ({ ...row, amount: roundOre(row.amount ?? 0) })),
      loss_carryforward: deficit !== null && deficit > 0 ? { deficit: roundOre(deficit), reason: lossReason.trim() } : null,
      manual_items: items,
    }
  }

  if (loading) return <Skeleton className="h-24 w-full" />
  if (!state?.year || state.year.framework !== 'k3') return null

  const transition = state.transition
  if (state.committed) {
    return transition?.fiscal_period_id === periodId ? (
      <p className="px-1 text-xs text-muted-foreground">{t('committed')}</p>
    ) : null
  }
  if (transition && transition.fiscal_period_id !== periodId) {
    return <p className="px-1 text-xs text-muted-foreground">{t('started_other', { name: state.period?.name ?? '' })}</p>
  }

  const header = (
    <CardHeader>
      <div className="flex items-center gap-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <HelpPopover>{t('help')}</HelpPopover>
      </div>
    </CardHeader>
  )

  if (!transition) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            size="sm"
            variant="outline"
            disabled={!state.year.open}
            loading={busy}
            onClick={async () => {
              if (await call('/api/bookkeeping/k3-transition', 'POST', { fiscal_period_id: periodId })) await load()
            }}
          >
            {t('start')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const statusText = (asset: TransitionSplitCandidate) =>
    asset.status === 'split'
      ? t('status_split', { count: asset.components.length })
      : asset.status === 'components'
        ? t('status_components')
        : asset.status === 'later_depreciation_posted'
          ? t('status_later')
          : t('status_plain')

  const updateAdjustment = (key: number, patch: Partial<AdjustmentDraft>) =>
    setAdjustments((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  return (
    <Card>
      {header}
      <CardContent className="space-y-8">
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{t('assets_title')}</p>
            <HelpPopover>{t('assets_help')}</HelpPopover>
          </div>
          {state.assets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('assets_none')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('th_asset')}</TableHead>
                  <TableHead className="text-right">{t('th_carrying')}</TableHead>
                  <TableHead>{t('th_status')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.assets.map((asset) => (
                  <TableRow key={asset.asset_id}>
                    <TableCell>{asset.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(asset.carrying_amount)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{statusText(asset)}</TableCell>
                    <TableCell className="text-right">
                      {(asset.status === 'plain' || asset.status === 'split') && (
                        <Button size="sm" variant="ghost" onClick={() => setSplitting(asset)}>
                          {asset.status === 'split' ? t('edit_split') : t('split')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="space-y-3">
          <p className="text-sm font-medium">{t('deferred_title')}</p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={transition.deferred_tax_relief}
              disabled={busy}
              onCheckedChange={async (checked) => {
                if (await call('/api/bookkeeping/k3-transition', 'PATCH', { deferred_tax_relief: checked === true })) {
                  setPreview(null)
                  await load()
                }
              }}
            />
            {t('relief_label')}
            <HelpPopover>{t('relief_help')}</HelpPopover>
          </label>
          {!transition.deferred_tax_relief && (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="k3t-loss" className="text-xs text-muted-foreground">{t('loss_amount')}</Label>
                  <Input
                    id="k3t-loss"
                    type="number"
                    step="0.01"
                    value={lossDeficit}
                    onChange={(e) => setLossDeficit(e.target.value)}
                    className="tabular-nums"
                  />
                </div>
                {lossDeficit.trim() && (
                  <div className="space-y-1">
                    <Label htmlFor="k3t-loss-reason" className="text-xs text-muted-foreground">{t('loss_reason')}</Label>
                    <Textarea id="k3t-loss-reason" rows={2} value={lossReason} onChange={(e) => setLossReason(e.target.value)} />
                  </div>
                )}
              </div>
              <ManualDifferencesEditor rows={manual} onChange={setManual} idPrefix="k3t" />
            </>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{t('adjustments_title')}</p>
            <HelpPopover>{t('adjustments_help')}</HelpPopover>
          </div>
          {adjustments.map((row) => (
            <div key={row.key} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-4 space-y-1 sm:col-span-2">
                <Label htmlFor={`k3t-account-${row.key}`} className="text-xs text-muted-foreground">{t('adjustment_account')}</Label>
                <Input
                  id={`k3t-account-${row.key}`}
                  inputMode="numeric"
                  value={row.account}
                  onChange={(e) => updateAdjustment(row.key, { account: e.target.value })}
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-7 space-y-1 sm:col-span-3">
                <Label htmlFor={`k3t-amount-${row.key}`} className="text-xs text-muted-foreground">{t('adjustment_amount')}</Label>
                <Input
                  id={`k3t-amount-${row.key}`}
                  type="number"
                  step="0.01"
                  value={row.amount}
                  onChange={(e) => updateAdjustment(row.key, { amount: e.target.value })}
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-12 space-y-1 sm:col-span-6">
                <Label htmlFor={`k3t-description-${row.key}`} className="text-xs text-muted-foreground">
                  {t('adjustment_description')}
                </Label>
                <Input
                  id={`k3t-description-${row.key}`}
                  value={row.description}
                  onChange={(e) => updateAdjustment(row.key, { description: e.target.value })}
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setAdjustments((rows) => rows.filter((candidate) => candidate.key !== row.key))}
                  aria-label={t('adjustment_remove', { account: row.account || '' })}
                >
                  <XMarkIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setAdjustments((rows) => [...rows, adjustmentDraft()])}>
            <PlusIcon className="mr-1 h-4 w-4" /> {t('adjustment_add')}
          </Button>
        </section>

        <section className="space-y-3">
          <p className="text-sm font-medium">{t('notes_title')}</p>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('relief_rules')}</p>
            {K3_RELIEF_RULES.map((rule) => (
              <label key={rule.code} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={reliefRules.includes(rule.code)}
                  onCheckedChange={(checked) =>
                    setReliefRules((current) =>
                      checked === true ? [...current, rule.code] : current.filter((code) => code !== rule.code),
                    )
                  }
                />
                <span>{rule.label}</span>
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="k3t-principles" className="text-xs text-muted-foreground">{t('principles')}</Label>
            <Textarea
              id="k3t-principles"
              rows={3}
              value={principles}
              placeholder={t('principles_placeholder')}
              onChange={(e) => setPrinciples(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={async () => {
              const saved = await call('/api/bookkeeping/k3-transition', 'PATCH', {
                relief_rules: reliefRules,
                changed_principles: principles,
              })
              if (saved) toast({ title: t('notes_saved') })
            }}
          >
            {t('save_notes')}
          </Button>
        </section>

        {preview && (
          <section className="space-y-2">
            {preview.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('no_lines')}</p>
            ) : (
              <VoucherLinesTable
                t={t}
                lines={preview.lines.map((line) => ({
                  account_number: line.account_number,
                  debit: Number(line.debit_amount) || 0,
                  credit: Number(line.credit_amount) || 0,
                  description: line.line_description ?? null,
                }))}
              />
            )}
            {preview.warnings.map((warning) => (
              <p key={warning} className="text-[12.5px] text-muted-foreground">
                {warning}
              </p>
            ))}
          </section>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || state.assets.some((asset) => asset.status === 'split')}
            onClick={async () => {
              if (await call('/api/bookkeeping/k3-transition', 'DELETE')) await load()
            }}
          >
            {t('delete')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={async () => {
              const input = postingInput()
              if (!input) return
              const data = await call('/api/bookkeeping/k3-transition/preview', 'POST', input)
              if (data) setPreview(data as K3TransitionPreview)
            }}
          >
            {t('preview')}
          </Button>
          <Button size="sm" disabled={!preview || busy} onClick={() => setConfirming(true)}>
            {t('commit')}
          </Button>
        </div>
      </CardContent>

      {splitting && (
        <TransitionSplitDialog
          asset={splitting}
          open={splitting !== null}
          onOpenChange={(open) => !open && setSplitting(null)}
          onSaved={() => {
            setPreview(null)
            void load()
          }}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirm_title')}
        description={
          preview && preview.lines.length > 0
            ? t('confirm_body', { date: preview.transition_date, account: preview.equity_account })
            : t('confirm_body_empty')
        }
        confirmLabel={t('commit')}
        cancelLabel={t('cancel')}
        onConfirm={async () => {
          const input = postingInput()
          if (!input) return
          const data = await call('/api/bookkeeping/k3-transition/commit', 'POST', input)
          setConfirming(false)
          if (data) {
            toast({ title: t('committed_toast') })
            setPreview(null)
            await load()
          }
        }}
      />
    </Card>
  )
}
