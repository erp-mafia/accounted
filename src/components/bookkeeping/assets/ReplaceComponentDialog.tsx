'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { parseAmountInput, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import type { AssetComponent } from '@/types'
import { VoucherDialogError, VoucherDialogFooter, VoucherLinesTable, type PreviewVoucherLine } from './VoucherLinesTable'

interface ReplacementPreview {
  component_name: string
  cost: number
  depreciation_to_date: number
  accumulated_depreciation_cleared: number
  carrying_amount_loss: number
  lines: PreviewVoucherLine[]
}

interface ReplaceComponentDialogProps {
  assetId: string
  component: AssetComponent
  open: boolean
  onOpenChange: (open: boolean) => void
  onReplaced: () => void
}

/**
 * Replace a component (K3 17.5, 17.21A): the voucher that takes the old
 * component's carrying amount off the books is shown before it is posted,
 * and the replacing component is registered with it. The replacing
 * expenditure itself is booked as usual (a supplier invoice or bank row on
 * the asset account).
 */
export function ReplaceComponentDialog({ assetId, component, open, onOpenChange, onReplaced }: ReplaceComponentDialogProps) {
  const t = useTranslations('assets.replace')
  const { toast } = useToast()
  const { periods } = useFiscalPeriods()
  const [date, setDate] = useState(() => todayIsoStockholm())
  const [withNew, setWithNew] = useState(true)
  const [name, setName] = useState(component.name)
  const [cost, setCost] = useState('')
  const [lifeMonths, setLifeMonths] = useState(component.useful_life_months === null ? '' : String(component.useful_life_months))
  const [preview, setPreview] = useState<ReplacementPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const period = useMemo(
    () => periods.find((candidate) => date >= candidate.period_start && date <= candidate.period_end) ?? null,
    [periods, date],
  )

  // Any change makes the shown voucher stale.
  useEffect(() => {
    setPreview(null)
  }, [date, withNew, name, cost, lifeMonths])

  const body = () => {
    const newCost = parseAmountInput(cost) ?? Number.NaN
    const months = Number(lifeMonths)
    if (!period) return { error: t('error_period') }
    if (withNew && (!name.trim() || !Number.isFinite(newCost) || newCost <= 0)) return { error: t('error_new') }
    if (withNew && lifeMonths.trim() !== '' && (!Number.isInteger(months) || months <= 0)) return { error: t('error_new') }
    return {
      body: {
        replaced_at: date,
        fiscal_period_id: period.id,
        new_component: withNew
          ? { name: name.trim(), cost: roundOre(newCost), useful_life_months: lifeMonths.trim() === '' ? null : months }
          : null,
      },
    }
  }

  const call = async (dryRun: boolean) => {
    setError(null)
    const built = body()
    if ('error' in built) {
      setError(built.error ?? null)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/assets/${assetId}/components/${component.id}/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...built.body, dry_run: dryRun }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(json?.error ?? json))
        return
      }
      if (dryRun) {
        setPreview(json.data as ReplacementPreview)
        return
      }
      toast({ title: t('success_title'), description: component.name })
      onReplaced()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title', { name: component.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-[12.5px] text-muted-foreground">{t('hint')}</p>
          <div className="space-y-1.5">
            <Label htmlFor="replace-date">{t('date')}</Label>
            <Input id="replace-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="tabular-nums" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={withNew} onCheckedChange={(checked) => setWithNew(checked === true)} />
            {t('with_new')}
          </label>
          {withNew && (
            <div className="grid grid-cols-6 gap-2">
              <div className="col-span-6 space-y-1 sm:col-span-3">
                <Label htmlFor="replace-name" className="text-xs text-muted-foreground">{t('new_name')}</Label>
                <Input id="replace-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="col-span-3 space-y-1 sm:col-span-2">
                <Label htmlFor="replace-cost" className="text-xs text-muted-foreground">{t('new_cost')}</Label>
                <Input id="replace-cost" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className="tabular-nums" />
              </div>
              <div className="col-span-3 space-y-1 sm:col-span-1">
                <Label htmlFor="replace-life" className="text-xs text-muted-foreground">{t('new_life')}</Label>
                <Input id="replace-life" type="number" min="1" step="1" value={lifeMonths} onChange={(e) => setLifeMonths(e.target.value)} className="tabular-nums" />
              </div>
              <p className="col-span-6 text-xs text-muted-foreground">{t('new_hint')}</p>
            </div>
          )}

          {preview && (
            <div className="space-y-2">
              <p className="text-sm">
                {t('preview_summary', {
                  toDate: formatCurrency(preview.depreciation_to_date),
                  cleared: formatCurrency(preview.accumulated_depreciation_cleared),
                  loss: formatCurrency(preview.carrying_amount_loss),
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
