'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { hasEnded, todayIsoStockholm } from '@/lib/dates/iso'
import { parseAmountInput, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import type { Asset } from '@/types'
import { VoucherDialogError, VoucherDialogFooter, VoucherLinesTable, type PreviewVoucherLine } from './VoucherLinesTable'

type Kind = 'impairment' | 'impairment_reversal'

interface AdjustmentPreview {
  amount: number
  carrying_amount_before: number
  carrying_amount_after: number
  lines: PreviewVoucherLine[]
}

interface ImpairAssetDialogProps {
  asset: Pick<Asset, 'id' | 'name'>
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: () => void
}

/**
 * Write an asset down to its recoverable amount on a balansdag, or reverse
 * an earlier write-down (ÅRL 4 kap. 5 §, K3 27). The voucher is shown before
 * it is posted; the amount follows from the register and the recoverable
 * amount the user states, with the assessment kept as the reason.
 */
export function ImpairAssetDialog({ asset, open, onOpenChange, onPosted }: ImpairAssetDialogProps) {
  const t = useTranslations('assets.impairment')
  const { toast } = useToast()
  const { periods } = useFiscalPeriods()
  // Balansdagar of open years, latest first; the default is the latest one
  // already passed (the year being closed), else the current year.
  const openYears = useMemo(
    () =>
      [...periods]
        .filter((period) => !period.is_closed && !period.locked_at)
        .sort((a, b) => b.period_end.localeCompare(a.period_end)),
    [periods],
  )
  const [kind, setKind] = useState<Kind>('impairment')
  const [periodId, setPeriodId] = useState<string>('')
  const [recoverable, setRecoverable] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<AdjustmentPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const today = todayIsoStockholm()
  const selectedPeriodId =
    periodId || (openYears.find((period) => hasEnded(period.period_end, today)) ?? openYears[0])?.id || ''

  // Any change makes the shown voucher stale.
  useEffect(() => {
    setPreview(null)
  }, [kind, selectedPeriodId, recoverable, reason])

  const call = async (dryRun: boolean) => {
    setError(null)
    const amount = parseAmountInput(recoverable) ?? Number.NaN
    if (!selectedPeriodId || !Number.isFinite(amount) || amount < 0 || !reason.trim()) {
      setError(t('error_input'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/assets/${asset.id}/value-adjustments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          fiscal_period_id: selectedPeriodId,
          recoverable_amount: roundOre(amount),
          reason: reason.trim(),
          dry_run: dryRun,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(json?.error ?? json))
        return
      }
      if (dryRun) {
        setPreview(json.data as AdjustmentPreview)
        return
      }
      toast({ title: t('success_title'), description: asset.name })
      onPosted()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{t('dialog_title', { name: asset.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('dialog_hint')}</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="impair-kind">{t('kind_label')}</Label>
              <Select value={kind} onValueChange={(value) => setKind(value as Kind)}>
                <SelectTrigger id="impair-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="impairment">{t('kind_impairment')}</SelectItem>
                  <SelectItem value="impairment_reversal">{t('kind_reversal')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="impair-period">{t('period_label')}</Label>
              <Select value={selectedPeriodId} onValueChange={setPeriodId}>
                <SelectTrigger id="impair-period" className="tabular-nums">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {openYears.map((period) => (
                    <SelectItem key={period.id} value={period.id} className="tabular-nums">
                      {period.period_end}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="impair-recoverable">{t('recoverable_label')}</Label>
              <HelpPopover>{t('recoverable_help')}</HelpPopover>
            </div>
            <Input
              id="impair-recoverable"
              type="number"
              min="0"
              step="0.01"
              value={recoverable}
              onChange={(e) => setRecoverable(e.target.value)}
              className="tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="impair-reason">{t('reason_label')}</Label>
            <Textarea
              id="impair-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reason_placeholder')}
              rows={3}
            />
          </div>

          {preview && (
            <div className="space-y-2">
              <p className="text-sm tabular-nums">
                {t('preview_summary', {
                  before: formatCurrency(preview.carrying_amount_before),
                  after: formatCurrency(preview.carrying_amount_after),
                  amount: formatCurrency(preview.amount),
                })}
              </p>
              <VoucherLinesTable lines={preview.lines} t={t} />
            </div>
          )}

          <VoucherDialogError error={error} />
        </div>
        <VoucherDialogFooter t={t} busy={busy} previewed={preview !== null} onCancel={() => onOpenChange(false)} onRun={(dryRun) => void call(dryRun)} />
      </DialogContent>
    </Dialog>
  )
}
