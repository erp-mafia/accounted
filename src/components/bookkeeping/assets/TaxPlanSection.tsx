'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { parseAmountInput } from '@/lib/money'
import { formatDate } from '@/lib/utils'
import type { Asset } from '@/types'

/**
 * The tax depreciation plan of a building or markanläggning (IL 19 kap.
 * 5-5 a §§, 20 kap. 5 §): its own save, since it is no part of the book
 * basis. It drives INK2S 4.9 and the K3 deferred tax.
 */
export function TaxPlanSection({
  asset,
  disabled,
  onSaved,
}: {
  asset: Pick<
    Asset,
    'id' | 'category' | 'acquisition_date' | 'tax_depreciation_rate' | 'tax_depreciation_from' | 'tax_primary_allowance' | 'tax_plan_applies_from'
  >
  disabled?: boolean
  onSaved: () => void
}) {
  const t = useTranslations('assets.tax_plan')
  const { toast } = useToast()
  const storedRate = asset.tax_depreciation_rate === null || asset.tax_depreciation_rate === undefined
    ? ''
    : String(Number(asset.tax_depreciation_rate))
  const [rate, setRate] = useState(storedRate)
  const [from, setFrom] = useState(asset.tax_depreciation_from ?? '')
  const [primary, setPrimary] = useState(asset.tax_primary_allowance === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const building = asset.category === 'building'

  const save = async () => {
    setError(null)
    const parsed = rate.trim() === '' ? null : parseAmountInput(rate)
    if (rate.trim() !== '' && (parsed === null || parsed <= 0 || parsed > 100)) {
      setError(t('error_rate'))
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/assets/${asset.id}/tax-plan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tax_depreciation_rate: parsed,
          tax_depreciation_from: from || null,
          ...(building ? { tax_primary_allowance: primary } : {}),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(body?.error ?? body))
        return
      }
      toast({ title: t('saved') })
      onSaved()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg p-4 bg-control shadow-raised">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{t('title')}</p>
        <HelpPopover>{building ? t('help_building') : t('help_land_improvement')}</HelpPopover>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="tax-plan-rate">{t('rate')}</Label>
          <Input
            id="tax-plan-rate"
            type="number"
            min="0"
            step="0.1"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            disabled={disabled}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tax-plan-from">{t('from')}</Label>
          <Input
            id="tax-plan-from"
            type="date"
            min={asset.acquisition_date}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={disabled}
            className="tabular-nums"
          />
        </div>
      </div>
      {building && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={primary} onCheckedChange={(checked) => setPrimary(checked === true)} disabled={disabled} />
          {t('primary')}
        </label>
      )}
      {asset.tax_plan_applies_from && (
        <p className="text-xs text-muted-foreground">{t('applies_from', { date: formatDate(asset.tax_plan_applies_from) })}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={() => void save()} loading={saving} disabled={disabled}>
          {t('save')}
        </Button>
      </div>
    </div>
  )
}
